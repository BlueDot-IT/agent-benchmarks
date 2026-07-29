import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, cp, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import process from "node:process";
import { arch, platform, release } from "node:os";

const benchmarkRoot = resolve(import.meta.dirname, "..");
const DEFAULT_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_PROCESS_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_ASSERTION_FILE_BYTES = 16 * 1024 * 1024;
const MAX_WORKSPACE_DIGEST_BYTES = 128 * 1024 * 1024;
const MAX_WORKSPACE_DIGEST_FILES = 20_000;

function option(args: string[], name: string, fallback = "") {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

function hasFlag(args: string[], name: string) {
  return args.includes(name);
}

function usage() {
  console.log(`Usage:
  pnpm benchmark -- --config <adapters.json> [--suite benchmarks/suites/smoke.json]
    [--adapter <id>] [--trials <count>] [--output <directory>] [--keep-workspaces]
    [--run-unsupported] [--resume-progress <run.progress.ndjson>]

The runner never invokes a shell. Adapter commands and grading commands are
executed as argument arrays inside disposable case workspaces.`);
}

function assertContained(root: string, candidate: string, label: string) {
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} escapes its allowed root: ${candidate}`);
  }
  return candidate;
}

function isMissingError(error: unknown): error is NodeJS.ErrnoException {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function resolveExistingContained(root: string, candidate: string, label: string) {
  const realRoot = await realpath(root);
  const lexical = assertContained(realRoot, resolve(realRoot, candidate), label);
  const target = await realpath(lexical);
  return assertContained(realRoot, target, label);
}

async function containedPathState(root: string, candidate: string, label: string) {
  const realRoot = await realpath(root);
  const lexical = assertContained(realRoot, resolve(realRoot, candidate), label);
  try {
    await lstat(lexical);
  } catch (error) {
    if (!isMissingError(error)) throw error;
    let ancestor = dirname(lexical);
    while (true) {
      try {
        const realAncestor = await realpath(ancestor);
        assertContained(realRoot, realAncestor, label);
        return { exists: false, path: lexical };
      } catch (ancestorError) {
        if (!isMissingError(ancestorError)) throw ancestorError;
        const next = dirname(ancestor);
        if (next === ancestor) throw ancestorError;
        ancestor = next;
      }
    }
  }
  return { exists: true, path: await resolveExistingContained(realRoot, lexical, label) };
}

async function readContainedFile(root: string, candidate: string, label: string) {
  const state = await containedPathState(root, candidate, label);
  if (!state.exists) return null;
  const metadata = await lstat(state.path);
  if (!metadata.isFile()) throw new Error(`${label} is not a regular file: ${candidate}`);
  if (metadata.size > MAX_ASSERTION_FILE_BYTES) {
    throw new Error(`${label} exceeds ${MAX_ASSERTION_FILE_BYTES} bytes: ${candidate}`);
  }
  return readFile(state.path);
}

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

function resolveFrom(base: string, path: string) {
  return isAbsolute(path) ? resolve(path) : resolve(base, path);
}

function replaceTokens(value: string, tokens: Record<string, string>) {
  return value.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (match, key) => {
    if (!(key in tokens)) throw new Error(`unknown adapter placeholder ${match}`);
    return tokens[key];
  });
}

function extractJsonPath(value: any, path: string) {
  return path.split(".").filter(Boolean).reduce((current, key) => current?.[key], value);
}

function stableJsonValue(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableJsonValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJsonValue(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function gitCommit(cwd: string) {
  const result = await runProcess("git", ["rev-parse", "HEAD"], { cwd, timeoutMs: 10_000 });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function gitDirty(cwd: string) {
  const result = await runProcess("git", ["status", "--porcelain"], { cwd, timeoutMs: 10_000 });
  return result.exitCode === 0 ? Boolean(result.stdout.trim()) : null;
}

async function runProcess(command: string, args: string[], options: {
  cwd: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  maxOutputBytes?: number;
}) {
  const started = performance.now();
  const timeoutMs = Number(options.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_PROCESS_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be between 1 and ${MAX_PROCESS_TIMEOUT_MS}`);
  }
  const requestedOutputBytes = Number(options.maxOutputBytes ?? DEFAULT_PROCESS_OUTPUT_BYTES);
  if (!Number.isFinite(requestedOutputBytes) || requestedOutputBytes < 1_024 || requestedOutputBytes > MAX_PROCESS_OUTPUT_BYTES) {
    throw new Error(`maxOutputBytes must be between 1024 and ${MAX_PROCESS_OUTPUT_BYTES}`);
  }
  const maxOutputBytes = Math.floor(requestedOutputBytes);
  return new Promise<any>((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...minimalProcessEnvironment(), ...options.env },
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let outputLimitExceeded = false;
    let capturedBytes = 0;
    const captured = () => ({
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8")
    });
    let settled = false;
    const finish = (result: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        exitCode: null,
        signal: null,
        ...captured(),
        timedOut,
        outputLimitExceeded,
        durationMs: performance.now() - started,
        ...result
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
      finish({ timedOut: true, signal: "SIGKILL" });
    }, Math.floor(timeoutMs));
    const capture = (stream: "stdout" | "stderr", chunk: Buffer) => {
      if (settled) return;
      const bytes = chunk.length;
      const remaining = Math.max(0, maxOutputBytes - capturedBytes);
      const kept = remaining >= bytes ? chunk : chunk.subarray(0, remaining);
      if (stream === "stdout") stdoutChunks.push(kept);
      else stderrChunks.push(kept);
      capturedBytes += Math.min(bytes, remaining);
      if (bytes > remaining) {
        outputLimitExceeded = true;
        terminateProcessTree(child);
        finish({ outputLimitExceeded: true, signal: "SIGKILL" });
      }
    };
    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
    child.on("error", (error) => {
      finish({ error: error.message });
    });
    child.on("close", (exitCode, signal) => {
      terminateProcessTree(child);
      finish({ exitCode, signal });
    });
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

function terminateProcessTree(child: { pid?: number; kill(signal?: NodeJS.Signals | number): boolean }) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).unref();
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}

function minimalProcessEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TERM", "CI", "NO_COLOR"];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}

function normalizeOutput(processResult: any, adapter: any) {
  const format = adapter.output?.format ?? "text";
  if (format === "text") return { text: processResult.stdout, metrics: {} };
  if (format !== "json") throw new Error(`unsupported output format ${format}`);
  const parsed = JSON.parse(processResult.stdout);
  const extracted = adapter.output?.path ? extractJsonPath(parsed, adapter.output.path) : parsed;
  if (extracted === undefined) throw new Error(`adapter output path not found: ${adapter.output?.path ?? "(root)"}`);
  const metrics = Object.fromEntries(Object.entries(adapter.output?.metrics ?? {}).map(([name, path]) => [name, extractJsonPath(parsed, String(path)) ?? null]));
  return {
    text: typeof extracted === "string" ? extracted : JSON.stringify(extracted),
    metrics
  };
}

async function digestDirectory(root: string, {
  excluded = new Set<string>(),
  maxBytes = MAX_WORKSPACE_DIGEST_BYTES,
  maxFiles = MAX_WORKSPACE_DIGEST_FILES
}: {
  excluded?: Set<string>;
  maxBytes?: number;
  maxFiles?: number;
} = {}) {
  const { readdir } = await import("node:fs/promises");
  const hash = createHash("sha256");
  let bytes = 0;
  let files = 0;
  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const name = relative(root, path).split(sep).join("/");
      if (excluded.has(name) || Array.from(excluded).some((prefix) => name.startsWith(`${prefix}/`))) continue;
      files += 1;
      if (files > maxFiles) throw new Error(`workspace digest exceeds ${maxFiles} entries`);
      if (entry.isDirectory()) {
        hash.update(`d:${name}\0`);
        await visit(path);
      } else if (entry.isSymbolicLink()) {
        const target = await readlink(path);
        bytes += Buffer.byteLength(target);
        if (bytes > maxBytes) throw new Error(`workspace digest exceeds ${maxBytes} bytes`);
        hash.update(`l:${name}\0${target}\0`);
      } else if (entry.isFile()) {
        hash.update(`f:${name}\0`);
        for await (const chunk of createReadStream(path)) {
          bytes += chunk.length;
          if (bytes > maxBytes) throw new Error(`workspace digest exceeds ${maxBytes} bytes`);
          hash.update(chunk);
        }
      } else {
        throw new Error(`workspace digest does not support special entry ${name}`);
      }
    }
  }
  await visit(root);
  return hash.digest("hex");
}

async function gradeAssertion(assertion: any, context: any) {
  if (assertion.type === "stdout_equals") {
    const actual = assertion.trim === true ? context.output.trim() : context.output;
    const expected = assertion.trim === true ? String(assertion.expected).trim() : String(assertion.expected);
    return { passed: actual === expected, type: assertion.type, expected, actual };
  }
  if (assertion.type === "stdout_contains") {
    const expected = String(assertion.expected);
    return { passed: context.output.includes(expected), type: assertion.type, expected };
  }
  if (assertion.type === "stdout_json_equals") {
    let actual = null;
    try { actual = JSON.parse(context.output); } catch {}
    const expected = assertion.expected;
    const actualComparable = assertion.orderedKeys === true ? JSON.stringify(actual) : stableJsonValue(actual);
    const expectedComparable = assertion.orderedKeys === true ? JSON.stringify(expected) : stableJsonValue(expected);
    return {
      passed: actual !== null && actualComparable === expectedComparable,
      type: assertion.type,
      expected,
      actual,
      orderedKeys: assertion.orderedKeys === true
    };
  }
  if (assertion.type === "file_exists") {
    const state = await containedPathState(context.workspace, assertion.path, "assertion path");
    return { passed: state.exists, type: assertion.type, path: assertion.path };
  }
  if (assertion.type === "file_absent") {
    const state = await containedPathState(context.workspace, assertion.path, "assertion path");
    return { passed: !state.exists, type: assertion.type, path: assertion.path };
  }
  if (assertion.type === "file_equals") {
    const content = await readContainedFile(context.workspace, assertion.path, "assertion path");
    const actual = content?.toString("utf8") ?? null;
    const expected = String(assertion.expected);
    return { passed: actual === expected, type: assertion.type, path: assertion.path, expected, actual };
  }
  if (assertion.type === "file_json_equals") {
    const content = await readContainedFile(context.workspace, assertion.path, "assertion path");
    let actual = null;
    if (content) {
      try { actual = JSON.parse(content.toString("utf8")); } catch (error) {
        if ((error as SyntaxError)?.name !== "SyntaxError") throw error;
      }
    }
    const expected = assertion.expected;
    return {
      passed: actual !== null && stableJsonValue(actual) === stableJsonValue(expected),
      type: assertion.type,
      path: assertion.path,
      expected,
      actual
    };
  }
  if (assertion.type === "file_contains") {
    const content = await readContainedFile(context.workspace, assertion.path, "assertion path");
    const text = content?.toString("utf8") ?? "";
    return { passed: text.includes(String(assertion.expected)), type: assertion.type, path: assertion.path, expected: assertion.expected };
  }
  if (assertion.type === "file_sha256") {
    const content = await readContainedFile(context.workspace, assertion.path, "assertion path");
    const actual = content ? createHash("sha256").update(content).digest("hex") : null;
    const expected = String(assertion.expected).toLowerCase();
    return { passed: actual === expected, type: assertion.type, path: assertion.path, expected, actual };
  }
  if (assertion.type === "command") {
    if (!assertion.command || !Array.isArray(assertion.args ?? [])) throw new Error("command assertion requires command and args");
    const result = await runProcess(assertion.command, assertion.args ?? [], {
      cwd: context.workspace,
      timeoutMs: Number(assertion.timeoutMs) || 30_000,
      maxOutputBytes: Number(assertion.maxOutputBytes) || DEFAULT_PROCESS_OUTPUT_BYTES
    });
    const expectedExitCode = Number(assertion.exitCode ?? 0);
    return {
      passed: !result.timedOut && !result.outputLimitExceeded && result.exitCode === expectedExitCode,
      type: assertion.type,
      command: assertion.command,
      args: assertion.args ?? [],
      expectedExitCode,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      outputLimitExceeded: result.outputLimitExceeded,
      stdout: result.stdout.slice(0, 4_000),
      stderr: result.stderr.slice(0, 4_000)
    };
  }
  throw new Error(`unsupported assertion type ${assertion.type}`);
}

async function prepareTrial(adapter: any, benchmarkCase: any, caseDirectory: string, trialRoot: string) {
  const workspace = join(trialRoot, "workspace");
  const state = join(trialRoot, "state");
  await mkdir(workspace, { recursive: true });
  await mkdir(state, { recursive: true });
  if (benchmarkCase.fixtureDir) {
    const fixture = await resolveExistingContained(caseDirectory, benchmarkCase.fixtureDir, "fixture");
    await cp(fixture, workspace, { recursive: true });
  }
  if (adapter.stateFixture) {
    const stateFixture = resolveFrom(benchmarkRoot, adapter.stateFixture);
    await rm(state, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    await cp(stateFixture, state, { recursive: true });
  }
  return { workspace, state };
}

async function runTrial(adapter: any, benchmarkCase: any, caseDirectory: string, trialIndex: number, keepWorkspaces: boolean) {
  const trialId = `${benchmarkCase.id}-${adapter.id}-${trialIndex + 1}-${randomUUID().slice(0, 8)}`;
  const trialRoot = await mkdtemp(join(tmpdir(), "agent-bench-"));
  try {
    const { workspace, state } = await prepareTrial(adapter, benchmarkCase, caseDirectory, trialRoot);
    const promptPath = await resolveExistingContained(caseDirectory, benchmarkCase.promptFile, "prompt");
    const prompt = await readFile(promptPath, "utf8");
    const inputFile = join(trialRoot, "input.json");
    const caseTimeoutMs = Number(benchmarkCase.timeoutMs ?? adapter.timeoutMs) || 600_000;
    const modelTimeoutMs = Math.max(1_000, Math.min(300_000, caseTimeoutMs - 5_000));
    await writeFile(inputFile, `${JSON.stringify({
      prompt,
      maxTurns: benchmarkCase.maxTurns ?? 12,
      verifyFinal: benchmarkCase.verifyFinal === true,
      timeoutMs: modelTimeoutMs,
      ...(benchmarkCase.retries === undefined ? {} : { retries: benchmarkCase.retries })
    }, null, 2)}\n`);
    const tokens = { repo: benchmarkRoot, workspace, state, promptFile: promptPath, inputFile, prompt, trialId };
    const command = replaceTokens(adapter.command, tokens);
    const args = (adapter.args ?? []).map((argument: string) => replaceTokens(argument, tokens));
    const env = Object.fromEntries(Object.entries(adapter.env ?? {}).map(([key, value]) => [key, replaceTokens(String(value), tokens)]));
    const processResult = await runProcess(command, args, {
      cwd: workspace,
      env,
      stdin: adapter.stdin ? replaceTokens(adapter.stdin, tokens) : undefined,
      timeoutMs: caseTimeoutMs,
      maxOutputBytes: Number(benchmarkCase.maxOutputBytes ?? adapter.maxOutputBytes) || DEFAULT_PROCESS_OUTPUT_BYTES
    });
    let output = "";
    let metrics = {};
    let outputError = "";
    try {
      const normalized = normalizeOutput(processResult, adapter);
      output = normalized.text;
      metrics = normalized.metrics;
    } catch (error: any) {
      outputError = error.message;
    }
    const assertions = [];
    if (processResult.exitCode === 0 && !processResult.timedOut && !processResult.outputLimitExceeded && !outputError) {
      for (const assertion of benchmarkCase.assertions ?? []) {
        assertions.push(await gradeAssertion(assertion, { output, workspace }));
      }
    }
    const verified = processResult.exitCode === 0
      && !processResult.timedOut
      && !processResult.outputLimitExceeded
      && !outputError
      && assertions.length > 0
      && assertions.every((assertion) => assertion.passed);
    return {
      trialId,
      adapter: adapter.id,
      caseId: benchmarkCase.id,
      status: verified ? "verified" : "failed",
      verified,
      durationMs: Number(processResult.durationMs.toFixed(2)),
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      timedOut: processResult.timedOut,
      outputLimitExceeded: processResult.outputLimitExceeded,
      processError: processResult.error ?? null,
      outputError: outputError || null,
      output: output.slice(0, 8_000),
      metrics,
      stderr: String(processResult.stderr ?? "").slice(0, 8_000),
      assertions,
      workspaceDigest: await digestDirectory(workspace),
      retainedWorkspace: keepWorkspaces ? trialRoot : null
    };
  } finally {
    if (!keepWorkspaces) await rm(trialRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

function summarize(results: any[], adapters: any[], cases: any[]) {
  const rows = [];
  for (const adapter of adapters) {
    const adapterResults = results.filter((result) => result.adapter === adapter.id);
    const executed = adapterResults.filter((result) => result.status !== "unsupported");
    const verified = executed.filter((result) => result.verified);
    const durations = executed.map((result) => result.durationMs).sort((left, right) => left - right);
    const totalTokens = executed.map((result) => result.metrics?.totalTokens).filter(Number.isFinite).sort((left, right) => left - right);
    const costs = executed.map((result) => result.metrics?.costUsd).filter(Number.isFinite).sort((left, right) => left - right);
    rows.push({
      adapter: adapter.id,
      capabilityCoverage: cases.length
        ? cases.filter((item) => (item.requires ?? []).every((capability: string) => (adapter.capabilities ?? []).includes(capability))).length / cases.length
        : 0,
      cases: cases.length,
      trialsExecuted: executed.length,
      trialsUnsupported: adapterResults.length - executed.length,
      trialsFailed: executed.length - verified.length,
      verified: verified.length,
      verifiedRateExecuted: executed.length ? verified.length / executed.length : null,
      verifiedRateAllTrials: adapterResults.length ? verified.length / adapterResults.length : null,
      timeoutRate: executed.length ? executed.filter((result) => result.timedOut).length / executed.length : null,
      meanMs: mean(durations),
      minMs: durations[0] ?? null,
      maxMs: durations.at(-1) ?? null,
      p50Ms: durations.length ? durations[Math.ceil(durations.length * 0.5) - 1] : null,
      p95Ms: durations.length ? durations[Math.ceil(durations.length * 0.95) - 1] : null,
      meanTotalTokens: mean(totalTokens),
      medianTotalTokens: totalTokens.length ? totalTokens[Math.ceil(totalTokens.length * 0.5) - 1] : null,
      meanCostUsd: mean(costs),
      medianCostUsd: costs.length ? costs[Math.ceil(costs.length * 0.5) - 1] : null
    });
  }
  return rows;
}

function summarizeCases(results: any[], adapters: any[], cases: any[]) {
  return cases.flatMap((benchmarkCase) => adapters.map((adapter) => {
    const rows = results.filter((result) => result.adapter === adapter.id && result.caseId === benchmarkCase.id);
    const executed = rows.filter((result) => result.status !== "unsupported");
    const durations = executed.map((result) => result.durationMs).filter(Number.isFinite).sort((left, right) => left - right);
    const totalTokens = executed.map((result) => result.metrics?.totalTokens).filter(Number.isFinite);
    const costs = executed.map((result) => result.metrics?.costUsd).filter(Number.isFinite);
    const verified = executed.filter((result) => result.verified).length;
    return {
      caseId: benchmarkCase.id,
      adapter: adapter.id,
      trialsExecuted: executed.length,
      trialsUnsupported: rows.length - executed.length,
      verified,
      verifiedRate: executed.length ? verified / executed.length : null,
      timeouts: executed.filter((result) => result.timedOut).length,
      meanMs: mean(durations),
      minMs: durations[0] ?? null,
      maxMs: durations.at(-1) ?? null,
      p50Ms: durations.length ? durations[Math.ceil(durations.length * 0.5) - 1] : null,
      p95Ms: durations.length ? durations[Math.ceil(durations.length * 0.95) - 1] : null,
      meanTotalTokens: mean(totalTokens),
      meanCostUsd: mean(costs)
    };
  }));
}

function mean(values: number[]) {
  return values.length ? Number((values.reduce((total, value) => total + value, 0) / values.length).toFixed(2)) : null;
}

function comparisonWarnings(adapters: any[]) {
  const warnings = [];
  for (const field of ["provider", "model", "reasoning", "sampling", "toolPolicy"]) {
    const values = adapters
      .map((adapter) => adapter.metadata?.[field])
      .filter((value) => value !== undefined && value !== null && value !== "" && value !== "configure-me");
    if (values.length !== adapters.length) warnings.push(`adapter ${field} metadata is incomplete`);
    else if (new Set(values.map(stableJsonValue)).size > 1) warnings.push(`adapter ${field} metadata differs; results are not a runtime-only comparison`);
  }
  return warnings;
}

function validateExecutionPolicy(config: any) {
  if (config.executionPolicy !== "trusted-local") {
    throw new Error('executionPolicy must be "trusted-local"; adapters run with the host user\'s filesystem and network access and are not OS-sandboxed');
  }
}

function validateModelPolicy(config: any, adapters: any[]) {
  const policy = config.modelPolicy;
  if (policy === undefined) return;
  if (policy !== "cloud-only") throw new Error(`unsupported model policy ${policy}`);
  const nonCloud = adapters
    .filter((adapter) => adapter.metadata?.deployment !== "cloud")
    .map((adapter) => adapter.id);
  if (nonCloud.length) {
    throw new Error(`cloud-only benchmark requires metadata.deployment="cloud" for adapters: ${nonCloud.join(", ")}`);
  }
}

async function adapterVersions(adapters: any[]) {
  const versions = [];
  for (const adapter of adapters) {
    if (!adapter.version?.command) {
      versions.push({ id: adapter.id, version: null });
      continue;
    }
    const tokens = { repo: benchmarkRoot };
    const result = await runProcess(
      replaceTokens(adapter.version.command, tokens),
      (adapter.version.args ?? []).map((argument: string) => replaceTokens(argument, tokens)),
      { cwd: benchmarkRoot, timeoutMs: Number(adapter.version.timeoutMs) || 30_000 }
    );
    versions.push({
      id: adapter.id,
      version: result.exitCode === 0 ? (String(result.stdout ?? "").trim() || String(result.stderr ?? "").trim()).slice(0, 1_000) : null,
      versionCommandExitCode: result.exitCode
    });
  }
  return versions;
}

export async function main(args = process.argv.slice(2)) {
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    usage();
    return;
  }
  const configPath = option(args, "--config");
  if (!configPath) throw new Error("--config is required");
  const suitePath = resolveFrom(benchmarkRoot, option(args, "--suite", "benchmarks/suites/smoke.json"));
  const outputDirectory = resolveFrom(benchmarkRoot, option(args, "--output", "dist/benchmarks"));
  const trialsOverride = Number(option(args, "--trials", "0"));
  const adapterFilter = option(args, "--adapter");
  const keepWorkspaces = hasFlag(args, "--keep-workspaces");
  const runUnsupported = hasFlag(args, "--run-unsupported");
  const resumeProgressOption = option(args, "--resume-progress");
  const resolvedConfigPath = resolveFrom(benchmarkRoot, configPath);
  const configSource = await readFile(resolvedConfigPath);
  const suiteSource = await readFile(suitePath);
  const config = JSON.parse(configSource.toString("utf8"));
  const suite = JSON.parse(suiteSource.toString("utf8"));
  const adapters = (config.adapters ?? []).filter((adapter: any) => !adapterFilter || adapter.id === adapterFilter);
  if (!adapters.length) throw new Error("no matching adapters configured");
  validateExecutionPolicy(config);
  validateModelPolicy(config, adapters);
  const cases = [];
  for (const entry of suite.cases ?? []) {
    const manifestPath = resolve(dirname(suitePath), entry);
    const benchmarkCase = await readJson(manifestPath);
    cases.push({ ...benchmarkCase, manifestPath });
  }
  const caseDefinitions = await Promise.all(cases.map(async (item) => ({
    id: item.id,
    title: item.title,
    requires: item.requires ?? [],
    manifest: relative(benchmarkRoot, item.manifestPath),
    manifestDigest: createHash("sha256").update(await readFile(item.manifestPath)).digest("hex"),
    promptDigest: createHash("sha256").update(await readFile(await resolveExistingContained(dirname(item.manifestPath), item.promptFile, "prompt"))).digest("hex"),
    fixtureDigest: item.fixtureDir ? await digestDirectory(await resolveExistingContained(dirname(item.manifestPath), item.fixtureDir, "fixture")) : null
  })));
  const sourceDigestExclusions = new Set([".git", "node_modules", "dist", "benchmarks/state"]);
  const relativeOutputDirectory = relative(benchmarkRoot, outputDirectory).split(sep).join("/");
  if (relativeOutputDirectory && relativeOutputDirectory !== ".." && !relativeOutputDirectory.startsWith("../") && !isAbsolute(relativeOutputDirectory)) {
    sourceDigestExclusions.add(relativeOutputDirectory);
  }
  const benchmarkSourceDigest = await digestDirectory(benchmarkRoot, { excluded: sourceDigestExclusions });
  const runFingerprint = createHash("sha256").update(stableJsonValue({
    configDigest: createHash("sha256").update(configSource).digest("hex"),
    suiteDigest: createHash("sha256").update(suiteSource).digest("hex"),
    benchmarkSourceDigest,
    caseDefinitions,
    selectedAdapters: adapters.map((adapter: any) => adapter.id),
    adapterFilter: adapterFilter || null,
    trialsOverride,
    runUnsupported
  })).digest("hex");
  const selectedAdapterIds = new Set<string>(adapters.map((adapter: any) => String(adapter.id)));
  const selectedCaseIds = new Set<string>(cases.map((benchmarkCase) => String(benchmarkCase.id)));
  await mkdir(outputDirectory, { recursive: true });
  const runStartedAt = new Date().toISOString();
  const reportStem = `${suite.id}-${Date.now()}`;
  const progressPath = resumeProgressOption
    ? resolveFrom(benchmarkRoot, resumeProgressOption)
    : join(outputDirectory, `${reportStem}.progress.ndjson`);
  const results = resumeProgressOption
    ? await readProgress(progressPath, suite.id, runFingerprint, selectedAdapterIds, selectedCaseIds)
    : [];
  if (!resumeProgressOption) await writeFile(progressPath, "");
  for (const benchmarkCase of cases) {
    const caseDirectory = dirname(benchmarkCase.manifestPath);
    for (const adapter of adapters) {
      const missing = (benchmarkCase.requires ?? []).filter((capability: string) => !(adapter.capabilities ?? []).includes(capability));
      const trials = trialsOverride > 0 ? trialsOverride : Number(benchmarkCase.trials) || 1;
      const completedTrials = results.filter((result) => result.adapter === adapter.id && result.caseId === benchmarkCase.id).length;
      if (completedTrials > trials) throw new Error(`progress journal has ${completedTrials} ${benchmarkCase.id}/${adapter.id} trials, exceeding requested count ${trials}`);
      if (missing.length && !runUnsupported) {
        for (let index = completedTrials; index < trials; index += 1) {
          const result = {
            trialId: `${benchmarkCase.id}-${adapter.id}-${index + 1}`,
            adapter: adapter.id,
            caseId: benchmarkCase.id,
            status: "unsupported",
            verified: false,
            missingCapabilities: missing
          };
          results.push(result);
          await appendFile(progressPath, `${JSON.stringify({ recordedAt: new Date().toISOString(), suite: suite.id, runFingerprint, result })}\n`);
        }
        continue;
      }
      for (let index = completedTrials; index < trials; index += 1) {
        const result = await runTrial(adapter, benchmarkCase, caseDirectory, index, keepWorkspaces);
        results.push(result);
        await appendFile(progressPath, `${JSON.stringify({ recordedAt: new Date().toISOString(), suite: suite.id, runFingerprint, result })}\n`);
        console.error(`[bench] ${benchmarkCase.id} · ${adapter.id} · trial ${index + 1}/${trials} · ${result.status} · ${Math.round(result.durationMs)} ms`);
      }
    }
  }
  const report = {
    schemaVersion: 2,
    runStartedAt,
    generatedAt: new Date().toISOString(),
    benchmarkCommit: await gitCommit(benchmarkRoot),
    benchmarkTreeDirty: await gitDirty(benchmarkRoot),
    benchmarkSourceDigest,
    runFingerprint,
    suiteCommit: await gitCommit(dirname(suitePath)),
    environment: {
      platform: platform(),
      release: release(),
      architecture: arch(),
      node: process.version
    },
    suite: suite.id,
    suitePath: relative(benchmarkRoot, suitePath),
    adapters: await adapterVersions(adapters),
    adapterDefinitions: adapters.map((adapter: any) => ({
      id: adapter.id,
      capabilities: adapter.capabilities ?? [],
      metadata: adapter.metadata ?? {},
      command: adapter.command,
      args: adapter.args ?? [],
      envKeys: Object.keys(adapter.env ?? {}).sort(),
      stdinConfigured: adapter.stdin !== undefined,
      stateFixture: adapter.stateFixture ?? null,
      output: adapter.output ?? { format: "text" },
      timeoutMs: Number(adapter.timeoutMs) || null,
      maxOutputBytes: Number(adapter.maxOutputBytes) || DEFAULT_PROCESS_OUTPUT_BYTES
    })),
    comparisonWarnings: comparisonWarnings(adapters),
    cases: caseDefinitions,
    summary: summarize(results, adapters, cases),
    caseSummary: summarizeCases(results, adapters, cases),
    results
  };
  const reportPath = join(outputDirectory, `${reportStem}.json`);
  const jsonlPath = join(outputDirectory, `${reportStem}.jsonl`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const jsonl = results.map((result) => JSON.stringify({
    schemaVersion: report.schemaVersion,
    generatedAt: report.generatedAt,
    benchmarkCommit: report.benchmarkCommit,
    benchmarkTreeDirty: report.benchmarkTreeDirty,
    benchmarkSourceDigest: report.benchmarkSourceDigest,
    runFingerprint: report.runFingerprint,
    suiteCommit: report.suiteCommit,
    environment: report.environment,
    suite: report.suite,
    comparisonWarnings: report.comparisonWarnings,
    adapter: report.adapterDefinitions.find((item: any) => item.id === result.adapter),
    adapterVersion: report.adapters.find((item: any) => item.id === result.adapter),
    case: report.cases.find((item: any) => item.id === result.caseId),
    result
  })).join("\n");
  await writeFile(jsonlPath, `${jsonl}\n`);
  console.log(JSON.stringify({ reportPath, jsonlPath, progressPath, resumedFrom: resumeProgressOption ? basename(progressPath) : null, summary: report.summary, caseSummary: report.caseSummary }, null, 2));
}

async function readProgress(
  path: string,
  suiteId: string,
  runFingerprint: string,
  adapterIds: Set<string>,
  caseIds: Set<string>
) {
  const content = await readFile(path, "utf8");
  return content.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    let entry;
    try { entry = JSON.parse(line); } catch {
      throw new Error(`invalid progress journal JSON at line ${index + 1}`);
    }
    if (entry.suite !== suiteId || !entry.result) throw new Error(`progress journal line ${index + 1} does not belong to suite ${suiteId}`);
    if (entry.runFingerprint !== runFingerprint) {
      throw new Error(`progress journal fingerprint mismatch at line ${index + 1}; benchmark inputs or configuration changed`);
    }
    if (!adapterIds.has(entry.result.adapter) || !caseIds.has(entry.result.caseId)) {
      throw new Error(`progress journal line ${index + 1} is outside the selected adapter/case matrix`);
    }
    return entry.result;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}

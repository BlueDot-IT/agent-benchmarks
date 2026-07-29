import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { main } from "../src/compare.ts";

const execFileAsync = promisify(execFile);

async function writeSuite(root: string, cases: any[]) {
  const suiteDirectory = join(root, "suite");
  await mkdir(suiteDirectory, { recursive: true });
  const entries = [];
  for (const [index, benchmarkCase] of cases.entries()) {
    const directory = join(suiteDirectory, `case-${index + 1}`);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "prompt.md"), "Complete the benchmark task.\n");
    await writeFile(join(directory, "case.json"), `${JSON.stringify({
      schemaVersion: 1,
      requires: ["text.generate"],
      promptFile: "prompt.md",
      trials: 1,
      timeoutMs: 30_000,
      ...benchmarkCase
    }, null, 2)}\n`);
    entries.push(`case-${index + 1}/case.json`);
  }
  const suite = join(suiteDirectory, "suite.json");
  await writeFile(suite, `${JSON.stringify({ schemaVersion: 1, id: "test-suite", cases: entries }, null, 2)}\n`);
  return suite;
}

async function readOnlyReport(output: string) {
  const reports = (await readdir(output)).filter((name) => name.endsWith(".json"));
  assert.equal(reports.length, 1);
  return JSON.parse(await readFile(join(output, reports[0]), "utf8"));
}

test("cross-agent benchmark runner grades output, workspace changes, and capability coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-benchmark-test-"));
  const config = join(root, "adapters.json");
  const output = join(root, "reports");
  await writeFile(config, `${JSON.stringify({
    schemaVersion: 1,
    executionPolicy: "trusted-local",
    adapters: [{
      id: "fixture-agent",
      capabilities: ["text.generate", "workspace.read", "workspace.write", "process.exec"],
      command: process.execPath,
      args: [
        "-e",
        "const fs=require('node:fs');if(fs.existsSync('calculator.mjs'))fs.writeFileSync('calculator.mjs','export function clamp(value, minimum, maximum) { return Math.min(maximum, Math.max(minimum, value)); }\\n');process.stdout.write('BENCHMARK_OK\\n')"
      ],
      output: { format: "text" }
    }]
  }, null, 2)}\n`);
  try {
    await main(["--config", config, "--output", output, "--trials", "1"]);
    const reports = (await readdir(output)).filter((name) => name.endsWith(".json"));
    assert.equal(reports.length, 1);
    const report = JSON.parse(await readFile(join(output, reports[0]), "utf8"));
    assert.equal(report.results.length, 2);
    assert.ok(report.results.every((result: any) => result.verified));
    assert.equal(report.summary[0].verifiedRateExecuted, 1);
    assert.equal(report.summary[0].verifiedRateAllTrials, 1);
    assert.equal(report.summary[0].capabilityCoverage, 1);
    assert.equal(typeof report.summary[0].meanMs, "number");
    assert.equal(report.caseSummary.length, 2);
    assert.ok(report.caseSummary.every((row: any) => row.verifiedRate === 1 && typeof row.meanMs === "number"));
    assert.ok(report.benchmarkCommit === null || /^[0-9a-f]{40}$/u.test(report.benchmarkCommit));
    assert.match(report.benchmarkSourceDigest, /^[0-9a-f]{64}$/u);
    assert.match(report.runFingerprint, /^[0-9a-f]{64}$/u);
    assert.ok(report.benchmarkTreeDirty === null || typeof report.benchmarkTreeDirty === "boolean");
    assert.match(report.cases[0].manifestDigest, /^[0-9a-f]{64}$/u);
    assert.match(report.cases[0].promptDigest, /^[0-9a-f]{64}$/u);
    const jsonl = (await readdir(output)).find((name) => name.endsWith(".jsonl"));
    const trialEnvelope = JSON.parse(await readFile(join(output, jsonl!), "utf8").then((value) => value.trim().split("\n")[0]));
    assert.equal(trialEnvelope.adapter.id, "fixture-agent");
    assert.equal(trialEnvelope.result.verified, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cross-agent benchmark runner records unsupported cases instead of hiding them", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-benchmark-unsupported-"));
  const config = join(root, "adapters.json");
  const output = join(root, "reports");
  await writeFile(config, `${JSON.stringify({
    schemaVersion: 1,
    executionPolicy: "trusted-local",
    adapters: [{
      id: "text-only",
      capabilities: ["text.generate"],
      command: process.execPath,
      args: ["-e", "process.stdout.write('BENCHMARK_OK\\n')"],
      output: { format: "text" }
    }]
  }, null, 2)}\n`);
  try {
    await main(["--config", config, "--output", output, "--trials", "1"]);
    const reports = (await readdir(output)).filter((name) => name.endsWith(".json"));
    const report = JSON.parse(await readFile(join(output, reports[0]), "utf8"));
    assert.equal(report.results.find((result: any) => result.caseId === "javascript-repair-001").status, "unsupported");
    assert.equal(report.summary[0].trialsUnsupported, 1);
    assert.equal(report.summary[0].capabilityCoverage, 0.5);
    assert.equal(report.summary[0].verifiedRateExecuted, 1);
    assert.equal(report.summary[0].verifiedRateAllTrials, 0.5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transient failure case requires one failed command followed by recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-benchmark-transient-recovery-"));
  const config = join(root, "adapters.json");
  const suite = join(root, "suite.json");
  const output = join(root, "reports");
  const casePath = join(import.meta.dirname, "..", "benchmarks", "cases", "transient-failure-recovery", "case.json");
  await writeFile(suite, `${JSON.stringify({
    schemaVersion: 1,
    id: "transient-recovery-test",
    cases: [casePath]
  }, null, 2)}\n`);
  await writeFile(config, `${JSON.stringify({
    schemaVersion: 1,
    executionPolicy: "trusted-local",
    adapters: [{
      id: "fixture-agent",
      capabilities: ["workspace.read", "process.exec"],
      command: process.execPath,
      args: [
        "-e",
        "const cp=require('node:child_process');const first=cp.spawnSync(process.execPath,['unstable-check.mjs']);if(first.status!==75)process.exit(1);const second=cp.spawnSync(process.execPath,['unstable-check.mjs']);if(second.status!==0)process.exit(1);process.stdout.write('BENCHMARK_OK')"
      ],
      output: { format: "text" }
    }]
  }, null, 2)}\n`);
  try {
    await main(["--config", config, "--suite", suite, "--output", output, "--trials", "1"]);
    const report = await readOnlyReport(output);
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0].caseId, "transient-failure-recovery-001");
    assert.equal(report.results[0].verified, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cross-agent benchmark runner rejects local adapters under cloud-only policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-benchmark-cloud-only-"));
  const config = join(root, "adapters.json");
  await writeFile(config, `${JSON.stringify({
    schemaVersion: 1,
    executionPolicy: "trusted-local",
    modelPolicy: "cloud-only",
    adapters: [{
      id: "local-agent",
      metadata: {
        provider: "ollama",
        model: "qwen3-vl:4b",
        deployment: "local"
      },
      capabilities: ["text.generate"],
      command: process.execPath,
      args: ["-e", "process.stdout.write('BENCHMARK_OK\\n')"],
      output: { format: "text" }
    }]
  }, null, 2)}\n`);
  try {
    await assert.rejects(
      main(["--config", config, "--output", join(root, "reports"), "--trials", "1"]),
      /cloud-only benchmark requires metadata\.deployment="cloud" for adapters: local-agent/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cross-agent benchmark runner requires explicit trusted-local execution policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-benchmark-policy-"));
  const config = join(root, "adapters.json");
  await writeFile(config, `${JSON.stringify({
    schemaVersion: 1,
    adapters: [{
      id: "fixture-agent",
      capabilities: ["text.generate"],
      command: process.execPath,
      args: ["-e", "process.stdout.write('OK')"]
    }]
  }, null, 2)}\n`);
  try {
    await assert.rejects(
      main(["--config", config, "--output", join(root, "reports")]),
      /executionPolicy must be "trusted-local"/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file_absent rejects a symlink escape instead of treating it as absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-benchmark-symlink-"));
  const external = join(root, "external");
  const config = join(root, "adapters.json");
  const output = join(root, "reports");
  await mkdir(external);
  await writeFile(join(external, "secret.txt"), "outside\n");
  const suite = await writeSuite(root, [{
    id: "symlink-escape",
    assertions: [{ type: "file_absent", path: "escape/secret.txt" }]
  }]);
  await writeFile(config, `${JSON.stringify({
    schemaVersion: 1,
    executionPolicy: "trusted-local",
    adapters: [{
      id: "fixture-agent",
      capabilities: ["text.generate"],
      command: process.execPath,
      args: [
        "-e",
        "const fs=require('node:fs');fs.symlinkSync(process.argv[1],'escape',process.platform==='win32'?'junction':'dir');process.stdout.write('OK')",
        external
      ]
    }]
  }, null, 2)}\n`);
  try {
    await assert.rejects(
      main(["--config", config, "--suite", suite, "--output", output]),
      /assertion path escapes its allowed root/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("process output is bounded and an overflow cannot verify", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-benchmark-output-limit-"));
  const config = join(root, "adapters.json");
  const output = join(root, "reports");
  const suite = await writeSuite(root, [{
    id: "output-limit",
    assertions: [{ type: "stdout_contains", expected: "x" }]
  }]);
  await writeFile(config, `${JSON.stringify({
    schemaVersion: 1,
    executionPolicy: "trusted-local",
    adapters: [{
      id: "fixture-agent",
      capabilities: ["text.generate"],
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(2048))"],
      maxOutputBytes: 1024
    }]
  }, null, 2)}\n`);
  try {
    await main(["--config", config, "--suite", suite, "--output", output]);
    const report = await readOnlyReport(output);
    assert.equal(report.results[0].verified, false);
    assert.equal(report.results[0].status, "failed");
    assert.equal(report.results[0].outputLimitExceeded, true);
    assert.ok(Buffer.byteLength(report.results[0].output) <= 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("process duration rejects unbounded timeout requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-benchmark-timeout-limit-"));
  const config = join(root, "adapters.json");
  const suite = await writeSuite(root, [{
    id: "timeout-limit",
    timeoutMs: 31 * 60 * 1_000,
    assertions: [{ type: "stdout_equals", expected: "OK" }]
  }]);
  await writeFile(config, `${JSON.stringify({
    schemaVersion: 1,
    executionPolicy: "trusted-local",
    adapters: [{
      id: "fixture-agent",
      capabilities: ["text.generate"],
      command: process.execPath,
      args: ["-e", "process.stdout.write('OK')"]
    }]
  }, null, 2)}\n`);
  try {
    await assert.rejects(
      main(["--config", config, "--suite", suite, "--output", join(root, "reports")]),
      /timeoutMs must be between 1 and 1800000/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exact text and ordered JSON grading are opt-in constraints", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-benchmark-exact-"));
  const config = join(root, "adapters.json");
  const output = join(root, "reports");
  const suite = await writeSuite(root, [
    { id: "strict-text", assertions: [{ type: "stdout_equals", expected: "BENCHMARK_OK" }] },
    { id: "trimmed-text", assertions: [{ type: "stdout_equals", expected: "BENCHMARK_OK", trim: true }] }
  ]);
  await writeFile(config, `${JSON.stringify({
    schemaVersion: 1,
    executionPolicy: "trusted-local",
    adapters: [{
      id: "fixture-agent",
      capabilities: ["text.generate"],
      command: process.execPath,
      args: ["-e", "process.stdout.write('BENCHMARK_OK\\n')"]
    }]
  }, null, 2)}\n`);
  try {
    await main(["--config", config, "--suite", suite, "--output", output]);
    const report = await readOnlyReport(output);
    assert.equal(report.results.find((result: any) => result.caseId === "strict-text").verified, false);
    assert.equal(report.results.find((result: any) => result.caseId === "trimmed-text").verified, true);

    const jsonOutput = join(root, "json-reports");
    const jsonSuite = await writeSuite(join(root, "json"), [
      { id: "semantic-json", assertions: [{ type: "stdout_json_equals", expected: { first: 1, second: 2 } }] },
      { id: "ordered-json", assertions: [{ type: "stdout_json_equals", expected: { first: 1, second: 2 }, orderedKeys: true }] }
    ]);
    const jsonConfig = join(root, "json-adapters.json");
    await writeFile(jsonConfig, `${JSON.stringify({
      schemaVersion: 1,
      executionPolicy: "trusted-local",
      adapters: [{
        id: "fixture-agent",
        capabilities: ["text.generate"],
        command: process.execPath,
        args: ["-e", "process.stdout.write(JSON.stringify({second:2,first:1}))"]
      }]
    }, null, 2)}\n`);
    await main(["--config", jsonConfig, "--suite", jsonSuite, "--output", jsonOutput]);
    const jsonReport = await readOnlyReport(jsonOutput);
    assert.equal(jsonReport.results.find((result: any) => result.caseId === "semantic-json").verified, true);
    assert.equal(jsonReport.results.find((result: any) => result.caseId === "ordered-json").verified, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("progress resume rejects changed benchmark inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-benchmark-progress-"));
  const config = join(root, "adapters.json");
  const output = join(root, "reports");
  const suite = await writeSuite(root, [{
    id: "progress-case",
    assertions: [{ type: "stdout_equals", expected: "OK" }]
  }]);
  const configuration = (script: string) => ({
    schemaVersion: 1,
    executionPolicy: "trusted-local",
    adapters: [{
      id: "fixture-agent",
      capabilities: ["text.generate"],
      command: process.execPath,
      args: ["-e", script]
    }]
  });
  await writeFile(config, `${JSON.stringify(configuration("process.stdout.write('OK')"), null, 2)}\n`);
  try {
    await main(["--config", config, "--suite", suite, "--output", output]);
    const progress = join(output, (await readdir(output)).find((name) => name.endsWith(".progress.ndjson"))!);
    await writeFile(config, `${JSON.stringify(configuration("process.stdout.write('CHANGED')"), null, 2)}\n`);
    await assert.rejects(
      main(["--config", config, "--suite", suite, "--output", join(root, "second-reports"), "--resume-progress", progress]),
      /progress journal fingerprint mismatch/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("copied non-git benchmark trees retain source provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-benchmark-provenance-"));
  const copied = join(root, "copied");
  const config = join(root, "adapters.json");
  const output = join(root, "reports");
  await mkdir(join(copied, "src"), { recursive: true });
  await writeFile(join(copied, "src", "compare.ts"), await readFile(join(dirname(import.meta.dirname), "src", "compare.ts")));
  const suite = await writeSuite(copied, [{
    id: "provenance-case",
    assertions: [{ type: "stdout_equals", expected: "OK" }]
  }]);
  await writeFile(config, `${JSON.stringify({
    schemaVersion: 1,
    executionPolicy: "trusted-local",
    adapters: [{
      id: "fixture-agent",
      capabilities: ["text.generate"],
      command: process.execPath,
      args: ["-e", "process.stdout.write('OK')"]
    }]
  }, null, 2)}\n`);
  try {
    await execFileAsync(process.execPath, [
      join(copied, "src", "compare.ts"),
      "--config", config,
      "--suite", suite,
      "--output", output
    ]);
    const report = await readOnlyReport(output);
    assert.equal(report.benchmarkCommit, null);
    assert.match(report.benchmarkSourceDigest, /^[0-9a-f]{64}$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

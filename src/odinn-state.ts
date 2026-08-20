import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_POLICY_CAPABILITIES = Object.freeze([
  "workspace.readText",
  "workspace.mutate",
  "workspace.patch",
  "model.chat",
  "agent.run",
  "process.exec"
]);
const DIRECT_PROCESS_CAPABILITIES = new Set(["process.exec", "process.execute"]);
const PROCESS_IMAGE = "docker.io/library/node@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03";

const IDENTITY_FILES = Object.freeze({
  "IDENTITY.md": "# Identity\n\nName: Odinn Benchmark Agent\nNature: deterministic isolated evaluation agent\nVoice: concise, direct, evidence-driven\n",
  "SOUL.md": "# Operating Contract\n\nExecute the supplied benchmark task directly. Use only the bounded tools exposed by the runtime, remain inside the disposable workspace, verify requested artifacts, and report only outcomes supported by tool results.\n",
  "USER.md": "# User\n\nThe benchmark operator expects immediate task execution, reproducible artifacts, and no onboarding conversation.\n",
  "AGENTS.md": "# Agent Instructions\n\nThis benchmark identity is already initialized. Do not start identity setup or recreate BOOTSTRAP.md. Work only in the current disposable workspace. Use workspace.readText for inspection and workspace.mutate or workspace.patch for file changes. For governed mutations, omit expected unless an exact state is available; never guess or send an empty expected.digest. Use process.exec only for bounded argument-array commands against the sealed read-only workspace; never expect it to persist files. Verify resulting artifacts with bounded process commands after governed mutations. workspace.readText maxBytes must be no greater than 2000000; omit it when the default is sufficient. For exact structured or arithmetic answers, calculate intermediate terms explicitly, recheck the result, and preserve the requested output shape and key order.\n"
});

function stableJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function benchmarkManifest() {
  const manifest: any = {
    sdkVersion: "1.0",
    id: "main",
    version: "1.0.0",
    name: "Odinn Benchmark Agent",
    kind: "runtime",
    primary: true,
    identity: { files: Object.keys(IDENTITY_FILES) },
    instructions: ["The benchmark identity is complete. Execute the supplied task without onboarding."],
    tools: [...REQUIRED_POLICY_CAPABILITIES],
    plugins: [],
    secrets: [],
    sandbox: { mode: "workspace-write" },
    network: { default: "policy" },
    schedules: [],
    channels: [],
    memory: { autoRecall: false, autoLearn: false, autoCompact: false },
    model: { default: "", fallbacks: [] }
  };
  return { ...manifest, integrity: createHash("sha256").update(stableJson(manifest)).digest("hex") };
}

async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function readJson(path: string, label: string) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing: ${path}`);
    throw new Error(`${label} is invalid JSON: ${path}`, { cause: error });
  }
}

export async function prepareOdinnBenchmarkState(stateDirectory: string) {
  const state = resolve(stateDirectory);
  const metadata = await stat(state).catch(() => undefined);
  if (metadata && !metadata.isDirectory()) throw new Error(`Odinn benchmark state is not a directory: ${state}`);
  await mkdir(state, { recursive: true, mode: 0o700 });

  const configPath = join(state, "config.json");
  const config = await readJson(configPath, "Odinn config");
  config.policy ??= {};
  const allowed = new Set(Array.isArray(config.policy.allowedCapabilities) ? config.policy.allowedCapabilities.map(String) : []);
  for (const capability of REQUIRED_POLICY_CAPABILITIES) allowed.add(capability);
  allowed.delete("process.execute");
  config.policy.allowedCapabilities = [...allowed];
  if (Array.isArray(config.policy.scopedCapabilities)) {
    config.policy.scopedCapabilities = config.policy.scopedCapabilities.filter((grant: any) => (
      grant?.tool !== "process.exec"
      && !DIRECT_PROCESS_CAPABILITIES.has(String(grant?.capability ?? ""))
    ));
  }
  if (config.runtime && typeof config.runtime === "object") {
    delete config.runtime.allowUnconfinedProcessExec;
  }
  const sandbox = config.sandbox && typeof config.sandbox === "object" && !Array.isArray(config.sandbox)
    ? config.sandbox
    : {};
  const backend = sandbox.backend && typeof sandbox.backend === "object" && !Array.isArray(sandbox.backend)
    ? sandbox.backend
    : {};
  const processConfig = sandbox.process && typeof sandbox.process === "object" && !Array.isArray(sandbox.process)
    ? sandbox.process
    : {};
  const limits = processConfig.limits && typeof processConfig.limits === "object" && !Array.isArray(processConfig.limits)
    ? processConfig.limits
    : {};
  config.sandbox = {
    ...sandbox,
    backend: { ...backend, mode: "oci", preference: ["oci"], unavailable: "refuse" },
    process: {
      ...processConfig,
      enabled: true,
      shell: false,
      image: PROCESS_IMAGE,
      limits: {
        ...limits,
        timeoutMs: boundedInteger(limits.timeoutMs, 100, 3_600_000, 120_000),
        cpu: boundedNumber(limits.cpu, 0.1, 64, 2),
        memoryBytes: boundedInteger(limits.memoryBytes, 64 * 1024 * 1024, 1024 ** 4, 2 * 1024 * 1024 * 1024),
        pids: boundedInteger(limits.pids, 16, 4096, 256),
        tmpfsBytes: boundedInteger(limits.tmpfsBytes, 1024 * 1024, 64 * 1024 * 1024 * 1024, 512 * 1024 * 1024),
        outputBytes: boundedInteger(limits.outputBytes, 1024, 100 * 1024 * 1024, 1_000_000)
      }
    }
  };
  await atomicJson(configPath, config);

  const agentDirectory = join(state, "agents", "main");
  await mkdir(agentDirectory, { recursive: true, mode: 0o700 });
  const manifest = benchmarkManifest();
  await atomicJson(join(agentDirectory, "agent.json"), manifest);
  for (const [name, content] of Object.entries(IDENTITY_FILES)) {
    await writeFile(join(agentDirectory, name), content, { mode: 0o600 });
  }
  await rm(join(agentDirectory, "BOOTSTRAP.md"), { force: true });

  await atomicJson(join(state, "agents.json"), {
    schemaVersion: 1,
    defaultAgentId: "main",
    agents: [{ ...manifest, status: "enabled", installedAt: "2026-01-01T00:00:00.000Z" }]
  });
  await assertOdinnBenchmarkStateReady(state);
  return { state, requiredCapabilities: [...REQUIRED_POLICY_CAPABILITIES], identityFiles: Object.keys(IDENTITY_FILES) };
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum ? Number(value) : fallback;
}

function boundedNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback;
}

export async function assertOdinnBenchmarkStateReady(stateDirectory: string) {
  const state = resolve(stateDirectory);
  const config = await readJson(join(state, "config.json"), "Odinn config");
  const allowed = new Set(Array.isArray(config?.policy?.allowedCapabilities) ? config.policy.allowedCapabilities.map(String) : []);
  const missingCapabilities = REQUIRED_POLICY_CAPABILITIES.filter((capability) => !allowed.has(capability));
  if (missingCapabilities.length) throw new Error(`Odinn benchmark state lacks required policy capabilities: ${missingCapabilities.join(", ")}`);
  if (allowed.has("process.execute") || config?.runtime?.allowUnconfinedProcessExec === true) {
    throw new Error("Odinn benchmark state must not expose canonical process.execute or unconfined process execution");
  }
  if (Array.isArray(config?.policy?.scopedCapabilities) && config.policy.scopedCapabilities.some((grant: any) => (
    grant?.tool === "process.exec"
    || DIRECT_PROCESS_CAPABILITIES.has(String(grant?.capability ?? ""))
  ))) {
    throw new Error("Odinn benchmark state must not expose direct process capability grants");
  }
  const agentDirectory = join(state, "agents", "main");
  try {
    await stat(join(agentDirectory, "BOOTSTRAP.md"));
    throw new Error("Odinn benchmark state still has agents/main/BOOTSTRAP.md; first-run onboarding would contaminate trials");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  const manifest = await readJson(join(agentDirectory, "agent.json"), "Odinn benchmark agent manifest");
  if (Array.isArray(manifest.tools) && manifest.tools.some((tool: unknown) => tool === "process.execute")) {
    throw new Error("Odinn benchmark agent manifest must not expose canonical process.execute");
  }
  if (config?.sandbox?.process?.enabled !== true
    || config.sandbox.process.shell !== false
    || config.sandbox.process.image !== PROCESS_IMAGE
    || config?.sandbox?.backend?.mode !== "oci") {
    throw new Error("Odinn benchmark state must expose the sanctioned digest-pinned OCI process sandbox");
  }
  const { integrity, ...unsigned } = manifest;
  const expectedIntegrity = createHash("sha256").update(stableJson(unsigned)).digest("hex");
  if (integrity !== expectedIntegrity) throw new Error("Odinn benchmark agent manifest integrity is invalid");
  for (const name of Object.keys(IDENTITY_FILES)) {
    const content = await readFile(join(agentDirectory, name), "utf8").catch(() => "");
    if (!content.trim()) throw new Error(`Odinn benchmark identity file is missing or blank: agents/main/${name}`);
  }
  const registry = await readJson(join(state, "agents.json"), "Odinn agent registry");
  if (registry.defaultAgentId !== "main" || !Array.isArray(registry.agents) || !registry.agents.some((agent: any) => agent?.id === "main" && agent?.status === "enabled")) {
    throw new Error("Odinn benchmark agent registry does not contain an enabled main agent");
  }
}

async function main(args = process.argv.slice(2)) {
  const stateIndex = args.indexOf("--state");
  const state = stateIndex >= 0 ? args[stateIndex + 1] : "";
  if (!state) throw new Error("usage: pnpm prepare:odinn-state -- --state <directory>");
  const result = await prepareOdinnBenchmarkState(state);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

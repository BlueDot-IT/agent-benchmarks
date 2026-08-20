import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertOdinnBenchmarkStateReady, prepareOdinnBenchmarkState } from "../src/odinn-state.ts";

async function stateFixture(capabilities = ["model.chat", "agent.run"]) {
  const state = await mkdtemp(join(tmpdir(), "agent-bench-odinn-state-"));
  await writeFile(join(state, "config.json"), `${JSON.stringify({
    version: 1,
    policy: { allowedCapabilities: capabilities },
    providers: { test: { type: "openai-compatible", baseUrl: "https://example.invalid/v1", apiKeyEnv: "TEST_KEY", models: ["test"] } },
    defaultModel: "test:test"
  }, null, 2)}\n`);
  return state;
}

test("Odinn benchmark state preparation creates a completed non-secret agent identity and required policy", async () => {
  const state = await stateFixture();
  const bootstrap = join(state, "agents", "main", "BOOTSTRAP.md");

  await prepareOdinnBenchmarkState(state);
  await writeFile(bootstrap, "stale bootstrap\n");
  await assert.rejects(assertOdinnBenchmarkStateReady(state), /BOOTSTRAP\.md/);

  await prepareOdinnBenchmarkState(state);
  await assertOdinnBenchmarkStateReady(state);

  const config = JSON.parse(await readFile(join(state, "config.json"), "utf8"));
  for (const capability of ["workspace.readText", "workspace.mutate", "workspace.patch", "model.chat", "agent.run", "process.exec"]) {
    assert.ok(config.policy.allowedCapabilities.includes(capability));
  }
  assert.equal(config.policy.allowedCapabilities.includes("process.execute"), false);
  assert.equal(config.runtime?.allowUnconfinedProcessExec, undefined);
  assert.equal(config.sandbox.backend.mode, "oci");
  assert.equal(config.sandbox.process.enabled, true);
  assert.equal(config.sandbox.process.shell, false);
  assert.match(config.sandbox.process.image, /@sha256:[a-f0-9]{64}$/u);
  const agents = JSON.parse(await readFile(join(state, "agents.json"), "utf8"));
  assert.equal(agents.defaultAgentId, "main");
  assert.equal(agents.agents[0].status, "enabled");
  for (const file of ["IDENTITY.md", "SOUL.md", "USER.md", "AGENTS.md"]) {
    assert.ok((await readFile(join(state, "agents", "main", file), "utf8")).trim());
  }
  const serialized = JSON.stringify({ config, agents });
  assert.doesNotMatch(serialized, /access[_-]?token|refresh[_-]?token|api[_-]?key["']?\s*:/i);
});

test("Odinn benchmark readiness fails closed for missing tool grants and identity", async () => {
  const state = await stateFixture(["model.chat", "agent.run"]);
  await assert.rejects(assertOdinnBenchmarkStateReady(state), /lacks required policy capabilities/);

  await prepareOdinnBenchmarkState(state);
  await writeFile(join(state, "agents", "main", "IDENTITY.md"), "");
  await assert.rejects(assertOdinnBenchmarkStateReady(state), /missing or blank/);
});

test("Odinn benchmark readiness requires governed workspace mutation capabilities", async () => {
  const state = await stateFixture(["workspace.readText", "model.chat", "agent.run"]);
  await assert.rejects(assertOdinnBenchmarkStateReady(state), /lacks required policy capabilities/);
});

test("Odinn benchmark readiness rejects stale direct process execution grants", async () => {
  const state = await stateFixture();
  await prepareOdinnBenchmarkState(state);
  const configPath = join(state, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.policy.allowedCapabilities.push("process.execute");
  config.policy.scopedCapabilities = [{ tool: "process.exec", capability: "process.execute" }];
  config.runtime = { allowUnconfinedProcessExec: true };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await assert.rejects(assertOdinnBenchmarkStateReady(state), /must not expose canonical process\.execute/);
});

test("Odinn benchmark readiness rejects an alternate process image", async () => {
  const state = await stateFixture();
  await prepareOdinnBenchmarkState(state);
  const configPath = join(state, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.sandbox.process.image = `docker.io/library/node@sha256:${"0".repeat(64)}`;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await assert.rejects(assertOdinnBenchmarkStateReady(state), /sanctioned digest-pinned OCI process sandbox/);
});

test("Odinn benchmark preparation scrubs migrated process grants while preserving provider configuration", async () => {
  const state = await stateFixture(["workspace.readText", "model.chat", "agent.run", "process.execute"]);
  const configPath = join(state, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.policy.scopedCapabilities = [
    { tool: "process.exec", capability: "process.execute" },
    { tool: "workspace.readText", capability: "workspace.read" }
  ];
  config.runtime = { allowUnconfinedProcessExec: true, keepThisSetting: "intact" };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  await prepareOdinnBenchmarkState(state);
  const prepared = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(prepared.policy.allowedCapabilities.includes("process.exec"), true);
  assert.equal(prepared.policy.allowedCapabilities.includes("process.execute"), false);
  assert.deepEqual(prepared.policy.scopedCapabilities, [{ tool: "workspace.readText", capability: "workspace.read" }]);
  assert.equal(prepared.runtime.allowUnconfinedProcessExec, undefined);
  assert.equal(prepared.runtime.keepThisSetting, "intact");
  assert.deepEqual(prepared.providers, config.providers);
});

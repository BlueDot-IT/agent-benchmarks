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
  for (const capability of ["workspace.readText", "process.exec", "model.chat", "agent.run"]) {
    assert.ok(config.policy.allowedCapabilities.includes(capability));
  }
  assert.equal(config.runtime.allowUnconfinedProcessExec, true);
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

test("Odinn benchmark readiness rejects process execution without explicit unsafe acknowledgement", async () => {
  const state = await stateFixture(["workspace.readText", "process.exec", "model.chat", "agent.run"]);
  await assert.rejects(assertOdinnBenchmarkStateReady(state), /allowUnconfinedProcessExec=true/);
});

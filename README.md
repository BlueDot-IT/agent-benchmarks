# Agent Benchmarks

Independent, outcome-verified benchmarks for command-line AI agents.

The harness can compare Odinn Forge, OpenClaw, Hermes Agent, or any other
runtime that can be launched as a bounded command. It evaluates artifacts and
deterministic assertions instead of accepting a plausible final message as
proof that work succeeded.

## Principles

- Every adapter receives the same prompt and disposable workspace fixture.
- Every trial gets isolated state and workspace directories.
- Commands use argument arrays and never an implicit shell.
- Failures, timeouts, policy denials, and unsupported capabilities remain in
  the result set.
- Capability coverage is reported separately from verified success.
- Deterministic assertions take precedence over model-judged evaluation.
- Reports preserve adapter versions, model metadata, case digests, environment
  metadata, and individual trial envelopes.
- No credentials or live personal state belong in this repository.

## Requirements

- Node.js 24 or newer
- pnpm 10.14.0
- Each agent runtime installed separately or addressed by an explicit command
  in the adapter configuration

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
```

## Configure adapters

Copy `benchmarks/adapters.example.json` to the ignored
`benchmarks/adapters.json`. For a maintained cloud comparison, start from
`benchmarks/adapters.cloud.example.json`.

Adapter commands may use these placeholders:

- `{repo}` — this benchmark repository
- `{workspace}` — the disposable case workspace
- `{state}` — the disposable runtime state directory
- `{promptFile}` — the case prompt path
- `{inputFile}` — a generated JSON agent input
- `{prompt}` — the prompt text
- `{trialId}` — the unique trial identifier

Install agent executables on `PATH` or replace their commands with explicit
paths. Product source trees are not vendored here.

Optional state templates live beneath the ignored `benchmarks/state/`
directory:

```text
benchmarks/state/odinn/
benchmarks/state/openclaw/
benchmarks/state/hermes/
```

Templates may contain non-secret provider configuration. Credentials must be
resolved through environment variables or each runtime's protected credential
store. Never place secret values in adapter metadata, command arguments, or
committed fixtures because report envelopes preserve those fields.

For OpenClaw, configure the benchmark-only agent workspace from
`AGENT_BENCH_WORKSPACE`; the example adapter sets it to `{workspace}` for each
trial. Do not point any adapter at live personal state.

## Fair comparisons

The maintained comparison policy is `cloud-only`. Every adapter must declare
`metadata.deployment` as `cloud`, and comparisons should use the same provider,
model, reasoning level, and sampling settings wherever each runtime permits.

If model metadata is missing or differs, the report records a warning. Such a
run may still be useful, but it is a runtime-plus-model comparison rather than
a runtime-only comparison.

## Run

```bash
pnpm benchmark -- \
  --config benchmarks/adapters.json \
  --suite benchmarks/suites/comprehensive.json \
  --trials 5
```

Useful options:

- `--adapter <id>` — run one adapter
- `--keep-workspaces` — retain disposable workspaces for diagnosis
- `--run-unsupported` — execute cases despite missing declared capabilities
- `--output <directory>` — select the report directory
- `--resume-progress <journal>` — continue an interrupted matrix

Reports default to `dist/benchmarks/`:

- a complete JSON report;
- one self-contained trial envelope per JSONL line; and
- an append-only progress journal suitable for resuming long matrices.

Publish both `verifiedRateExecuted` and `verifiedRateAllTrials`. The former
excludes declared unsupported trials; the latter keeps them in the denominator.

## Included cases

The comprehensive suite currently covers:

- exact-output compliance;
- structured JSON and arithmetic;
- recovery from an expected read failure;
- prompt-injection resistance in workspace data;
- bounded JavaScript repair; and
- bounded feature implementation from protected tests.

Supported deterministic assertions include exact or contained stdout, JSON
equality, file presence or absence, file content and hashes, and bounded
argument-array commands.

## Scope

This repository owns the benchmark protocol, cases, adapters, grading,
reproducibility metadata, and reports. Agent-specific capabilities and fixes
belong in their respective product repositories.

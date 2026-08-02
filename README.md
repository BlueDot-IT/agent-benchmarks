# Agent Benchmarks

Independent, outcome-verified benchmarks for command-line AI agents.

The harness can compare Odinn Forge, OpenClaw, Hermes Agent, or any other
runtime that can be launched as a bounded command. It evaluates artifacts and
deterministic assertions instead of accepting a plausible final message as
proof that work succeeded.

## Principles

- Every adapter receives the same prompt and disposable workspace fixture.
- Prompt files are materialized inside each trial root before an adapter starts.
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

Every configuration must explicitly set:

```json
{
  "executionPolicy": "trusted-local"
}
```

This is an acknowledgement, not a sandbox. Adapter processes run as the
current host user and may have that user's filesystem and network access.
Disposable workspaces, reduced environment inheritance, argument-array
execution, timeouts, and output limits improve repeatability; they do not make
an untrusted runtime safe. Run only trusted, locally installed adapters, or put
the entire harness inside an OS/container sandbox you control.

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

After creating the Odinn provider configuration and protected OAuth state,
prepare its isolated benchmark agent before running any suite:

```bash
pnpm prepare:odinn-state -- --state benchmarks/state/odinn
```

This adds the explicitly gated workspace read and bounded process
capabilities, installs a deterministic completed benchmark identity, and
sets the isolated benchmark state's explicit unconfined-process acknowledgement.
The harness fails closed before model
preflight if an Odinn adapter advertises write or process capabilities while
its fixture is missing the required read/process grants, has blank identity files, contains
`BOOTSTRAP.md`, or has an invalid agent manifest/registry. The preparation
command preserves provider configuration and protected credentials already in
the state directory; it never creates or prints them.

Odinn intentionally does not expose `workspace.writeText` until its filesystem
implementation can resist concurrent parent-directory replacement. Benchmark
write cases use the explicitly unconfined `process.exec` capability inside the
disposable trial workspace instead.

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

For reproducible comparisons, declare `metadata.sampling` and
`metadata.toolPolicy` as well. Reports warn when either differs or is missing.

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
- `--strict-comparison` — fail before execution when comparison metadata is incomplete or differs
- `--output <directory>` — select the report directory
- `--resume-progress <journal>` — continue an interrupted matrix; duplicate trial records are rejected
- `--progress-file <journal>` — create a fixed journal or resume it when it already exists
- `--lock-file <path>` — prevent overlapping matrices and preserve stale lock evidence

Reports default to `dist/benchmarks/`:

- a complete JSON report;
- one self-contained trial envelope per JSONL line; and
- an append-only progress journal suitable for resuming long matrices.

Progress journals are bound to a SHA-256 fingerprint of the selected
configuration, suite, cases, source tree, and run options. A changed input
cannot be silently resumed as though it belonged to the original run.

Maintained adapter configurations should define a bounded `preflight` prompt
and exact trimmed sentinel. All selected adapters must pass that real model-backed
health check before the first scored trial. The runner also rejects text
configuration in a state fixture that points back into the benchmark source
tree and verifies after every preflight and scored trial that benchmark inputs
were not modified.

Publish both `verifiedRateExecuted` and `verifiedRateAllTrials`. The former
excludes declared unsupported trials; the latter keeps them in the denominator.

## Included cases

The comprehensive suite currently covers:

- exact-output compliance;
- structured JSON and arithmetic;
- recovery from an expected read failure;
- recovery from an injected transient command failure;
- prompt-injection resistance in workspace data;
- bounded JavaScript repair; and
- bounded feature implementation from protected tests.

Supported deterministic assertions include exact or contained stdout, JSON
equality, file presence or absence, file content and hashes, and bounded
argument-array commands.

`stdout_equals` is byte-preserving by default; set `"trim": true` only when
surrounding whitespace is intentionally insignificant. `stdout_json_equals`
compares parsed JSON semantically by default; set `"orderedKeys": true` when
object key order is part of the required wire format.

The runner caps combined stdout/stderr capture, assertion file reads, workspace
digests, and every process timeout (at 30 minutes). Reports include a
locale-independent source-tree digest even when the benchmark is run from a
copied directory without Git metadata. Summary rows include a warning for
small samples and a Wilson 95% confidence interval for verified rates; a
single successful trial is not statistically strong evidence.

Input configs and suites use schema version 1 and are validated before any
adapter process starts. Adapter and case identifiers must be non-empty and
unique.

## Scope

This repository owns the benchmark protocol, cases, adapters, grading,
reproducibility metadata, and reports. Agent-specific capabilities and fixes
belong in their respective product repositories.

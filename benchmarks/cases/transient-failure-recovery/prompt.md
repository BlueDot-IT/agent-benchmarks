Work only in the current workspace.

The provided `unstable-check.mjs` command simulates a transient dependency
failure. It is intentionally read-only; workspace files are changed only
through governed workspace tools. Run:

`node unstable-check.mjs`

If the command fails, inspect its output, use `workspace.mutate` to set
`attempt-count.txt` to exactly `1\n`, and retry the same command. Stop as soon
as it succeeds, and never run it more than three times.

Do not edit `unstable-check.mjs`. When the command succeeds, use
`workspace.mutate` to set `attempt-count.txt` to exactly `2\n` and create
`recovery.json` with exactly `{"status":"recovered","attempts":2}\n`.
Then respond with exactly `BENCHMARK_OK`.

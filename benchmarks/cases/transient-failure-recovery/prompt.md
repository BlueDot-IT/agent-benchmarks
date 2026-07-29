Work only in the current workspace.

The provided `unstable-check.mjs` command simulates a transient dependency
failure. Run:

`node unstable-check.mjs`

If the command fails, inspect its output and retry the same command. Stop as
soon as it succeeds, and never run it more than three times.

Do not edit `unstable-check.mjs`, `attempt-count.txt`, or create
`recovery.json` yourself. When the command succeeds, respond with exactly
`BENCHMARK_OK`.

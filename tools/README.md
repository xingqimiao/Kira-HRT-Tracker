# tools

## Running the server test suite on Windows

`server/test/` boots a real embedded PostgreSQL. On Windows, `postgres` refuses to
start under an **elevated** token:

    Execution of PostgreSQL by a user with administrative permissions is not permitted.

Every test in a file then fails in under a millisecond with
`Postgres failed to start after 3 attempts`, which reads like a flaky suite but is
this. If your shell is elevated (a fresh Windows Terminal opened as Administrator, or
an agent runtime running elevated), use the helper:

    pwsh -File tools/run-restricted.ps1 -CmdLine 'C:\Windows\System32\cmd.exe /c E:\HRT\tools\run-tests.cmd' -WorkDir 'E:\HRT\server'

It uses the Windows *Safer* API to compute a normal-user token from the current
process and starts the runner with `CreateProcessAsUser` — the process keeps the same
user and profile, without the Administrators group enabled. Results land in
`server/t.out`, `server/t.err` and `server/t.exit`.

From a non-elevated shell, `npm test` in `server/` is all you need.

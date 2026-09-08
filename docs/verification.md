# Verification

The implementation was tested locally on a Linux Sprite with Node.js 24, Git, Herdr 0.9.0, and the installed Sprite CLI. `npm run check` runs syntax checks and 20 automated tests with no npm dependencies. CI repeats the offline tests on Linux/macOS and Node 22/24; remote CI status is separate from the local results.

## Requirements and evidence

| Issue #106 requirement | Implementation | Evidence |
| --- | --- | --- |
| Herdr plugin and manifest | Root `herdr-plugin.toml`, `sprites` plugin ID, eight actions and confirmation pane | Parsed by Python TOML parser and linked/listed by real Herdr 0.9.0 |
| Create Sprite and transfer worktree | `start-agent`, `prepare`, `workspace.mjs` | Real split, Sprite creation, uncommitted upload, excluded `.env`, nested/empty current directory |
| Interactive coding agents with detection hint | Bridge exports `HERDR_AGENT`; `sprite exec --tty --no-port-forward` | Real TTY fixture and real Claude Code, Codex, OpenCode startup; versions recorded in live report |
| Reconnect | Attach existing TTY session or launch same command in existing filesystem | Detach and reconnect retain the same remote session ID; fresh launch after restore |
| Safe pull | Snapshot baseline, exact-file conflict gate, binary checked Git apply | Real conflict rejection/apply/repeat, plus binary/mode/deletion/index/path-safety unit cases |
| Stop | Kill TTY sessions on this pane's dedicated Sprite | Real session termination with filesystem retained; active-agent pull rejected |
| Info and per-pane mapping | Private atomic per-pane state plus live session query | Real info action, setup state, running sessions; state isolation and failure tests |
| Destroy | Confirm exact Sprite name, delete, retain tombstone | Real cancellation and confirmed deletion; test resources checked for cleanup |
| Checkpoint/restore | Checkpoint before new run, manual checkpoint, safety checkpoint before confirmed restore | Real checkpoint creation, cancellation, restoration of changed file, local file preservation, reconnect |
| Target repository and discovery metadata | Pushed `main` to `superfly/herdr-sprites-plugin`; root manifest present | Repository is private. Topic update was denied (HTTP 403); a repository admin must add `herdr-plugin` and make it public for marketplace discovery |

The optional fleet, host-credential discovery/injection, and automatic worktree-removal deletion ideas are not part of this first version. Agent credentials are intentionally established inside each Sprite. No authenticated model task or paid inference is included in the smoke test.

## Observed integration details

- The installed CLI uses `exec --tty`, not the issue's illustrative `exec -i` syntax.
- `sprite file push` reported a missing remote directory even when `exec ls` proved it existed. Transfers therefore use binary stdin through non-TTY `sprite exec`; this path passed live testing and avoids colon-delimited source/destination parsing.
- The exec API reports the agent's current command after an `exec`, not the original wrapper path. Session matching uses the TTY flag within the dedicated Sprite, so changing agent commands or current directories does not lose the session.
- OpenCode 1.18.29 requires its postinstall binary-selection step. Setup explicitly enables npm scripts and invokes the package postinstall script so retries also repair a prior partial installation.
- A Herdr popup opened by a headless server is not exposed in normal pane listings. Confirmation uses a declared split pane, which is visible and controllable in both headless and interactive Herdr.
- The org concurrent-Sprite limit briefly rejected one creation. The failed mapping retained the intended name and error. After an authenticated list confirmed absence and capacity freed, that rejected creation was retried and the live test continued.

The repeatable opt-in test is `scripts/live-test.mjs`. Its final receipt is [live-test.json](../verification/live-test.json). It records versions and assertions, not authentication-screen contents. Test Sprites are created only for this test and destroyed afterward; unrelated Sprites and services are not touched.

The final clean live run passed all 11 assertions, including all three agent CLIs, with no capacity retries. All test Sprites and test Herdr services were confirmed absent afterward. The final offline run passed all 20 tests. The code was pushed to `main`; the current GitHub token cannot read Actions runs (HTTP 403), so remote CI results are unverified.

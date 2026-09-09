# Verification

The implementation was tested locally on a Linux Sprite with Node.js 24, Git, Herdr 0.9.0, and the installed Sprite CLI. `npm run check` runs syntax checks and automated tests with no npm dependencies. CI repeats the offline tests on Linux/macOS and Node 22/24; remote CI status is separate from the local results. Counts and live results below describe earlier runs, not a fresh verification of every subsequent change.

## Requirements and evidence

| Issue #106 requirement | Implementation | Evidence |
| --- | --- | --- |
| Herdr plugin and manifest | Root `herdr-plugin.toml`, `sprites` plugin ID, eleven actions and confirmation pane | Parsed by Python TOML parser; original eight-action version linked/listed by real Herdr 0.9.0 |
| Create Sprite and transfer worktree | `start-agent`, `prepare`, `workspace.mjs` | Real split, Sprite creation, uncommitted upload, excluded `.env`, nested/empty current directory |
| Interactive coding agents with detection hint | Bridge exports `HERDR_AGENT`; `sprite exec --tty --no-port-forward` | Real TTY fixture and real Claude Code, Codex, OpenCode startup; versions recorded in live report |
| Reconnect | Attach existing TTY session or launch same command in existing filesystem | Detach and reconnect retain the same remote session ID; fresh launch after restore |
| Safe pull | Snapshot baseline, exact-file conflict gate, binary checked Git apply | Real conflict rejection/apply/repeat, plus binary/mode/deletion/index/path-safety unit cases |
| Stop | Kill TTY sessions on this pane's dedicated Sprite | Real session termination with filesystem retained; active-agent pull rejected |
| Info and per-pane mapping | Private atomic per-pane state plus live session query | Real info action, setup state, running sessions; state isolation and failure tests |
| Destroy | Confirm exact Sprite name, delete, retain tombstone | Real cancellation and confirmed deletion; test resources checked for cleanup |
| Checkpoint/restore | Checkpoint before new run, manual checkpoint, safety checkpoint before confirmed restore | Real checkpoint creation, cancellation, restoration of changed file, local file preservation, reconnect |
| Target repository and discovery metadata | Pushed `main` to `superfly/herdr-sprites-plugin`; root manifest present | At the earlier publication attempt, the repository was private and the topic update was denied (HTTP 403). Recheck settings using the [release checklist](marketplace.md). |

Fleet orchestration and automatic worktree-removal deletion are not included. Claude and Codex credential handoff was added after these live runs and is covered by fixture-based tests; the live harness disables it. No authenticated model task or paid inference is included in the smoke test.

## Observed integration details

- The installed CLI uses `exec --tty`, not the issue's illustrative `exec -i` syntax.
- `sprite file push` reported a missing remote directory even when `exec ls` proved it existed. Transfers therefore use binary stdin through non-TTY `sprite exec`; this path passed live testing and avoids colon-delimited source/destination parsing.
- The exec API reports the agent's current command after an `exec`, not the original wrapper path. Session matching uses the TTY flag within the dedicated Sprite, so changing agent commands or current directories does not lose the session.
- OpenCode 1.18.29 requires its postinstall binary-selection step. Setup explicitly enables npm scripts and invokes the package postinstall script so retries also repair a prior partial installation.
- A Herdr popup opened by a headless server is not exposed in normal pane listings. Confirmation uses a declared split pane, which is visible and controllable in both headless and interactive Herdr.
- The org concurrent-Sprite limit briefly rejected one creation. The failed mapping retained the intended name and error. After an authenticated list confirmed absence and capacity freed, that rejected creation was retried and the live test continued.

The repeatable opt-in test is `scripts/live-test.mjs`. Its final receipt is [live-test.json](../verification/live-test.json). It records versions and assertions, not authentication-screen contents. Test Sprites are created only for this test and destroyed afterward; unrelated Sprites and services are not touched.

The final clean live run passed all 11 assertions, including all three agent CLIs, with no capacity retries. All test Sprites and test Herdr services were confirmed absent afterward. The final offline run passed all 20 tests. The code was pushed to `main`; the current GitHub token cannot read Actions runs (HTTP 403), so remote CI results are unverified.

## Real-Sprite CI workflow

The `.github/workflows/e2e.yml` workflow runs on pushes to `main` (including merged pull requests) and manual dispatch. It uses repository secret `SPRITE_TOKEN` and repository variable `SPRITES_TEST_ORG`. It is restricted to `main` and uses checksum-pinned Herdr 0.9.0 and Sprite CLI 2026-09-02 binaries. Actionlint 1.7.12 validates both workflows.

The GitHub-compatible subprocess path was exercised locally with those exact binaries: all 11 live assertions passed, all four dedicated test Sprites were verified absent, and the standalone fallback cleanup also passed idempotently. See [the local CI-mode receipt](../verification/ci-e2e-local.json). The expanded offline suite passes 27 tests, including cleanup ownership, incomplete creation, failed deletion, and token redaction. This local run uses the existing CLI authentication; the configured GitHub secret will be exercised by the dispatched Actions run.

TruffleHog 3.97.4 was run locally against Git history and the working tree with `--no-verification --no-update --json --fail --fail-on-scan-errors`. Both scans returned zero findings. Credential verification was disabled so potential findings would not be sent to external providers. TruffleHog is not added to CI.

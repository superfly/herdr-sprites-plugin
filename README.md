# Sprites for Herdr

Run Claude Code, Codex, OpenCode, or a custom coding-agent CLI in a persistent [Sprite](https://sprites.dev), controlled from a local [Herdr](https://herdr.dev) pane. Each agent pane gets its own Sprite. Worktree files include uncommitted edits; Git metadata stays local; the selected agent’s login is handed off separately from project files.

## Local setup

Requirements: Linux or macOS, Node.js 22+, Git, the authenticated `sprite` CLI, and Herdr 0.9.0+. Tested with Herdr 0.9.0. The Sprite CLI must support `exec --tty`, `sessions`, `checkpoint create`, `restore`, and `api`.

```sh
sprite login
herdr plugin link /absolute/path/to/herdr-sprites-plugin
herdr plugin config-dir sprites
```

Create `config.json` in the printed config directory:

```json
{
  "org": "your-sprites-organization",
  "agent": "claude"
}
```

Choose `claude`, `codex`, or `opencode`. Claude Code and Codex use the Sprite image's installed CLIs. If OpenCode is absent, the plugin installs `opencode-ai@1.18.29` in the new Sprite's private tools directory. The actual installed version appears in Info. A missing Claude/Codex executable fails setup explicitly.

For another agent, or to pass arguments, supply an argv array:

```json
{
  "org": "your-sprites-organization",
  "agent": "codex",
  "command": ["codex", "--model", "gpt-5.4"]
}
```

`agent` sets the `HERDR_AGENT` detection hint; use a kind Herdr recognizes. `command` runs in the remote workspace, without local shell expansion. `namePrefix` defaults to `herdr-`; set it to `ci-` for credentials restricted to `ci-*` names. It must be 2–20 lowercase letters, digits or hyphens, start with a letter, and end with a hyphen. `spriteBin` optionally selects an absolute Sprite CLI path. The organization and command are saved per mapping, so later config changes do not retarget existing Sprites.

Invoke from a Git worktree in Herdr. For a new project, run `git init` first; no commit is required. If the focused folder is not a Git repository, the plugin shows a Herdr notification with the next step and records the folder and initialization command in its action error:

```sh
herdr plugin action invoke start-agent --plugin sprites
```

The action creates a split pane and launches setup there. Setup clears the launch command from the fresh pane, then shows animated progress steps and elapsed times before handing the terminal to the agent. The command may briefly appear before setup starts because Herdr launches it through the shell. Reconnect preserves existing scrollback. Non-interactive output stays plain; `NO_COLOR` disables colors. Action results and errors are available through `herdr plugin log list --plugin sprites`. Its `setup-launched` result is asynchronous: use Info or read the new pane to confirm setup completed. Claude and Codex reuse your local login automatically when one is available. Otherwise, sign in inside the remote terminal. Authentication saved inside the Sprite survives reconnects and idle suspension.

Choose a harness for a single launch without editing configuration:

```sh
herdr plugin action invoke start-claude --plugin sprites
herdr plugin action invoke start-codex --plugin sprites
herdr plugin action invoke start-opencode --plugin sprites
```

These actions use the named harness's default command and override both `agent` and `command` for the new Sprite. Shared settings (`org`, `namePrefix`, `maxTransferMiB`, `auth`, and `spriteBin`) still apply. Your config file stays unchanged. Use `start-agent` to honor a configured custom command or arguments. Each Sprite keeps its selected harness on reconnect.

## Agent login handoff

`"auth": "auto"` is the default. For the selected standard `claude` or `codex` command, setup transfers the local login once before the first agent launch. It also works when reconnecting a stopped Sprite created by an older plugin version. Set `"auth": "none"` before creating a Sprite to keep authentication entirely manual. Disabling handoff does not revoke credentials already stored remotely.

- **Claude:** reads its macOS Keychain item (including `CLAUDE_CONFIG_DIR` profiles), falling back to `.credentials.json`; Linux uses that file directly. macOS may prompt you to allow Keychain access. Only the OAuth credential fields are copied.
- **Codex:** reads `auth.json` under `CODEX_HOME` (default `~/.codex`), honoring the root `cli_auth_credentials_store` setting. macOS `keyring` and `auto` modes use the exact Codex Keychain item. Linux keyring export is not supported; use file storage or manual login.
- **Environment credentials:** `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN` can supply Claude access; `OPENAI_API_KEY` can supply Codex access. An explicit supported environment credential takes precedence over the cached login. It must be present in the environment Herdr gives the bridge. Project `.env` files and custom credential helpers are not read.

Credentials travel through the Sprite CLI's stdin, never command arguments. Remote files have mode `0600`, outside the uploaded workspace. Token values are not written to local plugin state, generated launch scripts, reports, or progress output. Local settings, hooks, MCP configuration, and project trust are not copied. Claude's initial onboarding marker is set on the Sprite; workspace trust prompts still belong to the agent.

The Sprite and its checkpoints contain the copied credentials. They use your account and its limits, and remain accessible to processes running as your Sprite user. Reconnect preserves remotely refreshed credentials instead of overwriting them with an older local cache. Revoked or expired sessions can still require another login; this is a one-time handoff, not a token-refresh relay. OpenCode and custom command wrappers currently use manual authentication.

The live E2E harness explicitly sets `auth: "none"`; credential tests use fixture values only. Provider inference with transferred credentials has not been exercised by CI.

Format references: [Codex authentication](https://developers.openai.com/codex/auth/) and [Claude credential management](https://code.claude.com/docs/en/authentication#credential-management).

## Actions

The plugin ID is `sprites`; action IDs below correspond to the issue's `sprites.<action>` surface. Invoke with `herdr plugin action invoke <action> --plugin sprites`.

| Action | Behavior |
| --- | --- |
| `start-claude` / `start-codex` / `start-opencode` | Launch the named harness in a new Sprite using shared settings. |
| `start-agent` | Create a dedicated Sprite, upload the current worktree, checkpoint, and launch an agent in a new split. |
| `reconnect` | Reattach a detached remote agent session. If it exited, checkpoint and start the same configured command again, preserving remote files and authentication. |
| `pull` | Export current remote files, refuse overlapping local edits, and apply changes locally without changing the local Git index. Stop the agent first. |
| `stop` | Kill interactive sessions in this pane's dedicated Sprite. Preserve the Sprite and checkpoints. Idle Sprites suspend automatically; services may keep them running. |
| `info` | Show the mapping, setup errors, installed version, checkpoint, and authoritative remote session list. |
| `checkpoint` | Save a new named-in-state checkpoint while the agent is stopped. |
| `restore` | Open a confirmation pane. After confirmation, create a recovery checkpoint and restore the saved checkpoint. Local files are unaffected. |
| `destroy` | Open a confirmation pane, then delete this Sprite and its checkpoints. Retain a local tombstone for troubleshooting. |

Restore and Destroy require typing the exact Sprite name in their confirmation pane. Cancelling changes nothing. Each fresh agent run automatically replaces the saved restore target with its pre-run checkpoint; reattachment does not create a new checkpoint. Restoring a Sprite restarts its environment, and reconnect resumes operation afterward.

Example keybinding in Herdr's `config.toml`:

```toml
[[keys.command]]
key = "prefix+shift+s"
command = "herdr plugin action invoke start-agent --plugin sprites"
```

See the [Vercel and E2B action comparison](docs/action-comparison.md) for their exposed actions and differences in pane/workspace targeting.

## Worktree transfer

The plugin transfers regular files from `git ls-files`, including staged, unstaged, and non-ignored untracked files. Deleted files stay deleted. Each transfer defaults to a 64 MiB limit of decoded file contents. Set `"maxTransferMiB": 256` in plugin `config.json` to raise it (integer 1–512), then start a new Sprite. The setting is saved per Sprite and applies to upload and pull. Transfers are buffered in memory, so peak memory use can be several times the configured size. Oversized uploads report the total and five largest eligible files before reading file contents or creating a Sprite. Exclude unnecessary files through `.gitignore` or the local-only `.git/info/exclude`. Binary bytes, executable bits, spaces, quotes, and newlines in filenames are preserved. Empty current subdirectories are created remotely.

It excludes Git-ignored files (including tracked files now ignored), `.git`, `.sprite`, `.sprites`, `.env`/`.env.*`, `.ssh`, `.aws`, `.azure`, `.config`, `.codex`, `.claude`, `.vercel`, package-manager credential files, common credential filenames, and private-key extensions. Symlinks, special files, and submodule directories are omitted. Local Git history and credentials never enter the transfer; the remote workspace gets a fresh baseline Git repository. Review project files for secrets stored under ordinary source filenames before using a remote environment.

Pull compares the current remote snapshot against the last successful upload/pull snapshot. Every affected local file must still match that baseline or already match the incoming result. Overlapping local edits, untracked collisions, unsafe paths, and symlink ancestors cause rejection before any local change. Unrelated local changes are preserved. A binary Git patch performs the final checked apply; the local index and existing commits remain unchanged. Repeated pulls and retrying after a receipt-write interruption are safe. There is no automatic upload on reconnect and no automatic overwrite of remote agent work.

The baseline and mapping live under `HERDR_PLUGIN_STATE_DIR`, outside the source checkout, in private per-pane files. Configuration lives under `HERDR_PLUGIN_CONFIG_DIR`. Worktree removal does not destroy Sprites automatically. Fleet orchestration and worktree-removal cleanup are optional follow-ups from issue #106, not enabled in this version.

## Testing

No npm dependencies or build step are required:

```sh
npm run check
```

The test suite covers exact-byte transfers, binary files, modes, unusual paths, credential exclusions, conflicts, state isolation, locks, CLI parsing, and errors.

An opt-in integration test runs a real isolated Herdr server and creates disposable Sprites. On a Sprite VM it uses `sprite-env services`; on other hosts it manages a short-lived Herdr subprocess. It requires an authenticated Sprite CLI and a downloaded Herdr binary. It exercises the entire action lifecycle, then starts the three real agent CLIs without injecting host credentials:

```sh
SPRITES_TEST_ORG=your-test-org \
HERDR_TEST_BIN=/absolute/path/to/herdr \
node scripts/live-test.mjs
```

The script stops its test Herdr server, deletes its test Sprites, and verifies their absence afterward. It writes `verification/live-test.json` and retains local fixture files under its printed temporary directory. Agent smoke tests verify installation and interactive startup, not paid model inference or provider authentication. See [verification notes](docs/verification.md).

## GitHub Actions E2E

Configure these repository Actions settings:

- **Secret `SPRITE_TOKEN`**: a Sprite token for a dedicated test organization. It needs permission to create/destroy Sprites, exec, and create/restore checkpoints. Use only the token value, without a `Bearer` prefix or shell command. The harness trims surrounding whitespace (including copied trailing newlines) and rejects embedded whitespace/control characters before running the CLI. The CLI reads the token from its environment; no login command or token file is needed.
- **Variable `SPRITES_TEST_ORG`**: the organization name associated with that token.

The E2E test creates `ci-herdr-*` Sprites, so a token restricted to `ci-*` names is supported.

Run **Actions → Real Sprite E2E → Run workflow**, selecting **main**, or:

```sh
gh workflow run e2e.yml --repo superfly/herdr-sprites-plugin --ref main
```

This manual workflow is restricted to `main`. It never runs with secrets on pull requests, and runs are serialized to reduce quota pressure. It downloads checksum-verified Herdr 0.9.0 and Sprite CLI 2026-09-02, runs the offline tests, then performs the same live lifecycle and Claude/Codex/OpenCode startup checks. No model-provider credentials or paid inference are required; real Sprite usage may incur charges.

The normal test cleanup and a separate `always()` cleanup step both reconcile this run's recorded creation intents, including a Sprite whose create response was interrupted. Cleanup fails visibly if it cannot prove those Sprites are gone. A hard runner loss may prevent cleanup; the recorded `ci-herdr-*` names identify test resources for manual removal in that case.

The `real-sprite-e2e-report` artifact contains assertions, versions, resource names, and cleanup results. It does not include CLI configuration, tokens, server logs, or terminal login screens. Local equivalents:

```sh
HERDR_TEST_SERVER_MODE=process \
SPRITES_TEST_ORG=your-test-org HERDR_TEST_BIN=/absolute/path/to/herdr \
npm run test:e2e
```

`HERDR_TEST_RUN_DIR` optionally selects a fresh absolute run directory; existing directories are rejected to prevent state reuse. `HERDR_TEST_REPORT` optionally redirects the receipt. `scripts/cleanup-live-test.mjs` can reconcile a retained run directory using those same environment variables.

## Recovery

Info reports setup failure without silently recreating or re-uploading the Sprite. If the upload completed but agent installation failed, Reconnect retries agent setup in the existing workspace. For failures before upload completes, destroy the failed mapping explicitly and start a new agent. A create request interrupted before acknowledgement may still have created the recorded name; Destroy targets that name even when `created` is false.

Operations use exclusive per-pane locks, plus a separate connection lock to prevent duplicate terminal launches. A crashed process can leave a lock file. The error names the file and it contains the owning local PID. Verify that process has exited before deleting that specific lock. Do not delete the baseline snapshot to resolve a lock.

A lost/missing Sprite produces an error; reconnect never silently substitutes a fresh environment. Use Destroy to reconcile a failed setup. If deletion succeeded but the CLI response was lost, Destroy reconciles the mapping only after an authenticated Sprite list proves the recorded name is absent.

## Distribution

Target repository: [superfly/herdr-sprites-plugin](https://github.com/superfly/herdr-sprites-plugin). The root `herdr-plugin.toml` and `herdr-plugin` GitHub topic make the public repository discoverable by the Herdr marketplace. Once published:

```sh
herdr plugin install superfly/herdr-sprites-plugin
```

Reference contracts: [Herdr plugins](https://herdr.dev/docs/plugins/), [Vercel plugin](https://github.com/vercel-labs/herdr-vercel-sandbox-plugin), [E2B plugin](https://github.com/e2b-dev/herdr-e2b-sandbox), and installed Sprite CLI help/source.

# Sprites for Herdr

Run Claude Code, Codex, OpenCode, or a custom coding-agent CLI in a persistent [Sprite](https://sprites.dev), controlled from a local [Herdr](https://herdr.dev) pane. Each agent pane gets its own Sprite. Worktree files include uncommitted edits; host credentials and Git metadata are not uploaded.

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

`agent` sets the `HERDR_AGENT` detection hint; use a kind Herdr recognizes. `command` runs in the remote workspace, without local shell expansion. `spriteBin` optionally selects an absolute Sprite CLI path. The organization and command are saved per mapping, so later config changes do not retarget existing Sprites.

Invoke from a Git worktree in Herdr:

```sh
herdr plugin action invoke start-agent --plugin sprites
```

The action creates a split pane and launches setup there. Action results and errors are available through `herdr plugin log list --plugin sprites`. Its `setup-launched` result is asynchronous: use Info or read the new pane to confirm setup completed. Initial provider authentication takes place inside the remote agent's terminal; no host agent credentials are copied. Authentication saved inside the Sprite survives reconnects and idle suspension.

## Actions

The plugin ID is `sprites`; action IDs below correspond to the issue's `sprites.<action>` surface. Invoke with `herdr plugin action invoke <action> --plugin sprites`.

| Action | Behavior |
| --- | --- |
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

## Worktree transfer

The plugin transfers regular files from `git ls-files`, including staged, unstaged, and non-ignored untracked files. Deleted files stay deleted. Each transfer is limited to 64 MiB of decoded file contents. Binary bytes, executable bits, spaces, quotes, and newlines in filenames are preserved. Empty current subdirectories are created remotely.

It excludes Git-ignored files (including tracked files now ignored), `.git`, `.sprite`, `.sprites`, `.env`/`.env.*`, `.ssh`, `.aws`, `.azure`, `.config`, `.codex`, `.claude`, `.vercel`, package-manager credential files, common credential filenames, and private-key extensions. Symlinks, special files, and submodule directories are omitted. Local Git history and credentials never enter the transfer; the remote workspace gets a fresh baseline Git repository. Review project files for secrets stored under ordinary source filenames before using a remote environment.

Pull compares the current remote snapshot against the last successful upload/pull snapshot. Every affected local file must still match that baseline or already match the incoming result. Overlapping local edits, untracked collisions, unsafe paths, and symlink ancestors cause rejection before any local change. Unrelated local changes are preserved. A binary Git patch performs the final checked apply; the local index and existing commits remain unchanged. Repeated pulls and retrying after a receipt-write interruption are safe. There is no automatic upload on reconnect and no automatic overwrite of remote agent work.

The baseline and mapping live under `HERDR_PLUGIN_STATE_DIR`, outside the source checkout, in private per-pane files. Configuration lives under `HERDR_PLUGIN_CONFIG_DIR`. Worktree removal does not destroy Sprites automatically. Fleet orchestration, host credential injection, and worktree-removal cleanup are optional follow-ups from issue #106, not enabled in this version.

## Testing

No npm dependencies or build step are required:

```sh
npm run check
```

The test suite covers exact-byte transfers, binary files, modes, unusual paths, credential exclusions, conflicts, state isolation, locks, CLI parsing, and errors.

An opt-in integration test runs a real isolated Herdr server in a Sprite VM and creates disposable Sprites. It requires an authenticated Sprite CLI and a downloaded Herdr binary. It exercises the entire action lifecycle, then starts the three real agent CLIs without injecting host credentials:

```sh
SPRITES_TEST_ORG=your-test-org \
HERDR_TEST_BIN=/absolute/path/to/herdr \
node scripts/live-test.mjs
```

The script deletes its test Sprites and Herdr service afterward. It writes `verification/live-test.json` and retains local fixture files under its printed temporary directory. Agent smoke tests verify installation and interactive startup, not paid model inference or provider authentication. See [verification notes](docs/verification.md).

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

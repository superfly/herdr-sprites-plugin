# Herdr sandbox action comparison

Checked September 8, 2026 against the manifests below. These are exposed plugin actions, not every capability of the providers' CLIs.

| Plugin | Actions |
| --- | --- |
| Sprites | `start-agent`, `start-claude`, `start-codex`, `start-opencode`, `reconnect`, `pull`, `stop`, `info`, `destroy`, `checkpoint`, `restore` |
| [Vercel Sandbox 0.6.0](https://github.com/vercel-labs/herdr-vercel-sandbox-plugin/blob/be8393aac17eae4b67ca58fdcc5ad8233f91b6c5/herdr-plugin.toml) | `connect-vercel`, `link-vercel-project`, `start-agent`, `reconnect`, `apply-changes`, `stop`, `info`, `replace-sandbox`, `forget-mapping` |
| [E2B 0.5.0](https://github.com/e2b-dev/herdr-e2b-sandbox/blob/88f3ad3a909caf95f6901c273ec4a5439b612009/herdr-plugin.toml) | `open`, `fleet`, `sync`, `pull`, `status`, `pause`, `resume`, `kill`, `dashboard`, `dashboard-toggle`, `popup` |

Sprites now exposes a separate launch action for each built-in harness. Vercel exposes a configured-agent launch action. E2B's `open` and `fleet` hand off to interactive panes, including chooser screens.

Vercel's account login and project-linking actions make onboarding explicit. Its `replace-sandbox` and `forget-mapping` actions both confirm permanent remote deletion; the latter does more than discard local metadata. Sprites currently uses the local `sprite login` flow and explicit org configuration, and exposes confirmed `destroy` plus checkpoint/restore actions.

E2B's actions target a workspace; its dashboard offers a place to manage tracked boxes. Sprites and Vercel target the mapped agent pane for lifecycle operations. That distinction matters when invoking Info, Stop, or Pull from an unrelated local shell pane.

E2B separately exposes local-to-remote `sync` and remote-to-local `pull`, fleet creation, explicit pause/resume, and a `worktree.removed` teardown event. Sprites uploads at creation, pulls changes explicitly, and retains the remote filesystem on reconnect. Its `stop` kills interactive agent sessions; it is not an explicit VM pause action. Fleet, dashboard, re-upload, and worktree-removal teardown are not currently exposed by Sprites.

Useful follow-ups are a Sprite login/setup action and a dashboard or mapping picker, so failures and lifecycle operations are easier to discover from the local project pane. This comparison does not add those actions.

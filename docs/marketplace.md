# Marketplace release checklist

Herdr discovers plugins directly from GitHub. There is no separate marketplace submission or npm release. Keep `private: true` in `package.json`; it prevents accidental npm publishing and does not affect Herdr installation.

## Listing details

| Field | Value |
| --- | --- |
| Repository | `superfly/herdr-sprites-plugin` |
| Suggested GitHub description | Run coding agents in persistent Sprites with safe worktree transfer and checkpoint rollback. |
| Suggested GitHub website | `https://sprites.dev` |
| Required GitHub topic | `herdr-plugin` |
| Optional GitHub topics | `sprites`, `herdr`, `coding-agents`, `claude-code`, `codex`, `opencode` |
| Manifest path | `herdr-plugin.toml` (repository root) |
| Plugin ID / name | `sprites` / Sprites |
| Version | `0.1.0` |
| Minimum Herdr version | `0.9.0` |
| Platforms | Linux and macOS |
| Runtime requirements | Node.js 22+, Git, authenticated Sprite CLI |
| Build commands | None; no npm dependencies |
| License | MIT |

The repository card uses GitHub's description, owner, stars, primary language, and last-pushed time. The plugin row uses manifest metadata. Set the GitHub description as well as the manifest description.

## Before publication

- [ ] Run `npm run check` and parse `herdr-plugin.toml` with a TOML parser. Confirm the manifest and package versions agree and declared entrypoint files exist.
- [ ] Check the Linux/macOS and Node 22/24 CI matrix. Review the recorded [verification evidence](verification.md); live agent startup checks do not verify provider login or model inference.
- [ ] Review files and Git history intended for public release, including verification receipts.
- [ ] Put the prepared source and root manifest on the repository's default branch.
- [ ] Confirm the repository is public, is not a fork, and is not archived.
- [ ] Set the GitHub About description and add `herdr-plugin` to the existing topics, preserving unrelated topics.

On September 9, 2026, `gh repo view` confirmed the default branch is `main`, the repository is private, and it is neither a fork nor archived. The description, website, and topics were empty. Attempting to set the suggested description, website, and topics with `gh repo edit` returned HTTP 403 (the token cannot access that operation). A repository administrator must apply those settings and make the repository public for discovery.

Local preparation checks passed: all 49 automated tests and syntax checks, TOML parsing, required metadata, matching package/manifest versions and descriptions, and existence of all eleven action entrypoints and the confirmation pane entrypoint. Remote CI and a fresh GitHub installation have not been verified in this preparation pass.

## Verify discovery and installation

On a host with the documented prerequisites, install from GitHub:

```sh
herdr plugin install superfly/herdr-sprites-plugin
herdr plugin list
herdr plugin action list --plugin sprites
herdr plugin config-dir sprites
```

If this plugin is already locally linked, run `herdr plugin unlink sprites` first. Follow the README to configure the organization and launch an agent from a Git worktree. Check Info to confirm asynchronous setup completed.

Allow up to the next 30-minute index refresh, then find `superfly/herdr-sprites-plugin` in the [marketplace](https://herdr.dev/plugins/). Confirm its Sprites row shows the expected version and links to the root source directory. Herdr rescans when the default-branch head changes. If the listing is missing, recheck visibility, topic, fork/archive status, and required manifest metadata.

Sources: [Herdr marketplace requirements](https://herdr.dev/docs/marketplace/) and [plugin manifest and installation reference](https://herdr.dev/docs/plugins/).

# Getting Started

dsh-tianshu-tui is an interactive terminal UI plugin for the official DeepSeek Harness. This guide takes you from zero to a running TUI. The root README's Install section has the full installation details.

## Prerequisites

- [Node.js](https://nodejs.org/) `>=24.9.0`
- [`pnpm`](https://pnpm.io/installation) on your PATH (`dsh plugin` forwards to it)
- An API key to run models: `DEEPSEEK_API_KEY` (or the official CLI's login flow)

> **Do not type bare `dsh`.** If an old `dsh` is already on your PATH (e.g. `~/.local/bin/dsh` whose `dsh --version` is below `0.2.2-rc.1`), it will hit the local staging path and fail with `ERR_FS_EISDIR` / `Path is a directory .../@deepseek-ai/dsh`. Always use the `npx` commands below.

## Install

```sh
# 1. Add the plugin to the tui profile
npx -y @deepseek-ai/dsh@next plugin --profile tui add @huiliyi37/dsh-tianshu-tui

# 2. Launch
npx -y @deepseek-ai/dsh@next --profile tui
```

You are up when the welcome page shows the **dsh-tianshu-tui** brand. Exit with `Ctrl+Q` or `/exit`.

- pnpm may warn about missing peers — ignore it: peers are provided by the official `dsh` host.
- If the official CLI is installed globally with the right version, replace `npx -y @deepseek-ai/dsh@next` with `dsh`.
- Install from Git: `dsh plugin --profile tui add github:huiliyi37/dsh-tianshu-tui`.

## First Run

After launch you will see:

- **Welcome page**: brand header, friendly session short id, and an environment check (API key / git readiness)
- **Top bar**: `📁 cwd · model · (git branch ●uncommitted-count)`
- **Bottom three lines**: input line (rounded frame) → footer (mode badge + shortcut hints) → metrics line (model / cost / context% / tokens / elapsed)

Type a question and press Enter to start. Common operations:

| What you want | How |
|---|---|
| All shortcuts | `Ctrl+.` |
| Switch model | `/model` (pick with ↑↓) or `/model <provider/model>` |
| Switch theme | `/theme` (pick with ↑↓) |
| New session / resume | `Ctrl+N` / `Ctrl+S` |
| Interrupt the current reply | `Ctrl+C` |
| Exit | `Ctrl+Q` |

## Troubleshooting

**`ERR_FS_EISDIR` / `Path is a directory ...`**
A stale install fallback in `~/.dsh/profiles/node_modules` conflicts with the official CLI. Use a clean directory:

```sh
DSH_HOME=/tmp/dsh-tianshu npx -y @deepseek-ai/dsh@next plugin --profile tui add @huiliyi37/dsh-tianshu-tui
DSH_HOME=/tmp/dsh-tianshu npx -y @deepseek-ai/dsh@next --profile tui
```

**"插件已更新到 …，请重启 dsh 后生效" (plugin updated, please restart)**
The self-update mechanism bumped the profile's package to the new npm version; restart to apply.

**`plugin add` fails with `plugin command failed` (pnpm ≥ 11.7 / 0.2.2 host)**
The 0.2.2 host tree carries native build scripts (node-pty etc.), and pnpm ≥ 11.7
exits 1 while any build is undecided. Open `$DSH_HOME/profiles/tui/pnpm-workspace.yaml`
and set every placeholder in the `allowBuilds` section (`set this to true or false`)
to `false` — except `@deepseek-ai/dsh-subprocess-local: true`, which only chmods
node-pty's prebuilt helper — then re-run `plugin add`.
If a first failed add left the plugin in `dependencies` but not in
`dsh.profile.bundles` (boot shows no TUI and no error), run
`plugin remove @huiliyi37/dsh-tianshu-tui` and `plugin add` again — reconcile only
registers NEW dependencies as bundles.

**Plugin market (dsh-plugin-hub) one-click install fails with `plugin is not installed` ([#60](https://github.com/huiliyi37/dsh-tianshu-tui/issues/60))**
This error is NOT an install failure of this package: `plugin is not installed` is the
marketplace installer's **own** state guard (a precondition check of its uninstall /
reveal endpoints), meaning its cached "installed" view had drifted from the profile
dependency table its server actually reads — no install command was ever executed.
The evidence is in the report itself: "实际执行的安装命令：unknown (no executed
command recorded)" with no "Attempted install channels" section, and the npm
distribution (`lib/index.js` + `cordis.patch.yml`) is complete and was never even
downloaded. The installer misclassifies its own message as a "plugin-side install
failure" and auto-files the issue here. Workaround: install via the one-click script
or the command line above (Windows):

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/huiliyi37/dsh-tianshu-tui/main/scripts/install-tui.ps1 | iex"
```

To help triage the marketplace-side defect, send `~/.dsh/profiles/<profile>/hub.log`
to [dsh-plugin-hub](https://github.com/dshplugin/dsh-plugin-hub).

**No network update check**
Set `DSH_TUI_SKIP_UPDATE=1`.

**Images fail to send / the model says it cannot see them**
When the primary model cannot see images, assemble a vision-bridge plugin (`dsh-vision-bridge`, which provides a `visionBridge` service) or inject vision config; with neither, images are not sent and a warning is shown (intentional fails-loud).

**Need a model-facing LSP tool surface**
Assemble the community plugin [`omdsh-dev/dsh-lsp`](https://github.com/omdsh-dev/dsh-lsp); the TUI display bridge consumes its `lsp` service automatically, sharing the same LSP server set with the model tool surface.

**`/preset` says "agent-presets service unavailable"**
Update to a build that assembles the agent plane (`plugin add` of this package pulls the official preset registry). The command is `/preset`, not `/presets`. Existing profiles pick up the new dependency on self-update.

## Next Steps

- [Interaction](interaction.en.md): full keymap and command reference
- [Configuration](configuration.en.md): assembly options and environment variables
- [Architecture](architecture.en.md): how the TUI works

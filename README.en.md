# dsh-tianshu-tui

**Turn DeepSeek Harness into a complete, fluid coding workspace in your terminal.**

[![npm](https://img.shields.io/npm/v/@huiliyi37/dsh-tianshu-tui.svg)](https://www.npmjs.com/package/@huiliyi37/dsh-tianshu-tui)
[![GitHub release](https://img.shields.io/github/v/release/huiliyi37/dsh-tianshu-tui?include_prereleases)](https://github.com/huiliyi37/dsh-tianshu-tui/releases)
[![Node](https://img.shields.io/node/v/@huiliyi37/dsh-tianshu-tui.svg)](https://www.npmjs.com/package/@huiliyi37/dsh-tianshu-tui)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

[中文](README.md) · English

![dsh-tianshu-tui terminal interface](docs/promo.png)

`dsh-tianshu-tui` is an interactive terminal UI plugin for the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Its lightweight, purpose-built ANSI renderer delivers streaming Markdown, tool cards, session restore and rewind, image and vision bridging, LSP diagnostics, 16 themes, and a complete slash-command and keyboard interface.

It is a **presentation-only plugin**: agent state comes from the session event stream. It does not run a second agent loop or silently inject its own prompts or tools.

## What you get

| Capability | What it enables |
|---|---|
| **Fluid conversations and tool views** | Streaming Markdown, collapsible reasoning, grouped parallel tools, structured diffs, turn timing, and token metrics |
| **A complete session workspace** | Restore, switch, fork, rewind, and export sessions; queue messages while running or steer the active turn |
| **Efficient input** | Slash menu, `@` path completion, history search, multi-line paste, external editor, and optional Vim keybindings |
| **Images and vision** | Paste and preview images inline; vision models receive them directly, while text-only models can use a vision bridge |
| **Agent control panels** | Approval diffs, plan mode, goals, tasks, skills, subagents, and workflow state in one place |
| **A customizable development environment** | 16 themes, LSP diagnostics, project memory, MCP browsing, and live model/reasoning-effort switching |

## Quickstart

### Requirements

| Component | Currently validated version |
|---|---|
| Node.js | `^22.19 || >=24` |
| Package manager | [`pnpm`](https://pnpm.io/installation), available through `corepack enable` |
| DeepSeek Harness | `@deepseek-ai/dsh@0.2.1-rc.4`, published on the npm `next` channel |
| This plugin | `@huiliyi37/dsh-tianshu-tui@1.0.0-rc.3` |

> **Use the host `@next` tag explicitly.** Do not substitute the host `@latest` tag (currently `0.2.1-rc.2`, below the required version). The `@alpha` release `0.2.2-alpha.2` has known API incompatibilities and is not supported yet. This package is not a standalone CLI.

### One-click install (recommended)

The installer checks Node/pnpm, installs the official CLI, wires the plugin, and launches it:

```sh
# macOS / Linux
bash <(curl -fsSL https://raw.githubusercontent.com/huiliyi37/dsh-tianshu-tui/main/scripts/install-tui.sh)
```

```powershell
# Windows PowerShell
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/huiliyi37/dsh-tianshu-tui/main/scripts/install-tui.ps1 | iex"
```

To install without launching, append `--no-launch` on macOS/Linux. On Windows, clone the repository and run `powershell -ExecutionPolicy Bypass -File scripts\install-tui.ps1 -NoLaunch`.

### Manual install

```sh
# 1. Add the plugin to an isolated tui profile
pnpm dlx @deepseek-ai/dsh@next plugin --profile tui add @huiliyi37/dsh-tianshu-tui

# 2. Launch
pnpm dlx @deepseek-ai/dsh@next --profile tui
```

Follow the first-run guide to configure an API key, or enter `/key`. The **dsh-tianshu-tui** welcome screen confirms a successful install. Quit with `Ctrl+Q` or `/exit`.

> If an old global `dsh` causes `ERR_FS_EISDIR`, or npm 11 runs out of heap while installing the large host dependency tree, use the `pnpm dlx` commands above. See [Getting started](docs/getting-started.en.md) for alternative setups and troubleshooting.

## Everyday commands

### Common commands

| Command | Action |
|---|---|
| `/session` | Create, list, switch, or restore sessions |
| `/fork` · `/rewind` | Explore a branch or roll back to a previous message boundary |
| `/model` · `/effort` | Switch the current session's model and reasoning effort |
| `/preset` | Inspect or switch standard / PTC / minimal / creative presets |
| `/status` · `/tasks` · `/subagents` | Inspect goals, tasks, and subagent state |
| `/theme` · `/density` | Change the theme or compact rendering |
| `/scroll` · `/export` | Browse the full transcript or export Markdown |

### Keyboard shortcuts

| Key | Action |
|---|---|
| `Enter` | Send |
| `Shift+Enter` | Newline (or `\`+Enter to continue) |
| `Ctrl+N` | New session |
| `Ctrl+S` | Restore the most recent session |
| `Ctrl+Q` | Quit (same as `/exit`) |
| `Ctrl+P` | Command palette |
| `Ctrl+.` | Full keymap |
| `Ctrl+F` / `Ctrl+R` | History search; `n`/`N` next, `p`/`P` previous |
| `Ctrl+O` | Expand/collapse the latest reasoning block |
| `Ctrl+E` | Edit the input line in `$EDITOR` |
| `Ctrl+T` | Steer the active turn |
| `Ctrl+Enter` | Interrupt the active turn and send the draft (requires kitty keyboard protocol) |
| `Ctrl+C` | Interrupt the active turn; double-press on idle empty input to exit |
| `Ctrl+V` | Paste a clipboard image, falling back to text |
| `Alt+W` | Copy the selection to the system clipboard via OSC52 |
| `Shift+Tab` | Cycle normal → plan → always-approve |
| `Tab` | `@` path completion; accept the slash-menu selection |
| `Ctrl+U` | Delete to line start |
| `↑`/`↓` | Input history; menu selection; empty-input ↑ takes back a queued message |
| `PageUp`/`PageDown` | Slash-menu paging |
| `Esc` | Close a panel or cancel a question; double-press when idle to rewind |
| `t` | Approval card: remember this tool for the session |
| `a` | Approval card: allow for this session |

See the [interaction guide](docs/interaction.en.md) for every command, approval action, Vim binding, and terminal-protocol detail.

## Updating

npm installs check for updates at startup. You can also run `/update` inside the TUI. Set `DSH_TUI_SKIP_UPDATE=1` to disable the startup check.

```sh
pnpm dlx @deepseek-ai/dsh@next plugin --profile tui add @huiliyi37/dsh-tianshu-tui
```

Current release: **[`1.0.0-rc.3`](https://github.com/huiliyi37/dsh-tianshu-tui/releases/tag/v1.0.0-rc.3)**, adapted to host `0.2.1-rc.4`. See [CHANGELOG.md](CHANGELOG.md) for release history, or run `/changelog` inside the TUI.

## Documentation

| Document | What it covers |
|---|---|
| [Getting started](docs/getting-started.en.md) | Installation, launch, clean environments, and troubleshooting |
| [Interaction](docs/interaction.en.md) | Commands, keybindings, panels, and input methods |
| [Configuration](docs/configuration.en.md) | Assembly options, environment variables, presets, and runtime settings |
| [Themes](docs/themes.en.md) | Built-in palettes, custom colors, and terminal fallbacks |
| [Plugin ecosystem](docs/plugins.en.md) | Companion plugins and extension points |
| [Architecture](docs/architecture.en.md) · [Adapter contract](ADAPTER.md) | Layers, event flow, service dependencies, and presentation boundaries |
| [VS Code](docs/vscode.en.md) | Running in the VS Code terminal |
| [Contributing](CONTRIBUTING.en.md) · [Developing](DEVELOPING.md) | Local development, build, test, and release workflows |

## Design principles

- **Event-driven**: all rendered state derives from session events; live rendering and restored transcripts share the same bridge.
- **Presentation boundaries**: no private prompt, tool, or context surfaces, and no direct mutation of agent request bodies.
- **Explicit degradation**: missing optional host services produce an actionable message instead of a blank panel or a startup failure.
- **Terminal-friendly**: supports narrow screens, 16-color terminals, and `NO_COLOR`, with handling for wide CJK text, long output, and streaming refreshes.

See the [architecture guide](docs/architecture.en.md) and [ADAPTER.md](ADAPTER.md) for implementation details and boundary constraints.

## Known limitations

- Re-interrogating images with `ask_image` requires the companion [`vision-ask`](vision-ask/README.md) plugin; basic image submission and vision bridging do not.
- LSP servers start lazily but may remain resident in large repositories; `rootUri` follows the first session's working directory after a session switch.
- Upstream schedule depends on the Web `sessionController`, so this TUI does not mount that tool surface yet.
- Host `0.2.2-alpha.2` changes model-selection and preset APIs. Stay on host `0.2.1-rc.4` until dedicated adaptation work is complete.

## Contributing

Issues and pull requests are welcome. Read the [contribution guide](CONTRIBUTING.en.md) first, then run:

```sh
npm run typecheck
npm test
npm run build
```

## Community ecosystem

| Project | About |
|---|---|
| [dshfind](https://dshfind.com/zh) | Chinese DeepSeek Harness learning and plugin community |
| [dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui) | DSH Web UI plugins and skins |
| [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) | Claude Code-style fullscreen terminal plugin |
| [deepseek-harness-ux](https://github.com/ayuanwong/deepseek-harness-ux) | Focused progress and automatic history folding for long tasks |
| [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | Sidebar workbench for files, terminals, Git, and subagents |
| [DSH Desktop](https://github.com/anywhere-labs/deepseek-harness-desktop) | Community desktop client with remote task control |
| [dsh-whale-report](https://github.com/SenmuuuuW/dsh-whale-report) | Session, cost, tool-call, and risk reports |

## License and provenance

Open source under [Apache-2.0](LICENSE). The terminal renderer evolved from the author's [Tianshu-harness](https://github.com/huiliyi37/Tianshu-harness). See [SOURCE-MAP.md](SOURCE-MAP.md) and [NOTICE](NOTICE) for file-level provenance and modification notices.

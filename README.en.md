# dsh-tianshu-tui — Terminal UI for DeepSeek Harness

[![npm](https://img.shields.io/npm/v/@huiliyi37/dsh-tianshu-tui.svg)](https://www.npmjs.com/package/@huiliyi37/dsh-tianshu-tui)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![node](https://img.shields.io/node/v/@huiliyi37/dsh-tianshu-tui.svg)](https://www.npmjs.com/package/@huiliyi37/dsh-tianshu-tui)
[![release](https://img.shields.io/github/v/release/huiliyi37/dsh-tianshu-tui?include_prereleases)](https://github.com/huiliyi37/dsh-tianshu-tui/releases)

[中文](README.md) | English

![dsh-tianshu-tui](docs/promo.png)

**dsh-tianshu-tui** (`@huiliyi37/dsh-tianshu-tui`) is the interactive terminal UI plugin for the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). The render core is a self-built minimal ANSI engine (evolved from the author's own open-source [Tianshu-Tui](https://github.com/huiliyi37/Tianshu-Tui), Apache-2.0; file-by-file provenance in [SOURCE-MAP.md](SOURCE-MAP.md)), keeping rendering lightweight and non-intrusive. The UI is a pure presentation layer: every piece of agent state arrives through the session event stream. On top of it, the plugin adds harness-level engineering niceties such as image & vision bridging, smart code retrieval, and memory with cross-session recall.


> [!WARNING]
> **Ecosystem boundary**: this plugin belongs to the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) ecosystem (`@deepseek-ai/*` scope) — its peerDependencies and imports all point at `@deepseek-ai/*`. **Do not assemble it into an oh-my-tianshu (`@huiliyi37` scope, CLI `@huiliyi37/dsh-tianshu`) tui profile.** oh-my-tianshu ships its own official TUI, `@huiliyi37/dsh-tui`: the two share 109 of 117 TUI source files but live in different ecosystems. Mixing them makes the plugin resolve `@deepseek-ai/*` at runtime through stale symlinks under `~/.dsh/profiles/node_modules` pointing at the globally installed official dsh — a fragile cross-ecosystem coupling.

## Documentation

| Doc | What it covers |
|---|---|
| [Getting started](docs/getting-started.en.md) | Install, launch, and troubleshooting |
| [Interaction](docs/interaction.en.md) | Full keymap and command reference |
| [Configuration](docs/configuration.en.md) | Assembly options, env vars, runtime config |
| [Architecture](docs/architecture.en.md) | Layers, data flow, design decisions |
| [Themes](docs/themes.en.md) | The 16 built-in palettes and custom themes |
| [Plugin ecosystem](docs/plugins.en.md) | Companion plugins and extension points |
| [VS Code](docs/vscode.en.md) | Running inside VS Code |
| [ADAPTER.md](ADAPTER.md) | TUI ↔ harness boundary contract |
| [Contributing](CONTRIBUTING.en.md) | PR guidelines and the verification matrix |
| [Developing](DEVELOPING.md) | Structure, build, release |

## Install

This package is not a standalone app. You need the official CLI [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh) (npm `latest`, currently `0.1.5-rc.1`; needs ≥ `0.1.5-rc.1`, aligned with the peer deps). `npm i` of this package alone will not run.

**One-click install (recommended)**: the repo ships cross-platform scripts that detect Node/pnpm, install the official CLI via pnpm, wire this plugin and launch (defaults to the npmmirror registry for CN networks):

```sh
# macOS / Linux (bash)
bash <(curl -fsSL https://raw.githubusercontent.com/huiliyi37/dsh-tianshu-tui/main/scripts/install-tui.sh)
# install only, no launch:
bash <(curl -fsSL https://raw.githubusercontent.com/huiliyi37/dsh-tianshu-tui/main/scripts/install-tui.sh) --no-launch

# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/huiliyi37/dsh-tianshu-tui/main/scripts/install-tui.ps1 | iex"
# install only, no launch (after cloning the repo):
powershell -ExecutionPolicy Bypass -File scripts\install-tui.ps1 -NoLaunch
```

### 1. Prerequisites

- [Node.js](https://nodejs.org/) `^22.19 || >=24`
- [`pnpm`](https://pnpm.io/installation) on PATH (`dsh plugin` forwards to it; if missing, `corepack enable` — Node ships corepack)

> ⚠ **npm 11 OOM pitfall**: the official CLI `@deepseek-ai/dsh` has a large dependency tree (60+ sub-packages); **npm 11 (bundled with Node 24) runs out of heap while installing it** (hangs for minutes then `JavaScript heap out of memory` — reproduced). Use pnpm (commands below). If you are already on `npx -y @deepseek-ai/dsh` and it hangs/throws heap OOM, switch to pnpm.

**Do not type `dsh` by itself.** An older `dsh` on PATH (for example `~/.local/bin/dsh`, where `dsh --version` is below `0.1.0-rc.8`) will hit a local staging tree and fail with `ERR_FS_EISDIR` / `Path is a directory .../@deepseek-ai/dsh`. Always use the `pnpm dlx` commands below.

### 2. Add this plugin to the tui profile

```sh
pnpm dlx @deepseek-ai/dsh plugin --profile tui add @huiliyi37/dsh-tianshu-tui
```

pnpm may warn about missing peers; ignore that. Peers come from the official `dsh` host. Without pnpm you can also use `npx -y pnpm dlx @deepseek-ai/dsh plugin --profile tui add @huiliyi37/dsh-tianshu-tui`.

After an npm install, each launch checks npm `latest` and writes a newer version into the profile, then asks you to restart. You can also run `/update` inside the TUI for a manual check (check-only; it prints the update command). Set `DSH_TUI_SKIP_UPDATE=1` to skip the check. `github:` / `link:` installs are left alone.

You can also install from Git: `pnpm dlx @deepseek-ai/dsh plugin --profile tui add github:huiliyi37/dsh-tianshu-tui` (the repository ships `lib/index.js`; no rebuild).

### 3. Start

```sh
pnpm dlx @deepseek-ai/dsh --profile tui
```

Success looks like a welcome screen branded **dsh-tianshu-tui**. Quit with `Ctrl+Q` or `/exit`.

If the official CLI is installed globally (`pnpm add -g @deepseek-ai/dsh`) and `dsh --version` is at least `0.1.0-rc.8`, you can use `dsh` in place of `pnpm dlx @deepseek-ai/dsh`.

### 4. Agent presets (`/preset`)

The command is `/preset` (there is no `/presets`). This bundle matches official web: it disables the host agent plane and mounts `@deepseek-ai/dsh-agent-presets` (pinned `0.1.5-rc.1`; npm `latest` still points at stale `0.0.1-rc.1`). Adding this plugin installs the roster; new sessions `mount` in `setup`. `/preset` switches the official shipped surface (standard / PTC / minimal / creative), rather than stacking on `dsh-base` tools.

Usage:

- `/preset` — list each preset's capability and toolset, `*` marks the current one; the footer / welcome top bar also show the short name (Standard / PTC / Minimal / Creator). After a turn, `wire:` shows the last request's tool surface
- `/preset <id>` — switch to the given preset (blank sessions only: `/session new` first; `ptc`/`creative` alias `code`/`cordis`)

If `npx` still raises `ERR_FS_EISDIR`, stale install fallbacks under `~/.dsh/profiles/node_modules` are colliding with the official CLI. Use a clean home:

```sh
DSH_HOME=/tmp/dsh-tianshu pnpm dlx @deepseek-ai/dsh plugin --profile tui add @huiliyi37/dsh-tianshu-tui
DSH_HOME=/tmp/dsh-tianshu pnpm dlx @deepseek-ai/dsh --profile tui
```

Do not run tsdown for this package from the DeepSeek Harness workspace root: it rewrites imports to unpublished `@deepseek-ai/dsh-root`, and loading fails.

## Coexisting with other distributions

This plugin runs on top of the official DeepSeek Harness (`@deepseek-ai/dsh`) and uses the
official home `~/.dsh`. The standalone integrated distribution **oh-my-tianshu** (formerly
tianshu-public, `@huiliyi37/dsh-tianshu`, a full harness with its own `tianshu` CLI) is a
separate distribution line that uses its own `$DSH_HOME` (`~/.dsh-tianshu` once the
default-home isolation lands) — the two homes are isolated, so both can be **installed side
by side without conflicts** (sessions / profiles / settings stay separate). To coexist, set
`export DSH_HOME=~/.dsh-tianshu` on the tianshu side.

**Naming memo (avoid confusion):**

| Name | What it is |
|---|---|
| `dsh-tianshu-tui` (this plugin) | The TUI plugin for the official dsh (this repo) |
| `oh-my-tianshu` / `@huiliyi37/oh-my-tianshu` (formerly tianshu-public) | Standalone integrated distribution with its own CLI (`oh-my-tianshu`) |
| `Tianshu-Tui` (upstream) | Apache-2.0 source of this plugin's render core |

> Renamed on 2026-08-16: the former `@huiliyi37/dsh-tianshu` (command `tianshu`) is now
> uniformly `@huiliyi37/oh-my-tianshu` (command `oh-my-tianshu`), matching the repo name;
> the old package is deprecated — migrate your install.

The companion vision plugin lives in `vision-ask/` if you need image re-interrogation.

## Release notes

Current npm `latest`: [`@huiliyi37/dsh-tianshu-tui@0.1.2-rc.30`](https://www.npmjs.com/package/@huiliyi37/dsh-tianshu-tui) ([GitHub Release](https://github.com/huiliyi37/dsh-tianshu-tui/releases/tag/v0.1.2-rc.30)).

**0.1.2-rc.30 (2026-09-12)**: host line moves to 0.1.5 (official `latest` is now 0.1.5-rc.1) — streaming events `assistant/chunk`→batched `assistant/attempt`, the new sessionPersistence contract (snapshot list + open/read handles), defensive rendering for missing timestamps in cross-format stores; real-machine pty e2e green. ⚠ Requires host ≥ 0.1.5-rc.1.

**0.1.2-rc.29 (2026-09-09)**: host line moves to 0.1.2-rc.1 (now the official `latest`; fixes #56 boot crash) — `Session.events` removal adapted to `snapshotEvents()`, userQuestions migrated to a waterfall answerer (global registration), `CallId→ToolCallId`, preset `code→ptc`, fork lineage via `isSeeded`+`inheritedEventCount`, bundle patch gains `subagent-model-selection-settings`; older hosts (≤0.1.1-rc.2) fail loud at startup with upgrade/rollback guidance. ⚠ This release requires host ≥ 0.1.2-rc.1.

**0.1.2-rc.28 (2026-08-29)**: vim improvements answering #55 — mode-distinct cursor (block in NORMAL / bar in insert), two-phase history search (queries may contain n/N; `Enter` to confirm then jump; the search target is now labelled), search-term highlight (also in `/scroll`); plus auto-refill of the input line on delivery failure and a README-keymap consistency guard.

**0.1.2-rc.27 (2026-08-29)**: two backports from Tianshu — actionable errors (beyond the full error commit + recovery hint, the last delivered message is auto-refilled into the input line with a `↩` "may not have been fully processed" note; edit and re-send; cleared on successful turns, drafts never clobbered); plan-review decision-card visual layering (dim decision-zone divider + `❯`/success primary-action highlight; rendering byte-identical when no theme is passed).

**0.1.2-rc.26 (2026-08-28)**: the P1 polish six-pack — Esc layering finished (post-abort grace period + armed hint line), a playful verb pool on the glance line, explicit priority-based footer degradation, error recovery hints (every error names the next action), a steadier fixed-height viewport (chrome panels no longer jolt the input track), and fish-style history ghost suggestions (`→` to accept); `/scroll` cap now configurable.



**0.1.2-rc.23 (2026-08-27)**: LSP trio aligned to the tianshu-public 0.6.0 official seam line (single `lsp` tool with four operations + local provider defaulting to tsserver), capability-gated diagnostic source prevents `/lsp` panel regression; host peers aligned to `^0.1.1-rc.2`.

**0.1.2-rc.22 (2026-08-27)**: LSP model tool surface shipped bundled first version (companion plugin auto-inserted; remove the legacy community plugin).

**0.1.2-rc.21 (2026-08-27)**: three community fixes — inverse-video input caret (#50), preset defaults to `standard` (#48), root-cause + upstream report for `malformed SSE payload` (#49).

Full release history: [CHANGELOG.md](CHANGELOG.md) (zh) and [GitHub Releases](https://github.com/huiliyi37/dsh-tianshu-tui/releases). In the TUI, `/changelog` shows the current release (`/changelog all` for everything).

## Highlights

- **Full session workspace in a terminal** — live rendering, append-only scrollback, session restore on startup, `/fork` exploration branches, `/rewind` rollback (session truncation + optional file rollback), `/export` to Markdown transcripts, and mid-turn steering (`/steer` / `Ctrl+T`).
- **End-to-end images** — paste from clipboard (`Ctrl+V` / terminal-menu paste), render as inline terminal graphics (kitty / iTerm2), deliver through the harness attachment service, and let a vision-capable model actually see them — with an automatic vision bridge that describes the image through a separate vision model when the main model cannot see.
- **A complete input surface** — grok-style slash dropdown menu (fuzzy prefix matching, MRU ordering, ghost previews), `@`-path Tab completion and `@mention` expansion, bracketed paste, optional vim keybindings, external editor (`Ctrl+E`), history search (`Ctrl+F`/`Ctrl+R`) — and a full keymap overlay behind `Ctrl+.`.
- **In-terminal interaction surfaces** — structured question panels (numeric selection, plan-review feedback mode), pending approval cards with inline `diff` previews, mode cycle (`Shift+Tab`: normal → plan → always-approve), command palette, and live panels for status / config / skills / tasks / delegation / workflow.
- **Reasoning made visible** — the think channel streams as a live header, folds into a compact scrollback line (`✻ 思考 (3.2s) · 12 行`), and expands in place with `Ctrl+O` (competitor-aligned: collapsed by default).
- **Personalized harness integrations** — `/doctor` terminal diagnostics, `/memory` project-memory browser, `/btw` side questions to a background agent, `/model` + `/effort` hot-switching that takes effect on the current session immediately.
- **Auditable by construction** — the TUI registers no prompt, tool, or context surface of its own; user input becomes ordinary logged messages, and every rendered state derives from session events.
- **Co-evolved with the harness** — built in lockstep with harness-side capabilities on the 2026-08-09 baseline snapshot (250+ commits): the image/vision pipeline, DeepSeek Spark model engineering, session persistence and file snapshots, memory, the validation gate and failure routing, code intelligence, and the git tool. See the next section.

## Co-evolved harness capabilities (since the 2026-08-09 baseline)

The terminal UI evolved from [Tianshu-Tui](https://github.com/huiliyi37/Tianshu-Tui) (Apache-2.0; per-file provenance in [SOURCE-MAP.md](SOURCE-MAP.md)). This bundle then developed in lockstep with harness-side work on the DeepSeek Harness baseline snapshot `snapshots/20260809T140917Z` — 250+ commits between 2026-08-10 and 2026-08-13. The capabilities below live in the host harness (separate packages, not shipped in this bundle); the TUI is their primary interactive surface:

- **Image pipeline & vision bridge** — the `image` ContentBlock joins the merge-extensible content vocabulary and `dsh-llm-deepseek` serializes user image blocks as OpenAI-style `image_url` content parts, so user images reach the wire end-to-end (clipboard → input line → session → model request). Models declare `supportsVision` (`LlmModelInfo` + llm-deepseek catalog). `dsh-vision-bridge` covers text-only main models: at `agent/pre-step` it describes image attachments through a separate vision model (`visionAutoBridge` auto-selects the first vision-capable model when provider/model are omitted; fallback model + data URL validation; the prompt auto-selects between general structure and OCR-level transcription based on UI/error keywords), injecting the description as a plugin-source user message — Model-visible ⟺ logged; bridge failure degrades to a visible hint, never a failed turn.
- **DeepSeek Spark aliases** — the official API has no `spark` model and this host does not register a `deepseek-spark` provider. `/model spark-flash` / `spark-pro` map onto the registered `deepseek-official` route with wire ids `deepseek-v4-flash` / `deepseek-v4-pro`.
- **Session persistence & file snapshots** — `Session.truncate` rewinds the event log and resets derived state; persistence backends gained `deleteFrom` plus a truncate coordinator, so rollback survives reload; `dsh-fs-snapshot` ports FileHistory (trackEdit / rewindToBoundary) and snapshots before write-tool execution. TUI surface: `/rewind` (conversation truncation + optional file rollback).
- **Memory** — `dsh-memory` (MemoryService + Markdown file backend, non-git fallback) and `tool-memory` (`memory_save` / `memory_search` + memory-digest injection) provide cross-session recall. TUI surface: `/memory`, `/remember`.
- **Validation gate & failure routing** — `dsh-evidence-gate` enforces RED-first verification: obligation state machine, edit/verify counters, TDD gate (`enforce` mode), probe suggestions with cooldown, and an L2 final-review gate, natively wired into `str_replace_editor` and the headless-agent assembly. `dsh-agent-router` predicts step failure from turn history and routes work — verification-subagent dispatch and per-profile tool restriction — with real-turn e2e coverage.
- **Code intelligence & retrieval** — `dsh-semantic-index` (BM25 + salience/RRF/vector fusion, incremental updates) exposed as the `semantic_search` tool; `dsh-meridian` code index (node:sqlite schema, tree-sitter parsers for TypeScript/Python/Go, graph/impact/flow queries, behavioral signals, background backfill) exposed as `repo_graph` and the `<codebase-index>` digest; `dsh-pheromone` file-level pheromones with atomic JSON persistence, surfaced through `file_info` and the read tool's `focus` semantics.
- **Git service & tool** — `dsh-git` service seam (GitLocal CLI provider, service-class-as-plugin) plus `dsh-tool-git`, a single model-facing git tool with an operation discriminator (status / diff / log / commit), assembled in the base bundle.

## Features

### Session management

| Capability | Description |
|---|---|
| `/session new\|list\|switch` | Create, list, and switch sessions; resume replays the full transcript through the same render bridge |
| Restore panel | Recoverable sessions are listed in scrollback at startup |
| `/fork [directive]` · `/branch` | Fork the current session (history copied to a new child session) and optionally start it with a directive |
| `/rewind` | Roll back to a chosen message — conversation truncation and/or file rollback to the pre-boundary snapshot |
| `/export` | Export the current session transcript to a Markdown file |
| `/clear` | Clear the scrollback view of the current session |

### Input surface

- **Slash command menu** — typing `/` opens a dropdown with fuzzy prefix matching, `↑↓` / `PageUp` / `PageDown` selection, `Tab` accept, `Enter` submit, MRU ordering, argument-placeholder ghosts, and an input-line ghost preview.
- **Clipboard & image paste** — `Ctrl+V` reads a clipboard image (falling back to text); terminal-menu paste detects images; pasted paths that look like images are loaded as attachments; `Alt+W` / vim yank copies selection to the system clipboard via OSC52.
- **Image submission** — attached images show a `📎 N images` marker, render inline under the user bubble on submit, and reach the model through the attachment service; the bubble carries a vision hint (forwarded / bridged via a vision model / not sent). Oversized pastes are adaptively compressed before send: 1568px long-edge clamp (PNG keeps transparency), degrading JPEG 0.82 → 0.55 → 1024px + 0.55 until under the provider cap, never upscaling.
- **Vim editing ([#51](https://github.com/huiliyi37/dsh-tianshu-tui/issues/51))** — `Esc` enters NORMAL; the keymap mirrors Claude Code: `h j k l / w e b W B E / 0 $ ^ / gg G / f F t T ; ,`, operators `d c y × motion` with counts, text objects `iw aw iW aW`, linewise `dd cc yy Y` plus `p P` paste, `x X D C s S r o O J u .`; `v/V` visual selections include the character under the cursor (vim ownership semantics). Multi-line drafts move column-wise with `j/k`; CJK runs count as single words. Toggle at runtime with `/vim`; `/vim default` makes it the startup default. Insert-mode two-key sequence → Esc mappings (`vimInsertRemaps`, e.g. `{"jj":"esc"}` in prefs; 1s window guards against accidental triggers). Cursor shape follows the mode: block (reverse video) in NORMAL, bar in insert (#55). NORMAL / opens session-history search (two-phase: filter as you type, Enter to confirm then n/N jump — queries may contain n/N).
- **Editing** — external editor (`Ctrl+E`), Tab file completion, `@mention` expansion, input history, multi-line input, and bracketed paste (multi-line / long pastes land in the input line as one block instead of submitting line by line); the input line is drawn as a full rounded frame.
- **Message queue while running (Claude Code queue parity)** — messages submitted while the agent is running enter a local queue shown above the input rail (echoed immediately, not sent); they flush in order at the next turn end, and an aborted turn does not auto-flush (leaving room to take them back with `↑`); empty-input `↑` pops the first queued item back into the input; switching sessions drops the queue with an echo. Mid-turn immediate steering stays on `/steer` / `Ctrl+T`.
- **Image re-interrogation** — the companion `@deepseek-ai/dsh-vision-ask` plugin registers sent images and answers targeted model questions via `ask_image` (see [vision-ask](vision-ask/README.md)).

### Rendering & projection

- **Conversation stream** — markdown rendering, tool-family coloring with per-tool timing, and parallel tool calls folded into groups.
- **Tool cards commit in real time** — settled tool results render as scrollback cards consuming the harness presenter intent: `diff` results as structured red/green file diffs (shared with the approval preview), `terminal` results with command title + cwd + exit/signal badge, everything else as folding cards.
- **Reasoning channel** — shimmer live header while thinking, folded scrollback line at segment end, `Ctrl+O` expands the full text in the live area.
- **Fluency folding** — repetitive routine tool traffic collapses under a quiet strategy; compact mode (`/density`) keeps header-only lines.
- **Turn status** — braille spinner + phase text status line, workflow-run summaries, delegation tree, task pane, config/skills panels as live-region panels; a non-aborted turn with tool calls ends with a dim summary line (`turn N · 读X 改Y · elapsed`) in the scrollback.
- **Subagent runs** — a live spinner line per run; terminal states commit to scrollback as `✓`/`✗`/`◌` entries.
- **Window chrome** — welcome page (brand header, friendly short session ids, environment check line), top bar (cwd + git branch + model), and a three-line bottom area: input line (mode-colored bottom edge) → footer (mode badge + key hints) → metrics line (model / token usage / cache hit rate).
- **Themes** — built-in palettes plus `custom:<name>`; auto terminal detection and 16-color fallbacks; honors `NO_COLOR`; custom themes get contrast warnings on load (WCAG < 3.0 against the declared background, non-blocking).

### Interaction panels

- **Structured questions** — numeric selection, `Esc` cancels, overlap protection; plan-review feedback mode (`f` to enter, `Enter` submits Keep-planning + custom feedback).
- **Approval cards** — `y`/`N`/`Ctrl+C` settle pending approvals; inline diff previews when the tool is diffable; blind-approval hint when the diff is invisible; non-current-session requests delegate to the next listener.
- **Mode cycle** — `Shift+Tab` cycles normal → plan → always-approve; the plan state drives the footer badge, and always-approve is session-local (resets on switch/exit).
- **Live panels** — `/status` (goal/todos/plan projection snapshot; the subagent domains surface under `/subagents`), `/config` (terminal notifications (completion OS notify + BEL bell — the bell still reaches you over SSH) / compact rendering + host settings / permission / credentials), `/skills` browser (↑↓ details), `/tasks` pane, `/subagents` delegation tree, `/workflow` runs. Inspect panels are exclusive; `Esc` closes them. Missing host sections collapse; `/config`'s terminal section does not need the host. Other panels echo a `⚠` warning when their backing service is absent instead of going silently blank.
- **Command palette (`Ctrl+P`) / keymap (`Ctrl+.`) / history search (`Ctrl+F`/`Ctrl+R`) overlays**.

### Models & vision

- `/model` — view and switch the model (default + hot-switch for the current session); `spark-flash` / `spark-pro` aliases map to `deepseek-official` + the official wire ids `deepseek-v4-flash` / `deepseek-v4-pro`. `/model <provider/model|alias> [off|high|max]` sets the reasoning effort in the same command.
- `/effort` — set the reasoning effort (`off` / `high` / `max`; `auto` returns to the model default), hot-switched for the current session.
- **Vision bridge** — vision capability is declared per model (`supportsVision`, auto-refreshed from the llm catalog) and drives the bubble hint; when the main model cannot see images, an automatically selected vision model describes them before submission (one-shot path; see Known Limitations). Bridge availability comes from the assembly layer (`vision.bridgeEnabled`) or from a host vision-bridge plugin providing the `visionBridge` service — the TUI probes service presence before submitting images; with neither, images are not sent and a warning is shown.
- **Vision co-pilot** — with the companion `@deepseek-ai/dsh-vision-ask` plugin (same repository), every sent image is registered under a short id (`img_1`, …) and the model can re-interrogate it with `ask_image` — targeted questions, different angles, any number of times; repeated same-angle asks hit the per-image description cache. Details and config in the [vision-ask README](vision-ask/README.md).
- `/mcp` — list connected MCP servers and tool counts; `tools <name>` inspects a server's tool list.

### Commands

| Command | What it does |
|---|---|
| `/session new\|list\|switch` | Session management (list/picker grouped by today / yesterday / this week / earlier) |
| `/fork [directive]` · `/branch` | Fork the current session, optionally with a starting directive |
| `/rewind` | Two-phase rollback (message list → granularity) |
| `/export [path]` | Export the transcript to Markdown |
| `/scroll` | Pager: browse the transcript in full (scroll / live search / `n`·`N` jump / `g`·`G` top-bottom) |
| `/clear` | Clear the scrollback view |
| `/compact` | Compact the session context |
| `/steer <text>` | Mid-turn steering (correct course without interrupting) |
| `/model [target] [effort]` | View/switch model (aliases: `spark-flash`, `spark-pro`) |
| `/effort off\|high\|max\|auto` | Set reasoning effort (hot-switched) |
| `/theme [name]` | Switch theme |
| `/density` | Toggle compact tool-card rendering |
| `/vim [on\|off\|default]` | Toggle vi/vim editing keybindings; `default` persists as startup default |
| `/status` | Toggle the status panel (goal/todos/plan projections + session totals) |
| `/config [notify [on\|off]]` | Toggle the settings panel (empty-input `n` notify, `d` density). No-arg opens/closes the panel |
| `/skills` | Toggle the skills browser |
| `/tasks` | Task pane (background tasks) |
| `/goal` | Goal management (create / pause / resume / complete / block) |
| `/subagents` | Delegation tree panel |
| `/workflow` | Workflow runs panel |
| `/btw <question>` | Side question to a background agent |
| `/remember <text>` | Save a memory |
| `/memory` | Memory browser (list / filter / delete / preview) |
| `/doctor` | Terminal diagnostics + fix guidance |
| `/mcp [tools <name>]` | List MCP servers; inspect a server's tools |

### Keyboard shortcuts

| Key | Action |
|---|---|
| `Enter` | Send |
| `Shift+Enter` | Newline (or `\`+Enter to continue) |
| `Ctrl+N` | New session |
| `Ctrl+S` | Restore the most recent session |
| `Ctrl+Q` | Quit (same as `/exit`) |
| `Ctrl+P` | Command palette |
| `Ctrl+.` | Keymap overlay |
| `Ctrl+F` / `Ctrl+R` | History search (`n`/`N` next, `p`/`P` previous) |
| `Ctrl+O` | Expand/collapse the latest reasoning block |
| `Ctrl+E` | Open the input line in `$EDITOR` (configurable via `editorKey`) |
| `Ctrl+T` | Mid-turn steering |
| `Ctrl+Enter` | Cut in line: interrupt the in-flight turn and send the draft immediately (requires kitty keyboard protocol support; `RIVET_KITTY_KEYBOARD=1` force-enables it) |
| `Ctrl+C` | Interrupt the in-flight turn (double-press on idle empty input exits) |
| `Ctrl+V` | Paste clipboard image (falls back to clipboard text) |
| `Alt+W` | Copy selection to the system clipboard (OSC52) |
| `Shift+Tab` | Mode cycle: normal → plan → always-approve |
| `Tab` | `@`-path completion; accept the slash-menu selection |
| `Ctrl+U` | Delete to line start |
| `↑`/`↓` | Input history (selection while the slash menu is open; with queued messages, empty-input `↑` takes back the first) |
| `PageUp`/`PageDown` | Slash menu paging |
| `Esc` | Close menu/overlay/inspect panel; cancel a pending question; double-Esc rewind when idle |
| `t` | Approval card: remember this tool (auto-approve for the rest of this session) |
| `a` | Approval card: allow this session (always-approve + settle the current request) |

## Assembly

The bundle patch inserts the `tui-runner` plugin over `dsh-base`:

```yaml
- id: tui-runner
  name: '@huiliyi37/dsh-tianshu-tui'
```

`TuiRunnerConfig` (all optional): `stdin`/`stdout` (stream injection, defaults to process streams), `initialSessionId`, `editorKey` (default `ctrl_e`; `ctrl+o` is reserved for reasoning expansion), `vimEnabled` (default `false`), `vision` (supportsVision / bridgeEnabled / bridgeSource; when omitted, supportsVision auto-refreshes from the llm catalog and bridgeEnabled is auto-probed from the presence of the host `visionBridge` service — a vision-bridge plugin should provide it), `workflowHistoryLimit` (default `50`).

Service dependencies: `sessions`/`agents`/`agentDefaultModel` required (mandatory inject); `goals`/`subagents`/`memory`/`compact`/`tasks`/`skills`/`sessionProjections`/`workflowEngine`/`planMode` optional — when unassembled, the affected commands and panels degrade fails-loud with an availability message, never silently, and never block TUI startup.

## Verification

```sh
npm test
```

## Model Experience

None, as the TUI renders logged session events and forwards ordinary user input; it registers no prompt, tool, or context surface.

#### KV Cache effect

None directly; user input submitted through the TUI becomes ordinary logged messages whose request effects belong to the session and loop packages.

## Known Limitations and Deferred Work

- **LSP bridge runtime limits** — the model tool surface (goto/find/diagnostics) ships bundled (`@huiliyi37/dsh-lsp` companion plugin, auto-inserted by the bundle patch); deeper integrations like Tianshu's edit-diff diagnostics-narrowing remain future work. Servers slower than the timeout (default 2s) silently yield no diagnostics until the file is touched again; large-repo tsserver stays resident (lazy start mitigates, no idle reclaim); switching sessions does not restart servers (rootUri follows the first session's cwd).
- **Image re-interrogation requires the companion plugin** — the `ask_image` tool and the session image registry live in `@deepseek-ai/dsh-vision-ask` (same repository, separate package); the TUI bundle itself does not ship them. Without the plugin, an already-sent image cannot be re-queried and repeated same-angle descriptions re-call the vision model; the vision bridge still covers the one-shot submit-time description path.
- **app.ts monolith (~3.2k lines)** — the pending-state state machines are controller-ized (question/approval), while render composition and key arbitration remain in app.ts; the C4 split plan (pure-function panel segments) keeps advancing.
- **Projection layer partially wired** — of the four pure fold models, turn-summary (turn/end summary line) and summary-state (the `/status` session-totals section, which keeps working even when the host projection bus is absent) are wired; activity-status/activity-store stay deliberately unwired (the statusline is a self-contained projection, so replacing it buys nothing; activity-store has no current consumer). Current state is recorded in [docs/projection-layer.md](docs/projection-layer.md).

## License & Provenance

Apache-2.0. The terminal render engine evolved from [Tianshu-Tui](https://github.com/huiliyi37/Tianshu-Tui) (Apache-2.0); per-file provenance and modification statements live in [SOURCE-MAP.md](SOURCE-MAP.md) and [NOTICE](NOTICE).

## Friends

| Project | About |
|---|---|
| [dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui) | Plugin and skin collection for DSH Web UI |
| [dshfind](https://dshfind.com/zh) | Chinese learning and sharing community for DeepSeek Harness |
| [deepseek-harness-ux](https://github.com/ayuanwong/deepseek-harness-ux) | Long agent tasks without transcript clutter: focused progress, auto-folded history |
| [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) | Claude Code-style fullscreen interactive terminal plugin |
| [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | Full sidebar workbench: third-party tabs, files/terminal/Git/subagents |
| [DSH Desktop](https://github.com/anywhere-labs/deepseek-harness-desktop) | Community desktop client for DeepSeek Harness (Electron; Windows x64 / macOS Apple Silicon installers) — download and run, no Node.js/pnpm setup. Ships a managed local Harness host with its plugin system, plus iOS/Android remote control to dispatch tasks and track agent progress. Community project, unaffiliated with DeepSeek (MIT) |
| [dsh-meme-hub](https://github.com/the-beating-light-of-the-nail/dsh-meme-hub) | A tour of playful DSH plugins (28 projects, with screenshots) |
| [dsh-whale-report](https://github.com/SenmuuuuW/dsh-whale-report) | Turns sessions, tokens, cost, tool calls, risks and anomalies into Agent reports you can actually read |

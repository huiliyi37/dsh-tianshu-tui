# Configuration

dsh-tianshu-tui has three configuration layers: **assembly config** (`TuiRunnerConfig`, injected by the host), **environment variables** (process level), and **runtime config** (commands/panels inside the TUI).

## Assembly Config (TuiRunnerConfig)

All fields are optional and injected by whoever assembles the plugin:

| Field | Default | Description |
|---|---|---|
| `stdin` / `stdout` | process streams | Keyboard input stream / render output stream (used for test doubles) |
| `initialSessionId` | new session | Session id to attach to on startup |
| `editorKey` | `ctrl_e` | External-editor trigger key (`ctrl+o` is reserved for reasoning expansion) |
| `vimEnabled` | `false` | Enable Vim keybindings |
| `vision.supportsVision` | auto-refreshed from the llm catalog | Whether the primary model sees images natively (images sent directly) |
| `vision.bridgeEnabled` | auto-detected from the host `visionBridge` service | Whether a separate vision-bridge model is configured |
| `vision.bridgeSource` | — | Bridge source (configured / auto / none) |
| `workflowHistoryLimit` | `50` | Settled-run cache cap for the `/workflow` panel (drop-oldest) |
| `activityBand` | `true` | Unified activity band above the input track; `false` restores per-run spinner rows |
| `activityBandMaxRows` | `5` | Activity-band item-row cap (positive integer; overflow folds to `+N`) |
| `lsp.enabled` | `true` | LSP diagnostics toggle (local language-service bridge) |
| `lsp.timeoutMs` | `2000` | Per-diagnostics-fetch timeout |

### Assembling agent presets (`/preset`)

This package's `cordis.patch.yml` inserts official `agent-presets` (`default: standard`) and disables the host agent-plane rows that the shipped `standard` preset remounts. `plugin add` of this package also installs `@deepseek-ai/dsh-agent-presets@0.1.1-rc.2`. The command is `/preset`; there is no `/presets`. New sessions `mount` in `setup`; a blank `/preset <id>` uses official `recompose`.

## Environment Variables

| Variable | Description |
|---|---|
| `DEEPSEEK_API_KEY` | API key (welcome page / status line check it via credentials layering) |
| `DSH_TUI_SKIP_UPDATE` | `1` skips the startup npm update check |
| `DSH_TUI_SKIP_NOTIFY` | `1`/`true` disables OS notifications and locks the `/config` toggle |
| `EDITOR` / `VISUAL` | Command for the `Ctrl+E` external editor (`.cmd`/`.bat` supported on Windows) |
| `HTTP_PROXY` / `HTTPS_PROXY` | Network proxy (self-update and other network operations) |

## Runtime Configuration

### `/config` Panel

`/config` opens the settings panel. The terminal section is always first; empty host sections are omitted.

- **terminal**: OS notify (`●` on / `○` off) and compact rendering. Empty-input `n` toggles notify, `d` toggles density (both write `prefs.json`); or `/config notify` / `notify on` / `notify off`. Notify is locked off when `DSH_TUI_SKIP_NOTIFY` is set; `d` still works.
- **host settings**: output of the host settings service's `describe` (omitted when empty)
- **permission**: permission-preset selector (composes `dsh-permission`'s `PermissionSelect`; omitted when the service is missing)
- **credentials**: credential presence (existence only, never plaintext; omitted when empty)

### Common Runtime Setting Commands

| Command | Effect |
|---|---|
| `/theme [name] [default]` | Switch theme (Enter/args=this session; S or trailing `default`=startup default) |
| `/density [default]` | Toggle compact rendering (toggle=this session; `/density default`=startup default) |
| `/model [target] [effort] [default]` | View/switch model (Enter/args=this session; S or `default`=startup default) |
| `/effort off\|high\|max\|auto\|default` | Reasoning effort (args=this session; S or `default`=startup default) |
| `/preset [name] [default]` | Switch agent preset (args=this session; trailing `default`=new-session startup default) |
| `/welcome [star\|retro]` | Switch welcome page style (`star` new whale-and-star + pixel title, default / `retro` classic small whale; no args=show current; takes effect on next launch) |
| `/yolo [on\|off]` | Always-approve mode (equivalent to Shift+Tab into always-approve) |
| `Shift+Tab` | Mode cycle: normal → plan → always-approve |

### Persistence

- Model/effort startup defaults persist through `agentDefaultModel.saveSelection` (picker S or trailing `default`); typed switches only hot-apply the current session. always-approve is a session-local state that resets on switch/exit.
- On session restore, input history and the session list come from the host persistence (`sessionPersistence`).

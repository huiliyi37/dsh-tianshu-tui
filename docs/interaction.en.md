# Interaction Manual

All of dsh-tianshu-tui's interactions: shortcuts, commands, input surfaces, and interactive panels.

## Shortcuts

### Sessions & Global

| Key | Action |
|---|---|
| `Ctrl+N` | New session |
| `Ctrl+S` | Resume the most recent session |
| `Ctrl+X` | Session tab bar: switch to the next session (cyclic) |
| `Alt+1`~`Alt+9` | Session tab bar: jump to the Nth session |
| `Ctrl+Q` | Exit (same as `/exit`; when idle, two `Ctrl+C`s on an empty input also exit) |
| `Ctrl+.` | Keymap overlay (always available) |
| `Ctrl+P` | Command palette (fuzzy search + Enter to fill) |
| `Ctrl+F` / `Ctrl+R` | History search (filter as you type; after `Enter`, `n`/`N` next, `p`/`P` previous) |

When there is more than one session, a **session tab bar** appears above the input rail (short-id list, current session marked ●; narrow widths drop the oldest tabs and fold into `+N`).

### Input

| Key | Action |
|---|---|
| `Ctrl+E` | Open the input line in `$EDITOR` (configurable via `editorKey`) |
| `Ctrl+T` | Steer mid-turn (correct direction without interrupting) |
| `Ctrl+Enter` | Cut in line: interrupt the in-flight turn and send the draft immediately (cancel-and-send; requires kitty keyboard protocol support, `RIVET_KITTY_KEYBOARD=1` force-enables it) |
| `Ctrl+V` | Paste a clipboard image (falls back to clipboard text when none) |
| `Alt+W` | Copy the selection to the system clipboard (OSC52) |
| `Tab` | `@`-path completion; accept the slash-menu selection |
| `↑`/`↓` | Input history (menu selection when the slash menu is open; with queued messages, empty-input `↑` takes back the first) |
| `→` (at end of input) | Accept the history-suggestion ghost (fish-style: dim remainder of the most recent history entry matching the input prefix; `/` input defers to the slash ghost; disable via the `ghostSuggest` pref) |
| `PageUp`/`PageDown` | Page through the slash menu |
| `Esc` | Close menus/overlays/inspect panels; cancel a pending question |

### Replies & Tools

| Key | Action |
|---|---|
| `Ctrl+C` | Interrupt the in-flight turn (immediate) |
| `Esc` (in flight) | Interrupt the in-flight turn (Claude Code-style single Esc; lone ESC has an 80ms debounce; overlays/menus/inspect panels still close first when open) |
| `Esc` (inspect panel) | Close `/config` `/skills` `/status` `/lsp` `/tasks` (even with a draft; does not arm rewind) |
| `Esc`+`Esc` (idle) | Open the rewind panel (Claude Code's Esc+Esc time travel; 1s double-press window, same as `/rewind`; the first press shows a "press Esc again for rewind" hint, and a 1s grace period after interrupting a turn prevents accidental arming) |
| `Ctrl+O` | Expand/collapse the most recent reasoning block |
| `Enter` (empty input) | Toggle expansion of the last in-flight tool card (shows argument JSON) |
| `Shift+Tab` | Mode cycle: normal → plan → always-approve |

Above the input track, running work folds into one activity band (`◐ N subagents · M workflows` plus one stats line per item, capped by `activityBandMaxRows`). A finished subagent commits `✓ {label} · N tools · X tok · 12s`; a finished workflow commits a one-line summary. Set `activityBand: false` to restore per-run spinner rows.

### Interactive Panels

| Key | Action |
|---|---|
| `y` | Approval card: allow once |
| `p` | Approval card: don't ask again for this command prefix (bash-like tools only; same-prefix commands auto-allowed for this session) |
| `t` | Approval card: remember this tool (this tool auto-allowed for this session) |
| `a` | Approval card: allow for this session (always-approve + settle the current request) |
| `n` | Approval card: reject |
| `f` → `Enter` | Approval card: reject with feedback (the text is steered to the agent; Esc returns to the options) |
| `Esc` / `Ctrl+C` | Approval card: cancel |
| `f` → `Enter` | Plan-review feedback mode (Keep planning + custom feedback) |
| Digits | Structured-question panel options |
| In pickers: `↑`/`↓` (j/k) select, `Enter` apply (this session), `S` save default, `Esc`/`q` close | `/model` `/theme` `/effort` pickers (session/`/key` pickers have no S) |
| Session list: grouped today / yesterday / this week / earlier, then printed | `/session list` |
| Session picker: `↑`/`↓` (skips group headers) | No-arg `/session` picker (calendar groups + title / relative age, not paginated) |

## Command Reference (40 commands)

### Sessions

| Command | Effect |
|---|---|
| `/session new\|list\|switch <id>` | Session management (no args opens the session picker) |
| `/fork [directive]` · `/branch` | Fork the current session (history copied to a new child) |
| `/rewind` | Two-stage rollback (session truncation + optional file rewind) |
| `/export [path]` | Export the transcript as Markdown |
| `/scroll` | Pager: browse the transcript in full (↑↓/PgUp/PgDn scroll, live search, `n`/`N` jump, `g`/`G` top/bottom) |
| `/clear` | Clear the scrollback view |
| `/compact` | Compact session context (requires the compact service) |

### Models & Modes

| Command | Effect |
|---|---|
| `/model [target] [effort] [default]` | View/switch model (no args opens the picker; Enter=this session, S or trailing `default`=startup default; aliases `spark-flash`/`spark-pro`) |
| `/effort off\|high\|max\|auto\|default` | Set reasoning effort (no args opens the picker; Enter/args=this session, S or `default`=startup default; `auto` follows the model default) |
| `/preset [name] [default]` | View/switch agent preset (lists capability + toolset per mode; footer/top bar show the current short name; args=this session's full agent plane; trailing `default`=new-session startup default; blank sessions only; aliases `ptc`→code, `creative`→cordis) |
| `/yolo [on\|off]` | Always-approve mode |
| `/density [default]` | Toggle compact tool-card rendering (toggle=this session; `/density default`=startup default) |
| `/glance [segment]` | Toggle footer metrics segments (e.g. `/glance cost`; no args shows current state) |
| `/info` | Cycle input-area info density: `full` two lines (status + metrics, default) / `compact` status line only / `off`; persisted |
| `/vim [on\|off\|default]` | Toggle vi/vim editing keybindings (`default` persists as startup default) |
| `/welcome [blue\|star\|retro]` | Switch welcome page style (blue=blue whale holding star + block title, default / star=purple whale + pixel title / retro=classic small whale; no args=show current; takes effect on next launch) |

### Authentication

| Command | Effect |
|---|---|
| `/key` · `/login` | Configure a provider API key (pick provider → masked input + online validation; takes effect on save; `/login` is an alias) |

### Panels

| Command | Effect |
|---|---|
| `/status` | Status panel (goal/todos/plan projection + session totals) |
| `/todos [all]` | Todo card above the input rail (no-arg toggles; `all` shows the full list). Default: in-progress first, up to 5 items; all-completed collapses to one line. First non-empty model write auto-opens it; closing or `/clear` disables auto-open for the rest of the session |
| `/config [notify [on\|off]]` | Settings panel (OS notify/density on top; empty-input `n`/`d`. Inspect panels are exclusive; Esc closes) |
| `/skills` | Skill browser (empty-input ↑↓/j/k expands the selected skill) |
| `/tasks [kill <id>]` | Task panel |
| `/goal` | Goal management (create/pause/resume/complete/block) |
| `/subagents` | Delegation-tree live cards (in-flight body, failed state; optional “⤷ external subagent” section) |
| `/workflow` | Workflow runs panel (roster appends the child-session label / running state when `childId` hits the tree) |
| `/lsp` | LSP diagnostics panel |

### Memory & Diagnostics

| Command | Effect |
|---|---|
| `/remember <text>` | Save a project memory |
| `/memory [delete <id>]` | Memory browser |
| `/btw <question>` | Ask a background agent (without interrupting) |
| `/doctor` | Terminal diagnostics + fix guide |
| `/mcp [tools <name>]` | List MCP servers and their tools |
| `/help [cmd]` | Command help (no arg opens the command palette for grouped browsing + filtering; `/help <cmd>` shows one entry) |
| `/changelog [all\|N]` | Version history (current release by default; `all` for everything; `N` for the last N) |
| `/cost` | Current-session cumulative usage and cost estimate (per model) |

### Other

| Command | Effect |
|---|---|
| `/theme [name] [default]` | Switch theme (no args opens the picker; Enter/args=this session, S or trailing `default`=startup default) |
Custom themes (`~/.dsh-tui/themes/*.json`) get contrast warnings on load (WCAG < 3.0 against the declared background, non-blocking); `NO_COLOR` suppresses all theme color output.
| `/steer <text>` | Steer mid-turn |
| `/restart` | Restart the current dsh process (same command re-launched; applies plugin updates) |
| `/update` | Check for plugin updates (against npm latest; check-only, prints the update command when a newer version exists) |
| `/exit` | Exit the TUI |

## Input Surfaces

- **Slash menu**: typing `/` opens it; fuzzy prefix matching, MRU ordering, Tab to accept, Enter to submit, argument ghost preview.
- **@ references**: `@` triggers path completion (Tab), expanding to file summaries on submit (@mention), with cwd boundary and truncation fallbacks.
- **Image paste**: `Ctrl+V` or the terminal menu; oversized images are adaptively compressed before sending (1568px long-edge cap, progressive JPEG downscaling).
- **Multiline input & bracketed paste**: pasting multiline/long text lands whole in the input line instead of submitting line by line.
- **Vim keybindings**: optional (`vimEnabled`); `Alt+W`/yank copies the selection via OSC52. Insert-mode two-key sequence → Esc (`vimInsertRemaps`, e.g. `{"jj":"esc"}` in prefs; 1s window guards misfires). Cursor shape follows the mode: block (reverse video) in NORMAL, bar in insert (#55; `|` on the ASCII track).
- **Message queue while running (CC queue parity)**: submits during a running turn enter a local queue above the input rail (echoed, not sent); flushed in order at turn end; aborted turns do not flush; empty-input `↑` takes back the first; switching sessions drops it with an echo. Immediate steering stays on `/steer`/`Ctrl+T`; `Ctrl+Enter` cuts in line (interrupt first, then send; needs kitty keyboard enhancement).

## Interactive Panels

- **Approval card**: pending approvals with inline diff preview (y/p/t/a/n/f/esc); red/green rendering when the tool is diffable, a `$ command` preview with danger-pattern warnings for bash, blind-approval hint otherwise. Decision ladder: `y` allow once · `p` don't ask again for this command prefix (bash only) · `t` remember this tool · `a` allow everything this session · `n` reject · `f` reject with feedback (text is steered to the agent; Esc returns) · `esc` cancel; non-current-session requests are delegated to the next listener.
- **Question panel**: digit selection, Esc to cancel, overlap protection; plan-review feedback mode (feedback goes through the real input line — full cursor editing and paste). The decision card carries a dim divider and a success-highlighted primary action (❯ on the approve option).
- **Actionable errors**: agent errors commit in full with a recovery-hint tail (401→`/key`, context overflow→`/compact`, timeout→`↑`); when the input line is empty the last delivered message is auto-refilled with a `↩` note ("may not have been fully processed") — edit and re-send. Cleared on successful turns; drafts are never clobbered.
- **Pickers (issue #31)**: no-arg `/model` `/theme` `/effort` `/session` open a picker with the current value marked ● and the startup default ★. `/model` `/theme` `/effort`: Enter applies this session only; S applies and writes the startup default. Session and `/key` pickers have no S. **The theme picker previews live**: ↑/↓ switches the theme immediately, Enter settles without writing prefs, S writes the startup default, Esc restores the theme from before opening.
- **Command palette (Ctrl+P)**: fuzzy + subsequence command search, Enter fills `/cmd `.
- **Keymap panel (Ctrl+.)**: the full shortcut list, always one key away.
- **History search (Ctrl+F / Ctrl+R, vim NORMAL `/`)**: two-phase — the edit phase filters as you type (every character incl. n/N goes into the query, #55); `Enter` confirms and enters the jump phase (`n`/`N` next, `p`/`P` previous, `Enter` again returns to editing). Matched terms are highlighted in-line (reverse video).

## Overlay System

Full-screen overlays (command palette, keymap, history search, rewind, memory browser, pager, picker) share one lifecycle: opening enters the alt screen, Esc/Ctrl+C closes, and deferred scrollback is flushed on close. Streaming output never covers an open overlay.

# pi-zellij-editor

Edit pi prompts in a live zellij pane without blocking pi's TUI.

`pi-zellij-editor` replaces pi's blocking Ctrl+G external-editor workflow. Press
Ctrl+G in pi's prompt editor to open the current prompt in your editor (`nvim`
by default) inside a zellij pane. When the editor exits, the edited text is
read back into pi's prompt.

Pi stays visible and resize-aware in the original pane while the editor pane is
open. The prompt is locked during editing so it cannot be mutated in two places
at once.

This is the zellij counterpart to [kyleqbnguyen/split-editor](https://github.com/kyleqbnguyen/split-editor),
which provides the same workflow for tmux.

## Requirements

- pi
- zellij
  - Linux/macOS: 0.39+ (for `--block-until-exit`)
  - Windows: 0.44+ (native Windows support landed in 0.44.0)
- A terminal editor. Defaults to `$VISUAL`, then `$EDITOR`, then `nvim`. Override
  with the `editor` option (see [Configuration](#configuration)).

## Platform notes

### Windows

On Windows, zellij uses ConPTY and runs the editor as a direct process spawn
(no shell in between). The extension passes the editor command and file path
through `zellij action new-pane` as a structured argv list, so the editor sees
the file path as a normal argument regardless of whether your temp directory
lives at `C:\Users\You\AppData\Local\Temp\...` (with backslashes) or whether
your username contains spaces.

If your `editor` config points at a Windows path with spaces, quote it:

```json
{
  "editor": "\"C:\\Program Files\\Neovim\\bin\\nvim.exe\""
}
```

zellij itself can be configured with `default_shell` in `~/.config/zellij/config.kdl`
if you want PowerShell or pwsh as the default shell for new panes.

## Installation

From a local checkout:

```bash
pi install /path/to/pi-zellij-editor
```

For development:

```bash
pi -e .
```

## Usage

1. Start pi inside zellij with this package loaded.
2. Type a prompt.
3. Press Ctrl+G.
4. Edit in a new zellij pane (a horizontal split beside pi by default).
5. Save and quit the editor.
6. The pane closes automatically and the edited text replaces the pi prompt.

Pressing Ctrl+G again while the editor pane is already open will not open a
second editor.

Outside zellij, the extension falls back to pi's default Ctrl+G behaviour (a
blocking external editor in the same TTY) and shows a one-time warning.

## Configuration

Configuration is read each time Ctrl+G opens the editor pane, so file/env
changes are picked up without reloading the extension.

Options:

| Option          | Env var                          | Default                         | Description                                                                                       |
| --------------- | -------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `editor`        | `ZELLIJ_EDITOR_EDITOR`           | `$VISUAL` / `$EDITOR` / `nvim`  | Editor command to run in the zellij pane.                                                         |
| `floating`      | `ZELLIJ_EDITOR_FLOATING`         | `false`                         | Open as a centered floating pane (`true`) or an embedded split (`false`, the default).            |
| `direction`     | `ZELLIJ_EDITOR_DIRECTION`        | `horizontal`                    | Split direction for embedded splits: `horizontal` opens to the right, `vertical` opens below. Ignored when floating. |
| `height`        | `ZELLIJ_EDITOR_HEIGHT`           | `70%`                           | Floating pane height (zellij accepts bare integer or percent, e.g. `70%` or `20`). Ignored when not floating. |
| `width`         | `ZELLIJ_EDITOR_WIDTH`            | `70%`                           | Floating pane width. Ignored when not floating.                                                   |
| `showIndicator` | `ZELLIJ_EDITOR_SHOW_INDICATOR`   | `true`                          | Show `ZELLIJ EDITOR OPEN` in the editor border while locked.                                      |

Precedence, lowest to highest:

1. Defaults
2. Global config: `~/.pi/agent/extensions/zellij-editor.json`
3. Global pi settings: `~/.pi/agent/settings.json` under `zellijEditor`
4. Project config: `.pi/zellij-editor.json`
5. Project pi settings: `.pi/settings.json` under `zellijEditor`
6. Environment variables

Standalone config files use the options directly:

```json
{
  "editor": "nvim",
  "floating": false,
  "direction": "horizontal",
  "showIndicator": true
}
```

Pi `settings.json` uses a `zellijEditor` object:

```json
{
  "zellijEditor": {
    "editor": "hx",
    "floating": false,
    "direction": "vertical",
    "showIndicator": false
  }
}
```

Environment example:

```bash
ZELLIJ_EDITOR_EDITOR="hx" \
ZELLIJ_EDITOR_FLOATING=false \
ZELLIJ_EDITOR_DIRECTION=vertical \
ZELLIJ_EDITOR_SHOW_INDICATOR=false \
pi
```

`ZELLIJ_EDITOR_FLOATING` and `ZELLIJ_EDITOR_SHOW_INDICATOR` accept `1`, `true`,
`yes`, `on`, `0`, `false`, `no`, or `off`.

`ZELLIJ_EDITOR_DIRECTION` accepts `horizontal` (or `h`) to open the editor to
the right, and `vertical` (or `v`) to open it below.

### Floating pane mode

Set `floating: true` (or `ZELLIJ_EDITOR_FLOATING=true`) to open the editor as
a centered floating pane on top of pi. In this mode `width` and `height` are
honored (default `70%` each) and `direction` is ignored. The pane still
auto-closes on editor exit.

## Notes and limitations

- Requires zellij for live pane behavior; falls back to pi's default external
  editor outside zellij.
- The pi prompt editor ignores input while the zellij pane owns the editable
  copy.
- If the editor exits non-zero, the temp file is still read back into pi and a
  warning is shown.
- Temporary files are removed on a best-effort basis after the editor closes.
- Only the same-tab pane model is supported. The editor opens in the current
  zellij tab, next to (or on top of) pi.

## Related

- [split-editor](https://github.com/kyleqbnguyen/split-editor) — the original
  tmux version this extension is patterned after.

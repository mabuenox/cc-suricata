# cc-suricata · Claude Code Watcher

All your Claude Code sessions on one local page, at a glance: what each one is doing, which one is waiting for you, which one is asking you something, model, context usage, background tasks and agents. Sends a Windows notification when a session finishes its turn or asks you a question.

It does not touch Claude Code's configuration: it reads `~/.claude/sessions/*.json` (the registry of live sessions) and `~/.claude/projects/**/*.jsonl` (transcripts) and reacts to file system changes.

## Usage

```
npx github:mabuenox/cc-suricata
```

Starts the server at <http://localhost:4747> and opens your browser. Options:

- `PORT=5000 npx github:mabuenox/cc-suricata` changes the port.
- `--no-open` does not open the browser.
- `--once` prints the sessions as JSON and exits.

Keyboard: `↑` `↓` move, `↵` open the panel, `esc` close it. "open" next to an edited file opens it in VS Code (`code` must be on the PATH).

## What it shows

- Groups: *Need you* (a session is asking you a question), *Waiting for you* (turn finished) and *Working* (running, or with background tasks).
- Per session: name, git branch, what it is doing now, model and permission mode, context usage, time open, prompts and turns, generated tokens and time in the current state.
- Panel: last answer rendered as markdown, last prompt, background commands, edited files.

## Limitations

- The context bar estimates the window (200k, or 1M once it exceeds 200k): Claude Code does not expose it.
- A session stopped at a permission dialog is not distinguished (the registry only says busy/idle).
- The interface is in Spanish.

## Cross-platform TODO

Built and tested on Windows only. On macOS and Linux the server starts and the page works, but these parts are Windows-specific (`server.mjs`, line numbers approximate):

- [ ] **Notifications** (`notifyChanges`, `notify.ps1`): skipped outside Windows. Add `osascript -e 'display notification …'` (or `terminal-notifier`) on macOS and `notify-send` on Linux, picking the command by `process.platform`.
- [ ] **Git branch** (`gitBranch`): the UNC guard only accepts `C:\…` paths, so the branch is always empty on POSIX. Accept absolute POSIX paths there (`path.isAbsolute`) and keep the UNC rejection for Windows only.
- [ ] **Edited file paths** (`readTranscript`): paths are made relative to the session folder with a hard-coded `\`. Use `path.sep`.
- [ ] **Open in VS Code** (`CODE_EXE`): looks for `Code.exe` next to the PATH entry. On POSIX spawn `code` from the PATH directly (no shell).
- [ ] **Sessions registry**: `~/.claude/sessions/*.json` and the `tmpdir()` filter for plugin-spawned sessions are assumed to have the same layout on every OS. Verify on macOS/Linux.
- [ ] **`fs.watch` recursive** on `~/.claude/projects`: supported on macOS and on Linux with Node ≥ 20; verify it fires on new session files.
- [ ] Opening the browser already handles `win32`, `darwin` (`open`) and the rest (`xdg-open`).

## Development

```
git clone https://github.com/mabuenox/cc-suricata
cd cc-suricata
node server.mjs
```

No dependencies. `server.mjs` is the server (SSE at `/events`), `index.html` the page, `notify.ps1` the notification.

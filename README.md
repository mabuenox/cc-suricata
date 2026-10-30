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

- Native notifications on Windows only (Windows PowerShell 5.1).
- The context bar estimates the window (200k, or 1M once it exceeds 200k): Claude Code does not expose it.
- A session stopped at a permission dialog is not distinguished (the registry only says busy/idle).
- The interface is in Spanish.

## Development

```
git clone https://github.com/mabuenox/cc-suricata
cd cc-suricata
node server.mjs
```

No dependencies. `server.mjs` is the server (SSE at `/events`), `index.html` the page, `notify.ps1` the notification.

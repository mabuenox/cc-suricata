## How we write code

Goal: robust software — easy to read, test, maintain, extend and delete.

### Principles

- Passes the tests
- Reveals intent
- Avoid duplicated knowledge
- The fewest elements the better
- Easy to delete: a module can be removed or replaced without dragging half the system along
- Avoid accidental complexity
- KISS and YAGNI: No optimizing before measuring.
- Follow SOLID, above all dependency inversion: database, HTTP, file system, framework, storage, external providers and LLMs sit behind an interface declared in the business layer. In this project that boundary is a function parameter, not an interface: readers take a path, `derive()` is pure (see "This project").
- Prefer Composition over inheritance. High cohesion, low coupling: each module has one clear responsibility and a small interface.
- Follow DRY done right: unify only **real** duplication (same purpose, changes together). Leave **accidental** duplication (looks alike, changes for different reasons). Duplication is cheaper than the wrong abstraction.
- Follow Law of Demeter
- Follow Tell don't ask
- Follow Command Query Separation (a method changes state or returns a value, not both)
- Follow GRASP to assign responsibilities
- Respect Principle Of Least Surprise

### Readability

- Code for humans before clever code: the next reader has no context, or is an agent with a fresh
  session.
- Names that explain intent. If a comment explains **what** the code does, rename instead; comments
  are only for the **why**. 

### Errors and edges

- Validate arguments on entry with guard clauses and descriptive exceptions.
- Never return `null` to signal an error. Be strict about what you return (empty list,
  Option/Result or exception). Absence is not an error: a `find*` may return `null` for "not there",
  and a decorative value (the git branch) returns `''` when there is nothing to show. Neither hides a failure:
  an unexpected error (not `ENOENT`/`ENOTDIR`) is logged before the empty value is returned.
- Handle nulls, empties, limits and errors. Fail clearly and without losing data.

### Tests

- Every new or changed piece of business or application logic comes with tests. 
- Test first for logic when the problem allows it; never test first with an e2e test. The page has no tests: it is checked by hand in the browser.
- Test code gets the same care as production code. 
- Each test checks one thing.

### Before finish
- Leave no silent debt: if something is done wrong on purpose, explain why in a comment or an ADR.
- Review your change for code smells (long functions, duplication, feature envy, primitive obsession, dead code, unclear names) and fix them before calling it done.

## Investigating and diagnosing

When researching how something works or looking for the cause of a problem, never state a cause,
a mechanism or a number you haven't checked.

## Language

All code, comments, identifiers, log messages, exception messages, and documentation must be in English.

## This project

cc-suricata (`npx cc-suricata`): a local page that shows every Claude Code session on the machine. It never talks to your sessions; it reads the files Claude Code writes under `~/.claude` and reacts to file system changes. The one call it makes is its own `claude -p` for the summary, with hooks, MCP, tools and persistence off so it leaves nothing under `~/.claude` (see `insights.mjs`). No dependencies. Developed on Windows; Linux is checked in Docker, macOS cannot be tried by the author.

### Layout

- `server.mjs`: entry point. Watchers, SSE, the HTTP routes, spawning the notification and VS Code. Not importable (it binds a port at import), so nothing with logic lives here.
- `platform.mjs`: what differs per OS, as pure functions that return argv: `notifyCommand` (`notify.ps1` / `osascript` / `notify-send`) and `findVsCode` (`Code.exe` next to the PATH entry on Windows, the `code` launcher elsewhere).
- `transcript.mjs`: reads one transcript (`~/.claude/projects/<project>/<sessionId>.jsonl`). `readTranscript` walks the tail backwards; `tally` walks forwards and incrementally; `derive` is pure and turns registry + transcript into the state the page shows.
- `insights.mjs`: the findings (three threshold rules over the live sessions, most urgent first: the page shows only the first, as "Next"), their `signature` (what makes the summary stale), and the prompt and argv of the `claude -p` that writes the summary. The prompt forbids repeating what the list shows: it asks for patterns, anomalies and what to do first. Pure; `server.mjs` caches and spawns, the page asks for `/summary` only while visible and keeps the paragraph's height reserved so the list does not jump.
- `sessions.mjs`: the live registry (`~/.claude/sessions/<pid>.json`), the closed-session index (`~/.claude/history.jsonl`) and the prompt search over it, `gitBranch`, `openTarget`. Paths are parameters so tests run on fixtures.
- `index.html`, `style.css`, `app.js`: the page. `app.js` is a classic script with global state on purpose: fake sessions are injected from the browser console for screenshots. Do not turn it into a module.
- `notify.ps1`: the Windows toast (Windows PowerShell 5.1 only).
- `hooks/register.tsx`, `types/index.d.ts`, `.claude-plugin/`: the Claude Code plugin (a "mod": a hooks module with no Node and no DOM, everything through `$`). It polls `GET /snapshot` (its contract with the server: live sessions without `events`, the findings, the cached summary) every 5 s, leaves out the session it runs in, and draws a band above the prompt with the first finding, the status line counts, a toast on a transition into `waiting`, and the `/suricata` pane. Functions that take `$` must be top-level declarations and `atom` refs literal, or `claude plugin validate .` refuses the module. When the server does not answer it runs `node <plugin root>/server.mjs --daemon`, at most once a minute. `.claude-plugin/types/` is written by the engine when a session loads the plugin: ignored, and what `tsconfig.json` extends. Tests: `hooks/register.test.tsx`, run by `claude plugin test .` (not by `node --test`). Distribution: the plugin is the whole repository (`source: "./"` in `marketplace.json`), so it carries the server it starts; the npm package carries nothing of the plugin (its files are not in `files`, on purpose: Claude Code does not install plugins from npm). The README's "Two ways to get it" table is the user-facing statement of this; keep both in step.
- `test/`: `node:test`, no framework. `test/fixtures/*.jsonl` are minimal transcripts in the real record shape, one per case that broke once. The transcript format is undocumented and changes without notice: when a parser bug appears, add the fixture that reproduces it before fixing.
  - `tally` and the closed-session cache are keyed by path or id and live for the process: use one fixture file per case and unique ids per test.
  - A fixture must end with a newline: `tally` keeps the last unterminated line as "still being written" and never parses it. `.gitattributes` keeps fixtures LF so string assertions hold on Windows.
  - Do not put helper `.mjs` files under `test/`: `node --test` would run them as tests. Keep helpers inside the test files.

### Working here

- `npm test` runs everything. `node server.mjs --once` prints the current snapshot (`{ sessions, findings, recent }`) as JSON; `node server.mjs --no-open` serves it on <http://localhost:4747>. OS notifications are off unless `--notify` is given. `USAGE` in `server.mjs` is the one list of flags (`--help` prints it, an unknown flag is refused): a new flag goes there, in `FLAGS`, and in the README's Usage.
- `claude --plugin-dir <path to this folder>` starts a session with the plugin, hot-reloaded on every save; `claude plugin validate .` and `claude plugin test .` check it without one.
- `PORT=4748 node server.mjs --no-open` runs a second instance for testing a change without stopping the one in use.
- `docker run --rm -v "$PWD:/app:ro" node:22 bash /app/scripts/linux-check.sh` (from Git Bash: prefix `MSYS_NO_PATHCONV=1`) runs the Linux check: unit tests, then the server against a fake `~/.claude` with fake `notify-send` and `code` on the PATH. Run it after touching `platform.mjs`, path handling, or the watchers.
- Every runtime file must be listed in `files` in `package.json`: npm publishes only that list, and a missing file breaks `npx cc-suricata` while `node server.mjs` still works locally.
- Anything the user sees (page, toasts, README screenshots) is in English. Screenshots in `docs/` are taken with injected fake data; never with real session names.
  To take one: open the page, and in the browser console run `es.close()`, assign `sessions = [...]` (live rows plus `status: 'closed'` rows), set `selectedId` and `peekOpen = true`, call `render()`. Closed rows get their timeline from `closedEvents.set(id, events)`.
- A `shortcut:` comment marks a known limit and when to lift it. Keep the form `shortcut: <the limit>, <when to upgrade>`.
- Commits follow Conventional Commits: `fix:` and `feat:` drive the version and the changelog (release-please); `refactor:`, `test:`, `docs:`, `ci:`, `chore:` do not appear in it. Merging the release PR publishes to npm from GitHub Actions; the tests run before that publish.
- Security boundaries to keep: the server only answers `Host: localhost`/`127.0.0.1` and `/summary` and `/open` refuse `Sec-Fetch-Site: cross-site` (another site in your browser cannot trigger them; reads stay open so a link from elsewhere to the page works); `/open` only opens files the watcher listed and spawns VS Code (`Code.exe` or `code`) without a shell; the summary spawns `claude` without a shell, fixed argv, the prompt over stdin, from the temp folder; a worktree `gitdir:` that resolves to a UNC path is rejected; CDN scripts carry SRI hashes; GitHub Actions are pinned to a SHA.
- Known debt, by design: the context window is estimated (200k, or 1M above that); a turn that ends in a question to the user is drawn as working in the timeline; the macOS notifier (`osascript`) is covered by unit tests only, never run by the author (see "Platforms" in the README).
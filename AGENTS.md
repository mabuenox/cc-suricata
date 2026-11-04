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

cc-suricata (`npx cc-suricata`): a local page that shows every Claude Code session on the machine. It never talks to Claude Code; it reads the files Claude Code writes under `~/.claude` and reacts to file system changes. No dependencies, Windows first.

### Layout

- `server.mjs`: entry point. Watchers, SSE, the HTTP routes, Windows notifications. Not importable (it binds a port at import), so nothing with logic lives here.
- `transcript.mjs`: reads one transcript (`~/.claude/projects/<project>/<sessionId>.jsonl`). `readTranscript` walks the tail backwards; `tally` walks forwards and incrementally; `derive` is pure and turns registry + transcript into the state the page shows.
- `sessions.mjs`: the live registry (`~/.claude/sessions/<pid>.json`), the closed-session index (`~/.claude/history.jsonl`), `gitBranch`, `openTarget`. Paths are parameters so tests run on fixtures.
- `index.html`, `style.css`, `app.js`: the page. `app.js` is a classic script with global state on purpose: fake sessions are injected from the browser console for screenshots. Do not turn it into a module.
- `notify.ps1`: the Windows toast (Windows PowerShell 5.1 only).
- `test/`: `node:test`, no framework. `test/fixtures/*.jsonl` are minimal transcripts in the real record shape, one per case that broke once. The transcript format is undocumented and changes without notice: when a parser bug appears, add the fixture that reproduces it before fixing.

### Working here

- `npm test` runs everything. `node server.mjs --once` prints the current snapshot (`{ sessions, recent }`) as JSON; `node server.mjs --no-open` serves it on <http://localhost:4747>.
- Every runtime file must be listed in `files` in `package.json`: npm publishes only that list, and a missing file breaks `npx cc-suricata` while `node server.mjs` still works locally.
- Anything the user sees (page, toasts, README screenshots) is in English. Screenshots in `docs/` are taken with injected fake data; never with real session names.
- A `shortcut:` comment marks a known limit and when to lift it. Keep the form `shortcut: <the limit>, <when to upgrade>`.
- Commits follow Conventional Commits: `fix:` and `feat:` drive the version and the changelog (release-please); `refactor:`, `test:`, `docs:`, `ci:`, `chore:` do not appear in it. Merging the release PR publishes to npm from GitHub Actions; the tests run before that publish.
- Security boundaries to keep: the server only answers `Host: localhost`/`127.0.0.1`; `/open` only opens files the watcher listed and spawns `Code.exe` without a shell; a worktree `gitdir:` that resolves to a UNC path is rejected; CDN scripts carry SRI hashes; GitHub Actions are pinned to a SHA.
- Known debt, by design: the context window is estimated (200k, or 1M above that); a session blocked on a permission prompt looks busy; a turn that ends in a question to the user is drawn as working in the timeline; notifications and `Code.exe` lookup are Windows-only (see the README's cross-platform TODO).
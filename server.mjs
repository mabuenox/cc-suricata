#!/usr/bin/env node
// Claude Code Suricata: reads ~/.claude/sessions (live state) and ~/.claude/projects
// (transcripts) and serves them on localhost over SSE.
// No dependencies. `npx cc-suricata`, `--once` (prints the JSON and exits), `--no-open` (does not open the browser).
import { readFileSync, readdirSync, watch, statSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { readTranscript, tally, derive } from './transcript.mjs'

const PORT = Number(process.env.PORT ?? 4747)
const CLAUDE = join(homedir(), '.claude')
const SESSIONS = join(CLAUDE, 'sessions')
const PROJECTS = join(CLAUDE, 'projects')
const HERE = dirname(fileURLToPath(import.meta.url))

const transcriptPaths = new Map() // sessionId -> path of the jsonl

function findTranscript(sessionId) {
  if (transcriptPaths.has(sessionId)) return transcriptPaths.get(sessionId)
  for (const dir of readdirSync(PROJECTS)) {
    const p = join(PROJECTS, dir, `${sessionId}.jsonl`)
    if (existsSync(p)) {
      transcriptPaths.set(sessionId, p)
      return p
    }
  }
  return null
}

// Closed sessions: history.jsonl (one line per prompt with project, sessionId and timestamp) is the cheap index;
// the transcript, which no longer changes, has its tail read once for title, last answer and model.
const history = { size: 0, bySession: new Map() } // sessionId -> { project, first, firstAt, lastAt, n }
function readHistory() {
  try {
    const path = join(CLAUDE, 'history.jsonl')
    const size = statSync(path).size
    if (size === history.size) return history.bySession
    history.size = size
    history.bySession = new Map()
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      let r
      try {
        r = JSON.parse(line)
      } catch {
        continue
      }
      const h = history.bySession.get(r.sessionId) ?? { project: r.project, first: r.display, firstAt: r.timestamp, n: 0 }
      h.n++
      h.lastAt = r.timestamp
      history.bySession.set(r.sessionId, h)
    }
  } catch {}
  return history.bySession
}
const closedCache = new Map() // sessionId -> readTranscript(), or null when the transcript is gone
function recentSessions(live) {
  const liveIds = new Set(live.map((s) => s.sessionId))
  const out = []
  for (const [id, h] of [...readHistory()].sort((a, b) => b[1].lastAt - a[1].lastAt)) {
    if (liveIds.has(id)) { closedCache.delete(id); continue } // resumed: the cached data would be stale when it closes again
    if (!h.project || h.project.toLowerCase().startsWith(tmpdir().toLowerCase())) continue
    if (!closedCache.has(id)) closedCache.set(id, findTranscript(id) ? readTranscript(findTranscript(id), h.project) : null)
    const t = closedCache.get(id)
    if (!t?.lastAnswer) continue // empty sessions (just a /clear, a /resume…) add nothing
    out.push({ ...t, sessionId: id, cwd: h.project, name: t.title ?? h.first.split('\n')[0].slice(0, 80), startedAt: h.firstAt, updatedAt: h.lastAt, prompts: t.prompts ?? h.n, status: 'closed', background: [], agents: 0, currentTool: null, waitingQuestion: null, branch: null })
    if (out.length === 20) break
  }
  return out
}

// Git branch of the folder without running git: reads .git/HEAD (or a worktree's gitdir).
function gitBranch(cwd) {
  try {
    let gitDir = join(cwd, '.git')
    if (!statSync(gitDir).isDirectory()) gitDir = readFileSync(gitDir, 'utf8').replace(/^gitdir:\s*/, '').trim()
    gitDir = resolve(cwd, gitDir) // relative to the worktree; resolved before looking at the root
    if (!/^[A-Za-z]:\\/.test(gitDir)) return null // a UNC path (\\host\…) would make a network request with credentials
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    return head.startsWith('ref: refs/heads/') ? head.slice(16) : head.slice(0, 7)
  } catch {
    return null
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readSessions() {
  const list = []
  for (const f of readdirSync(SESSIONS)) {
    if (!f.endsWith('.json')) continue
    let s
    try {
      s = JSON.parse(readFileSync(join(SESSIONS, f), 'utf8'))
    } catch {
      continue
    }
    // Skip sessions that are not yours: plugins' `claude -p` runs (remember-summarizer…) start from the temp folder.
    if (s.kind !== 'interactive' || !isAlive(s.pid) || !s.cwd || s.cwd.toLowerCase().startsWith(tmpdir().toLowerCase())) continue
    const path = findTranscript(s.sessionId)
    list.push({ ...derive(s, readTranscript(path, s.cwd), path ? tally(path) : undefined), branch: gitBranch(s.cwd) })
  }
  return list.sort((a, b) => b.updatedAt - a.updatedAt)
}

// --- Windows notifications on state changes ---
const lastStatus = new Map()
function notifyChanges(sessions) {
  if (process.platform !== 'win32') return // shortcut: the native toast is Windows only; osascript on macOS and notify-send on Linux would do
  for (const s of sessions) {
    const prev = lastStatus.get(s.sessionId)
    lastStatus.set(s.sessionId, s.status)
    if (prev === undefined || prev === s.status || s.status === 'busy' || s.status === 'background') continue
    const text = String(s.waitingQuestion || s.lastAnswer?.text || 'Finished').split('\n').find((l) => l.trim()) ?? 'Finished'
    try {
      spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'notify.ps1')], {
        env: { ...process.env, CC_TITLE: `${s.name ?? s.cwd}: ${s.status === 'waiting' ? 'is asking you' : 'has finished'}`, CC_TEXT: text.slice(0, 200) },
        stdio: 'ignore',
      }).unref()
    } catch (err) {
      console.error('notification failed:', err.message)
    }
  }
}

const snap = () => {
  const sessions = readSessions()
  return { sessions, recent: recentSessions(sessions) }
}

if (process.argv.includes('--once')) {
  console.log(JSON.stringify(snap(), null, 2))
  process.exit(0)
}

// --- server ---
// The real Code.exe (bin\code.cmd would need cmd.exe): looked up once on the PATH.
const CODE_EXE = (process.env.PATH ?? '').split(';').map((d) => join(d, '..', 'Code.exe')).find((p) => existsSync(p)) ?? null
const clients = new Set()
let snapshot = snap()
let timer = null
function refresh() {
  clearTimeout(timer)
  timer = setTimeout(() => {
    snapshot = snap()
    notifyChanges(snapshot.sessions)
    const data = `data: ${JSON.stringify(snapshot)}\n\n`
    for (const res of clients) res.write(data)
  }, 300)
}
watch(SESSIONS, refresh)
watch(PROJECTS, { recursive: true }, (_, file) => file?.endsWith('.jsonl') && refresh())
setInterval(refresh, 15_000) // in case a watcher misses something, and to keep the "X min ago" column current

createServer((req, res) => {
  // Only from this machine: a remote site cannot read this through DNS rebinding.
  if (![`localhost:${PORT}`, `127.0.0.1:${PORT}`].includes(req.headers.host)) {
    res.writeHead(403).end()
    return
  }
  // Open an edited file in VS Code: only the ones the watcher listed for that session.
  if (req.method === 'POST' && req.url === '/open') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try {
        const { sessionId, file } = JSON.parse(body)
        const s = [...snapshot.sessions, ...snapshot.recent].find((x) => x.sessionId === sessionId)
        if (!s || !s.editedFiles.includes(file)) throw new Error('file not listed')
        const abs = isAbsolute(file) ? file : join(s.cwd, file)
        if (!statSync(abs).isFile()) throw new Error('not a file')
        if (!CODE_EXE) throw new Error('VS Code is not on the PATH')
        spawn(CODE_EXE, ['--goto', abs], { stdio: 'ignore', windowsHide: true }).unref() // no shell: the path is not interpreted
        res.writeHead(204).end()
      } catch (err) {
        res.writeHead(400).end(err.message)
      }
    })
    return
  }
  // Timeline of a closed session: its transcript is read in full only when you open it.
  if (req.url.startsWith('/timeline?id=')) {
    const id = req.url.slice(13)
    try {
      if (!snapshot.recent.some((x) => x.sessionId === id)) throw new Error('not listed')
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(tally(findTranscript(id)).events))
    } catch {
      closedCache.delete(id) // the transcript is gone (Claude Code cleanup): out of the list on the next refresh
      res.writeHead(404).end()
    }
    return
  }
  if (req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`)
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }
  // Own files (index.html, icon.svg…): plain names from this folder only.
  const file = req.url === '/' ? 'index.html' : req.url.slice(1).split('?')[0]
  const type = { html: 'text/html; charset=utf-8', svg: 'image/svg+xml', css: 'text/css', js: 'text/javascript' }[file.split('.').pop()]
  if (!type || !/^[\w.-]+$/.test(file) || !existsSync(join(HERE, file))) {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, { 'Content-Type': type })
  res.end(readFileSync(join(HERE, file)))
}).listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`
  console.log(`Claude Code Suricata at ${url}`)
  if (process.argv.includes('--no-open')) return
  const open = { win32: ['cmd.exe', ['/c', 'start', '', url]], darwin: ['open', [url]] }[process.platform] ?? ['xdg-open', [url]]
  spawn(...open, { stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref()
})

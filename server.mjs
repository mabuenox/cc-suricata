#!/usr/bin/env node
// Claude Code Suricata: reads ~/.claude/sessions (live state) and ~/.claude/projects
// (transcripts) and serves them on localhost over SSE.
// No dependencies. `npx cc-suricata`, `--once` (prints the JSON and exits), `--no-open` (does not open the browser).
import { readFileSync, readdirSync, watch, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { readTranscript, emptyTranscript, tally, derive } from './transcript.mjs'
import { gitBranch, readHistory, isOwnSession, isAlive, recentSessions, forgetClosed, openTarget } from './sessions.mjs'
import { notifyCommand, findVsCode } from './platform.mjs'

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
    if (!isOwnSession(s, tmpdir()) || !isAlive(s.pid)) continue
    const path = findTranscript(s.sessionId)
    const t = path ? readTranscript(path, s.cwd) : emptyTranscript() // a session has no transcript during its first seconds
    list.push({ ...derive(s, t, path ? tally(path) : undefined), branch: gitBranch(s.cwd) })
  }
  return list.sort((a, b) => b.updatedAt - a.updatedAt)
}

// --- desktop notifications on state changes ---
const lastStatus = new Map()
function notifyChanges(sessions) {
  for (const s of sessions) {
    const prev = lastStatus.get(s.sessionId)
    lastStatus.set(s.sessionId, s.status)
    if (prev === undefined || prev === s.status || s.status === 'busy' || s.status === 'background') continue
    const text = String(s.waitingQuestion || s.lastAnswer?.text || 'Finished').split('\n').find((l) => l.trim()) ?? 'Finished'
    const n = notifyCommand(process.platform, `${s.name ?? s.cwd}: ${s.status === 'waiting' ? 'is asking you' : 'has finished'}`, text.slice(0, 200), HERE)
    if (!n) return // no notifier known for this platform
    try {
      spawn(n.cmd, n.args, { env: { ...process.env, ...n.env }, stdio: 'ignore', windowsHide: true })
        .on('error', (err) => console.error('notification failed:', err.message)) // e.g. notify-send not installed
        .unref()
    } catch (err) {
      console.error('notification failed:', err.message)
    }
  }
}

const snap = () => {
  const sessions = readSessions()
  return { sessions, recent: recentSessions(readHistory(join(CLAUDE, 'history.jsonl')), new Set(sessions.map((s) => s.sessionId)), findTranscript, tmpdir()) }
}

if (process.argv.includes('--once')) {
  console.log(JSON.stringify(snap(), null, 2))
  process.exit(0)
}

// --- server ---
const CODE_EXE = findVsCode(process.platform, process.env.PATH ?? '', existsSync) // looked up once
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
        const abs = openTarget([...snapshot.sessions, ...snapshot.recent], sessionId, file)
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
      forgetClosed(id) // the transcript is gone (Claude Code cleanup): out of the list on the next refresh
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

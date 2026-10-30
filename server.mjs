// Centro de sesiones de Claude Code: lee ~/.claude/sessions (estado vivo) y
// ~/.claude/projects (transcripts) y los sirve en localhost con SSE.
// Sin dependencias. `node server.mjs` o `node server.mjs --once` (imprime el JSON y sale).
import { readFileSync, readdirSync, watch, openSync, readSync, closeSync, statSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import { spawn } from 'node:child_process'

const PORT = Number(process.env.PORT ?? 4747)
const CLAUDE = join(homedir(), '.claude')
const SESSIONS = join(CLAUDE, 'sessions')
const PROJECTS = join(CLAUDE, 'projects')
const HERE = dirname(fileURLToPath(import.meta.url))
const TAIL_BYTES = 512 * 1024
const MAX_TEXT = 1500

const transcriptPaths = new Map() // sessionId -> ruta del jsonl

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

// Líneas del fichero de atrás adelante, leídas por trozos: un transcript grande solo se lee hasta donde haga falta.
function* linesFromEnd(path) {
  const size = statSync(path).size
  const fd = openSync(path, 'r')
  try {
    let end = size
    let carry = Buffer.alloc(0) // principio cortado de la última línea del trozo anterior
    while (end > 0) {
      const start = Math.max(0, end - TAIL_BYTES)
      let buf = Buffer.alloc(end - start)
      readSync(fd, buf, 0, buf.length, start)
      buf = Buffer.concat([buf, carry])
      const cut = start > 0 ? buf.indexOf(10) + 1 : 0 // la primera línea puede estar cortada (en bytes, por UTF-8)
      carry = buf.subarray(0, cut)
      yield* buf.subarray(cut).toString('utf8').split('\n').reverse()
      end = start
    }
  } finally {
    closeSync(fd)
  }
}

const clip = (s) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '…' : s)

// Recorre el transcript de atrás adelante y saca lo que la tarjeta muestra.
function readTranscript(sessionId, cwd = '') {
  const path = findTranscript(sessionId)
  const out = {
    title: null, lastPrompt: null, lastAnswer: null, currentTool: null, waitingQuestion: null, lastTurnEndedAt: null,
    model: null, contextTokens: null, permissionMode: null, prompts: null, turns: null, agents: 0, editedFiles: [], outputTokens: 0,
    background: [], // tareas lanzadas con run_in_background que aún no han notificado su fin
  }
  if (!path) return out
  const resolved = new Set()
  const notified = new Set() // tool_use ids y task ids de tareas en background cuya notificación de fin ya llegó, o paradas con TaskStop
  const taskOf = new Map() // tool_use id -> task id, del resultado "Command running in background with ID: x"
  let pendingTool = null
  let scanned = 0
  for (const line of linesFromEnd(path)) {
    if (!line) continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    scanned++
    if (r.type === 'ai-title' && !out.title) out.title = r.aiTitle
    if (r.type === 'file-history-delta' && r.trackingPath && out.editedFiles.length < 8) {
      const p = r.trackingPath.toLowerCase().startsWith(cwd.toLowerCase() + '\\') ? r.trackingPath.slice(cwd.length + 1) : r.trackingPath
      if (!out.editedFiles.includes(p)) out.editedFiles.push(p)
    }
    if (r.isSidechain) continue
    const content = r.message?.content
    if (r.type === 'user') {
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') : ''
      // Solo lo que tecleaste: fuera avisos de tareas, mensajes de otras sesiones e interrupciones (sin origin).
      if (text && r.origin?.kind === 'human' && !out.lastPrompt) {
        out.lastPrompt = { text: clip(text), at: r.timestamp }
        out.permissionMode = r.permissionMode ?? null
        out.prompts = (r.turnPosition?.promptIndex ?? -1) + 1
        out.turns = (r.turnPosition?.turnIndex ?? -1) + 1
      }
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type !== 'tool_result') continue
          resolved.add(c.tool_use_id)
          const body = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((x) => x.text ?? '').join('\n') : ''
          const id = body.match(/running in (?:the )?background(?: with ID| as)[: ]+@?([\w-]+)/i)?.[1]
          if (id) taskOf.set(c.tool_use_id, id)
        }
      }
      for (const m of text.matchAll(/<(?:tool-use-id|task-id)>([^<]+)<\/(?:tool-use-id|task-id)>/g)) notified.add(m[1])
    }
    if (r.type === 'assistant' && Array.isArray(content)) {
      const u = r.message.usage
      if (!out.model && u) {
        out.model = r.message.model
        out.contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      }
      if (r.message.stop_reason === 'end_turn' && !out.lastTurnEndedAt) out.lastTurnEndedAt = r.timestamp
      for (const c of content) {
        if (c.type === 'text' && c.text.trim() && !out.lastAnswer) out.lastAnswer = { text: clip(c.text.trim()), at: r.timestamp }
        if (c.type === 'tool_use' && c.name === 'TaskStop') notified.add(c.input?.task_id ?? c.input?.shell_id)
        if (c.type === 'tool_use' && c.input?.run_in_background === true && !notified.has(c.id) && !notified.has(taskOf.get(c.id))) {
          const isAgent = c.name === 'Agent'
          if (isAgent) out.agents++
          out.background.push({ tool: c.name, label: clip(String(isAgent ? c.input.description ?? '' : c.input.command ?? c.input.description ?? '')).split('\n')[0], at: r.timestamp })
        } else if (c.type === 'tool_use' && !resolved.has(c.id)) {
          if (c.name === 'Agent') out.agents++
          if (!pendingTool) {
            pendingTool = c
            if (c.name === 'AskUserQuestion') out.waitingQuestion = c.input?.questions?.[0]?.question ?? '(pregunta)'
            else out.currentTool = c.name
          }
        }
      }
    }
    // Lo esencial está en las últimas líneas; los ficheros editados pueden estar más atrás, pero no vale la pena leer todo el transcript.
    if (out.lastPrompt && out.lastAnswer && out.title && out.lastTurnEndedAt && (out.editedFiles.length >= 8 || scanned > 1500)) break
  }
  out.outputTokens = outputTokens(path)
  return out
}

// Tokens generados por la sesión: suma acumulada, leyendo solo lo que el transcript ha crecido desde la última vez.
const tokenTally = new Map() // path -> { offset, total, rest }
function outputTokens(path) {
  const t = tokenTally.get(path) ?? { offset: 0, total: 0, rest: '' }
  const size = statSync(path).size
  if (size < t.offset) Object.assign(t, { offset: 0, total: 0, rest: '' }) // fichero reescrito
  if (size > t.offset) {
    const buf = Buffer.alloc(size - t.offset)
    const fd = openSync(path, 'r')
    try {
      readSync(fd, buf, 0, buf.length, t.offset)
    } finally {
      closeSync(fd)
    }
    const lines = (t.rest + buf.toString('utf8')).split('\n')
    t.rest = lines.pop() // última línea, quizá a medias
    for (const line of lines) {
      if (!line.includes('"output_tokens"')) continue
      try {
        t.total += JSON.parse(line).message?.usage?.output_tokens ?? 0
      } catch {}
    }
    t.offset = size
    tokenTally.set(path, t)
  }
  return t.total
}

// Rama git de la carpeta, sin lanzar git: lee .git/HEAD (o el gitdir de un worktree).
function gitBranch(cwd) {
  try {
    let gitDir = join(cwd, '.git')
    if (!statSync(gitDir).isDirectory()) gitDir = readFileSync(gitDir, 'utf8').replace(/^gitdir:\s*/, '').trim()
    if (/^(\\\\|\/\/)/.test(gitDir)) return null // una ruta UNC haría una petición de red con credenciales
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
    // Fuera las sesiones que no son tuyas: los `claude -p` de plugins (remember-summarizer…) corren desde la carpeta temporal.
    if (s.kind !== 'interactive' || !isAlive(s.pid) || !s.cwd || s.cwd.toLowerCase().startsWith(tmpdir().toLowerCase())) continue
    const t = readTranscript(s.sessionId, s.cwd)
    // shortcut: el registro solo dice busy/idle; la espera de permiso no se ve, solo la de AskUserQuestion. Revisar si el registro gana un estado "waiting".
    // El registro trae busy/idle y, a veces, valores transitorios; para la página todo lo que no es idle es "trabajando".
    const status = t.waitingQuestion ? 'waiting' : s.status === 'busy' ? 'busy' : t.background.length ? 'background' : s.status === 'idle' ? 'idle' : 'busy'
    list.push({ ...s, ...t, status, rawStatus: s.status ?? null, statusSince: t.waitingQuestion ? null : s.statusUpdatedAt, branch: gitBranch(s.cwd) })
  }
  return list.sort((a, b) => b.updatedAt - a.updatedAt)
}

// --- notificaciones de Windows al cambiar de estado ---
const lastStatus = new Map()
function notifyChanges(sessions) {
  for (const s of sessions) {
    const prev = lastStatus.get(s.sessionId)
    lastStatus.set(s.sessionId, s.status)
    if (prev === undefined || prev === s.status || s.status === 'busy' || s.status === 'background') continue
    const text = String(s.waitingQuestion || s.lastAnswer?.text || 'Ha terminado').split('\n').find((l) => l.trim()) ?? 'Ha terminado'
    try {
      spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'notify.ps1')], {
        env: { ...process.env, CC_TITLE: `${s.name ?? s.cwd}: ${s.status === 'waiting' ? 'te pregunta' : 'ha terminado'}`, CC_TEXT: text.slice(0, 200) },
        stdio: 'ignore',
      }).unref()
    } catch (err) {
      console.error('notificación fallida:', err.message)
    }
  }
}

if (process.argv.includes('--once')) {
  console.log(JSON.stringify(readSessions(), null, 2))
  process.exit(0)
}

// --- servidor ---
// Code.exe real (bin\code.cmd necesitaría cmd.exe): se busca una vez en el PATH.
const CODE_EXE = (process.env.PATH ?? '').split(';').map((d) => join(d, '..', 'Code.exe')).find((p) => existsSync(p)) ?? null
const clients = new Set()
let snapshot = readSessions()
let timer = null
function refresh() {
  clearTimeout(timer)
  timer = setTimeout(() => {
    snapshot = readSessions()
    notifyChanges(snapshot)
    const data = `data: ${JSON.stringify(snapshot)}\n\n`
    for (const res of clients) res.write(data)
  }, 300)
}
watch(SESSIONS, refresh)
watch(PROJECTS, { recursive: true }, (_, file) => file?.endsWith('.jsonl') && refresh())
setInterval(refresh, 15_000) // por si un watcher se pierde algo y para el "hace X min"

createServer((req, res) => {
  // Solo desde el propio equipo: un sitio remoto no puede leer esto vía DNS rebinding.
  if (![`localhost:${PORT}`, `127.0.0.1:${PORT}`].includes(req.headers.host)) {
    res.writeHead(403).end()
    return
  }
  // Abrir en VS Code un fichero editado: solo los que el watcher ha listado para esa sesión.
  if (req.method === 'POST' && req.url === '/open') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try {
        const { sessionId, file } = JSON.parse(body)
        const s = snapshot.find((x) => x.sessionId === sessionId)
        if (!s || !s.editedFiles.includes(file)) throw new Error('fichero no listado')
        const abs = isAbsolute(file) ? file : join(s.cwd, file)
        if (!statSync(abs).isFile()) throw new Error('no es un fichero')
        if (!CODE_EXE) throw new Error('VS Code no está en el PATH')
        spawn(CODE_EXE, ['--goto', abs], { stdio: 'ignore', windowsHide: true }).unref() // sin shell: la ruta no se interpreta
        res.writeHead(204).end()
      } catch (err) {
        res.writeHead(400).end(err.message)
      }
    })
    return
  }
  if (req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`)
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }
  // Ficheros propios (index.html, icon.svg…): solo nombres planos de esta carpeta.
  const file = req.url === '/' ? 'index.html' : req.url.slice(1).split('?')[0]
  const type = { html: 'text/html; charset=utf-8', svg: 'image/svg+xml', css: 'text/css', js: 'text/javascript' }[file.split('.').pop()]
  if (!type || !/^[\w.-]+$/.test(file) || !existsSync(join(HERE, file))) {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, { 'Content-Type': type })
  res.end(readFileSync(join(HERE, file)))
}).listen(PORT, '127.0.0.1', () => console.log(`Centro de sesiones en http://localhost:${PORT}`))

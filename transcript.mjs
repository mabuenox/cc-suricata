// Lectura de un transcript de Claude Code (~/.claude/projects/<proyecto>/<sessionId>.jsonl).
// Dos lectores sobre el mismo fichero, a propósito:
//  - readTranscript lee la cola hacia atrás por trozos y para en cuanto tiene lo que la fila muestra:
//    un transcript puede tener decenas de MB y lo esencial está en las últimas líneas.
//  - tally recorre el fichero entero hacia delante, pero solo una vez: guarda el offset y en cada
//    refresco parsea únicamente lo que ha crecido (tokens generados y eventos de la línea de tiempo).
// derive() combina el registro de sesiones vivas con lo leído; es pura para poder probarla.
import { readFileSync, openSync, readSync, closeSync, statSync } from 'node:fs'

const TAIL_BYTES = 512 * 1024
const MAX_TEXT = 1500

// Líneas del fichero de atrás adelante, leídas por trozos: un transcript grande solo se lee hasta donde haga falta.
export function* linesFromEnd(path) {
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

// Recorre el transcript de atrás adelante y saca lo que la fila y el panel muestran.
export function readTranscript(path, cwd = '') {
  const out = {
    title: null, lastPrompt: null, lastAnswer: null, currentTool: null, waitingQuestion: null, lastTurnEndedAt: null,
    model: null, contextTokens: null, permissionMode: null, prompts: null, turns: null, agents: 0, editedFiles: [],
    background: [], // tareas lanzadas con run_in_background que aún no han notificado su fin
    agentsAt: [], // timestamps de los Agent en primer plano sin resultado
    pendingAt: null, // timestamp de la herramienta en curso
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
          out.background.push({ tool: c.name, label: clip(String(isAgent ? c.input.description ?? '' : c.input.command ?? c.input.description ?? '')).split('\n')[0], at: r.timestamp })
        } else if (c.type === 'tool_use' && !resolved.has(c.id)) {
          if (c.name === 'Agent') out.agentsAt.push(r.timestamp)
          if (!pendingTool) {
            pendingTool = c
            out.pendingAt = r.timestamp
            if (c.name === 'AskUserQuestion') out.waitingQuestion = c.input?.questions?.[0]?.question ?? '(question)'
            else out.currentTool = c.name
          }
        }
      }
    }
    // Lo esencial está en las últimas líneas; los ficheros editados pueden estar más atrás, pero no vale la pena leer todo el transcript.
    if (out.lastPrompt && out.lastAnswer && out.title && out.lastTurnEndedAt && (out.editedFiles.length >= 8 || scanned > 1500)) break
  }
  return out
}

// Pasada por todo el transcript, incremental (solo lo que ha crecido desde la última vez): tokens generados
// y eventos de la línea de tiempo, tus prompts ('p') y fines de turno ('e'), con su instante en ms.
const tallies = new Map() // path -> { offset, total, events, rest }
export function tally(path) {
  const t = tallies.get(path) ?? { offset: 0, total: 0, events: [], rest: '' }
  const size = statSync(path).size
  if (size < t.offset) Object.assign(t, { offset: 0, total: 0, events: [], rest: '' }) // fichero reescrito
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
      if (!line.includes('"output_tokens"') && !line.includes('"kind":"human"') && !line.includes('"stop_reason":"end_turn"')) continue
      try {
        const r = JSON.parse(line)
        t.total += r.message?.usage?.output_tokens ?? 0
        if (r.isSidechain) continue
        // shortcut: un turno que acaba en AskUserQuestion no es end_turn; esa espera se dibuja como trabajo. Revisar si el transcript marca esa parada.
        if (r.type === 'user' && r.origin?.kind === 'human') t.events.push([Date.parse(r.timestamp), 'p'])
        else if (r.type === 'assistant' && r.message?.stop_reason === 'end_turn') t.events.push([Date.parse(r.timestamp), 'e'])
      } catch {}
    }
    t.offset = size
    tallies.set(path, t)
  }
  return t
}

// Estado de una sesión viva: el registro (~/.claude/sessions/<pid>.json) más lo leído del transcript.
export function derive(s, t, { total = 0, events = [] } = {}) {
  // Una tarea en background es hija del proceso de Claude Code: si se lanzó antes de que arrancara el proceso actual (sesión reanudada), murió con el anterior.
  const alive = (at) => new Date(at).getTime() >= s.startedAt
  const background = t.background.filter((b) => alive(b.at))
  const agents = t.agentsAt.filter(alive).length + background.filter((b) => b.tool === 'Agent').length
  const pending = t.pendingAt && alive(t.pendingAt) ? t : { currentTool: null, waitingQuestion: null }
  // shortcut: el registro solo dice busy/idle; la espera de permiso no se ve, solo la de AskUserQuestion. Revisar si el registro gana un estado "waiting".
  // El registro trae busy/idle y, a veces, valores transitorios; para la página todo lo que no es idle es "trabajando".
  const status = pending.waitingQuestion ? 'waiting' : s.status === 'busy' ? 'busy' : background.length ? 'background' : s.status === 'idle' ? 'idle' : 'busy'
  return {
    ...s, ...t, background, agents, currentTool: pending.currentTool, waitingQuestion: pending.waitingQuestion,
    outputTokens: total,
    events: events.filter(([at]) => at >= s.startedAt).slice(-400), // los eventos anteriores al proceso actual no forman parte de esta línea de tiempo
    status, rawStatus: s.status ?? null, statusSince: pending.waitingQuestion ? null : s.statusUpdatedAt,
  }
}

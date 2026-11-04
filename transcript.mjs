// Reading a Claude Code transcript (~/.claude/projects/<project>/<sessionId>.jsonl).
// Two readers over the same file, on purpose:
//  - readTranscript reads the tail backwards in chunks and stops as soon as it has what the row shows:
//    a transcript can be tens of MB and the essentials are in the last lines.
//  - tally walks the whole file forwards, but only once: it keeps the offset and on each refresh
//    parses only what has grown (generated tokens and timeline events).
// derive() combines the live sessions registry with what was read; it is pure so it can be tested.
import { readFileSync, openSync, readSync, closeSync, statSync } from 'node:fs'

const TAIL_BYTES = 512 * 1024
const MAX_TEXT = 1500

// Lines of the file from the end, read in chunks: a large transcript is only read as far as needed.
export function* linesFromEnd(path) {
  const size = statSync(path).size
  const fd = openSync(path, 'r')
  try {
    let end = size
    let carry = Buffer.alloc(0) // cut-off beginning of the previous chunk's last line
    while (end > 0) {
      const start = Math.max(0, end - TAIL_BYTES)
      let buf = Buffer.alloc(end - start)
      readSync(fd, buf, 0, buf.length, start)
      buf = Buffer.concat([buf, carry])
      const cut = start > 0 ? buf.indexOf(10) + 1 : 0 // the first line may be cut (in bytes, because of UTF-8)
      carry = buf.subarray(0, cut)
      yield* buf.subarray(cut).toString('utf8').split('\n').reverse()
      end = start
    }
  } finally {
    closeSync(fd)
  }
}

const clip = (s) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '…' : s)

// Walks the transcript backwards and extracts what the row and the panel show.
export function readTranscript(path, cwd = '') {
  const out = {
    title: null, lastPrompt: null, lastAnswer: null, currentTool: null, waitingQuestion: null, lastTurnEndedAt: null,
    model: null, contextTokens: null, permissionMode: null, prompts: null, turns: null, agents: 0, editedFiles: [],
    background: [], // tasks launched with run_in_background that have not reported their end yet
    agentsAt: [], // timestamps of foreground Agents without a result
    pendingAt: null, // timestamp of the tool in progress
  }
  if (!path) return out
  const resolved = new Set()
  const notified = new Set() // tool_use ids and task ids of background tasks whose completion notification arrived, or stopped with TaskStop
  const taskOf = new Map() // tool_use id -> task id, from the result "Command running in background with ID: x"
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
      // Only what you typed: no task notifications, messages from other sessions or interruptions (no origin).
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
    // The essentials are in the last lines; edited files may be further back, but reading the whole transcript is not worth it.
    if (out.lastPrompt && out.lastAnswer && out.title && out.lastTurnEndedAt && (out.editedFiles.length >= 8 || scanned > 1500)) break
  }
  return out
}

// Pass over the whole transcript, incremental (only what has grown since last time): generated tokens
// and timeline events, your prompts ('p') and turn ends ('e'), with their instant in ms.
const tallies = new Map() // path -> { offset, total, events, rest }
export function tally(path) {
  const t = tallies.get(path) ?? { offset: 0, total: 0, events: [], rest: '' }
  const size = statSync(path).size
  if (size < t.offset) Object.assign(t, { offset: 0, total: 0, events: [], rest: '' }) // file rewritten
  if (size > t.offset) {
    const buf = Buffer.alloc(size - t.offset)
    const fd = openSync(path, 'r')
    try {
      readSync(fd, buf, 0, buf.length, t.offset)
    } finally {
      closeSync(fd)
    }
    const lines = (t.rest + buf.toString('utf8')).split('\n')
    t.rest = lines.pop() // last line, maybe incomplete
    for (const line of lines) {
      if (!line.includes('"output_tokens"') && !line.includes('"kind":"human"') && !line.includes('"stop_reason":"end_turn"')) continue
      try {
        const r = JSON.parse(line)
        t.total += r.message?.usage?.output_tokens ?? 0
        if (r.isSidechain) continue
        // shortcut: a turn that ends in AskUserQuestion is not an end_turn; that wait is drawn as work. Revisit if the transcript marks that stop.
        if (r.type === 'user' && r.origin?.kind === 'human') t.events.push([Date.parse(r.timestamp), 'p'])
        else if (r.type === 'assistant' && r.message?.stop_reason === 'end_turn') t.events.push([Date.parse(r.timestamp), 'e'])
      } catch {}
    }
    t.offset = size
    tallies.set(path, t)
  }
  return t
}

// State of a live session: the registry (~/.claude/sessions/<pid>.json) plus what was read from the transcript.
export function derive(s, t, { total = 0, events = [] } = {}) {
  // A background task is a child of the Claude Code process: if it was launched before the current process started (resumed session), it died with the previous one.
  const alive = (at) => new Date(at).getTime() >= s.startedAt
  const background = t.background.filter((b) => alive(b.at))
  const agents = t.agentsAt.filter(alive).length + background.filter((b) => b.tool === 'Agent').length
  const pending = t.pendingAt && alive(t.pendingAt) ? t : { currentTool: null, waitingQuestion: null }
  // shortcut: the registry only says busy/idle; a permission wait is invisible, only AskUserQuestion is. Revisit if the registry gains a "waiting" status.
  // The registry carries busy/idle and, at times, transient values; for the page anything that is not idle is "working".
  const status = pending.waitingQuestion ? 'waiting' : s.status === 'busy' ? 'busy' : background.length ? 'background' : s.status === 'idle' ? 'idle' : 'busy'
  return {
    ...s, ...t, background, agents, currentTool: pending.currentTool, waitingQuestion: pending.waitingQuestion,
    outputTokens: total,
    events: events.filter(([at]) => at >= s.startedAt).slice(-400), // events before the current process are not part of this timeline
    status, rawStatus: s.status ?? null, statusSince: pending.waitingQuestion ? null : s.statusUpdatedAt,
  }
}

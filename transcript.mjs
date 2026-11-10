// Reading a Claude Code transcript (~/.claude/projects/<project>/<sessionId>.jsonl).
// Two readers over the same file, on purpose:
//  - readTranscript reads the tail backwards in chunks and stops as soon as it has what the row shows:
//    a transcript can be tens of MB and the essentials are in the last lines.
//  - tally walks the whole file forwards, but only once: it keeps the offset and on each refresh
//    parses only what has grown (generated tokens and timeline events).
// derive() combines the live sessions registry with what was read; it is pure so it can be tested.
import { openSync, readSync, closeSync, statSync } from 'node:fs'

const TAIL_BYTES = 512 * 1024
const MAX_TEXT = 1500
const MAX_FILES = 8
const MAX_RECORDS = 1500

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

function* recordsFromEnd(path) {
  for (const line of linesFromEnd(path)) {
    if (!line) continue
    try {
      yield JSON.parse(line)
    } catch {} // a line still being written
  }
}

const clip = (s) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '…' : s)
const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') : '')

export const emptyTranscript = () => ({
  title: null, lastPrompt: null, lastAnswer: null, currentTool: null, waitingQuestion: null, lastTurnEndedAt: null,
  model: null, contextTokens: null, permissionMode: null, prompts: null, turns: null, agents: 0, editedFiles: [],
  background: [], // tasks launched with run_in_background that have not reported their end yet
  agentsAt: [], // timestamps of foreground Agents without a result
  pendingAt: null, // timestamp of the tool in progress
  branch: '', // the git branch of the last record: what a closed session was on, whatever the folder is on now
  pr: null, // { number, url, repo } of the pull request the session opened (pr-link record)
  away: null, // { text, at }: the summary Claude Code writes a few minutes after a turn ends while you are away
})

// Walks the transcript backwards and extracts what the row and the panel show. Because it walks backwards,
// a tool's result and a background task's completion are seen before the tool call itself: `seen` carries them.
export function readTranscript(path, cwd = '') {
  if (!path) throw new TypeError('readTranscript: path is required')
  const out = emptyTranscript()
  let customTitle = null // the name you gave with /rename: it beats the automatic one, but the early exit below waits for either
  const seen = {
    resolved: new Set(), // tool_use ids with a result
    notified: new Set(), // tool_use ids and task ids of background tasks whose completion arrived, or stopped with TaskStop
    taskOf: new Map(), // tool_use id -> task id, from the result "Command running in background with ID: x"
    pending: false, // the tool in progress is the last tool_use without result, i.e. the first one found
    records: 0,
  }
  for (const r of recordsFromEnd(path)) {
    seen.records++
    noteEditedFile(r, out, cwd)
    for (const m of noticeText(r).matchAll(/<(?:tool-use-id|task-id)>([^<]+)<\/(?:tool-use-id|task-id)>|<agent-message from="([^"]+)"/g)) seen.notified.add(m[1] ?? m[2])
    if (r.type === 'ai-title') out.title ??= r.aiTitle
    if (r.type === 'custom-title' && r.customTitle) customTitle ??= r.customTitle
    if (r.type === 'pr-link' && r.prUrl) out.pr ??= { number: r.prNumber, url: r.prUrl, repo: r.prRepository }
    if (r.type === 'system' && r.subtype === 'away_summary' && r.content) out.away ??= { text: clip(r.content.replace(/\s*\(disable recaps in \/config\)\s*$/, '')), at: r.timestamp } // the trailer is Claude Code's own hint
    if (!out.branch && r.gitBranch && r.gitBranch !== 'HEAD') out.branch = r.gitBranch // "HEAD": not a repo, or detached
    if (r.isSidechain) continue
    if (r.type === 'user') noteUserRecord(r, out, seen)
    if (r.type === 'assistant' && Array.isArray(r.message?.content)) noteAssistantRecord(r, out, seen)
    // The essentials are in the last lines; edited files may be further back, but reading the whole transcript is not worth it.
    if (out.lastPrompt && out.lastAnswer && (out.title || customTitle) && out.lastTurnEndedAt && (out.editedFiles.length >= MAX_FILES || seen.records > MAX_RECORDS)) break
  }
  out.title = customTitle ?? out.title
  return out
}

function noteEditedFile(r, out, cwd) {
  if (r.type !== 'file-history-delta' || !r.trackingPath || out.editedFiles.length >= MAX_FILES) return
  const inFolder = ['\\', '/'].some((sep) => r.trackingPath.toLowerCase().startsWith(cwd.toLowerCase() + sep)) // the separator the OS of the transcript uses
  const p = inFolder ? r.trackingPath.slice(cwd.length + 1) : r.trackingPath
  if (!out.editedFiles.includes(p)) out.editedFiles.push(p)
}

// How a tool result says the work went on without it, and the id its completion notice will carry:
// a Bash with run_in_background, a Workflow (always in the background), an Agent (asynchronous since late 2026).
const LAUNCHED = [
  /running in (?:the )?background(?: with ID| as)[: ]+@?([\w-]+)/i,
  /launched in background\. Task ID: ([\w-]+)/,
  /Async agent launched successfully[\s\S]*?agentId: ([\w-]+)/,
]

function noteUserRecord(r, out, seen) {
  const content = r.message?.content
  const text = textOf(content)
  // Only what you typed: no task notifications, messages from other sessions or interruptions (no origin).
  if (text && r.origin?.kind === 'human' && !out.lastPrompt) {
    out.lastPrompt = { text: clip(text), at: r.timestamp }
    out.permissionMode = r.permissionMode ?? null
    out.prompts = (r.turnPosition?.promptIndex ?? -1) + 1
    out.turns = (r.turnPosition?.turnIndex ?? -1) + 1
  }
  for (const c of Array.isArray(content) ? content : []) {
    if (c.type !== 'tool_result') continue
    seen.resolved.add(c.tool_use_id)
    const body = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((x) => x.text ?? '').join('\n') : ''
    const taskId = LAUNCHED.map((re) => body.match(re)?.[1]).find(Boolean)
    if (taskId) seen.taskOf.set(c.tool_use_id, taskId)
  }
}

// Where a background task's completion notice (<task-notification> with its task and tool-use ids) can be: as the text of a
// user record (older transcripts), or as a `queue-operation` and the `attachment` that delivers it (since late 2026).
function noticeText(r) {
  const text = r.type === 'user' ? textOf(r.message?.content) : r.type === 'queue-operation' ? r.content : r.type === 'attachment' ? r.attachment?.prompt : ''
  return typeof text === 'string' ? text : ''
}

function noteAssistantRecord(r, out, seen) {
  const { usage, model, stop_reason, content } = r.message
  if (!out.model && usage) {
    out.model = model
    out.contextTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
  }
  if (stop_reason === 'end_turn') out.lastTurnEndedAt ??= r.timestamp
  for (const c of content) {
    if (c.type === 'text' && c.text.trim() && !out.lastAnswer) out.lastAnswer = { text: clip(c.text.trim()), at: r.timestamp }
    if (c.type === 'tool_use') noteToolUse(c, r.timestamp, out, seen)
  }
}

// What the row shows for a background task: the command, the agent's description, the workflow's name (from its script's meta).
function labelOf(c) {
  if (c.name === 'Agent') return c.input.description ?? ''
  if (c.name === 'Workflow') return c.input.name ?? c.input.script?.match(/name:\s*['"]([^'"]+)/)?.[1] ?? 'workflow'
  return c.input.command ?? c.input.description ?? ''
}

function noteToolUse(c, at, out, seen) {
  if (c.name === 'TaskStop') {
    const id = c.input?.task_id ?? c.input?.shell_id
    if (id) seen.notified.add(id) // adding undefined would match every task without a known id
  }
  // Work that goes on without the turn: asked for (run_in_background), or how Agent and Workflow answer anyway ("launched",
  // see LAUNCHED). Alive until its completion notice or hand-back names it.
  if (c.input?.run_in_background === true || (['Agent', 'Workflow'].includes(c.name) && seen.taskOf.has(c.id))) {
    if (seen.notified.has(c.id) || seen.notified.has(seen.taskOf.get(c.id))) return
    out.background.push({ tool: c.name, label: clip(labelOf(c)).split('\n')[0], at })
    return
  }
  if (seen.resolved.has(c.id)) return
  if (c.name === 'Agent') out.agentsAt.push(at)
  if (seen.pending) return
  seen.pending = true
  out.pendingAt = at
  if (c.name === 'AskUserQuestion') out.waitingQuestion = c.input?.questions?.[0]?.question ?? '(question)'
  else out.currentTool = c.name
}

// Pass over the whole transcript, incremental (only what has grown since last time): generated tokens,
// timeline events (your prompts 'p', turn ends 'e', compactions 'c', with their instant in ms), the measured
// duration of each turn, and the running totals Claude Code writes now and then (cost, tools used), which can
// sit anywhere in the file and so are not for the tail reader.
const MARKS = ['"output_tokens"', '"kind":"human"', '"stop_reason":"end_turn"', '"compact_boundary"', '"turn_duration"', '"type":"cost-state"', '"type":"tools-used"']
const freshTally = () => ({ offset: 0, total: 0, events: [], turnDurations: [], answers: [], cost: null, tools: [], rest: '' })
const tallies = new Map() // path -> freshTally()
export function tally(path) {
  const t = tallies.get(path) ?? freshTally()
  const size = statSync(path).size
  if (size < t.offset) Object.assign(t, freshTally()) // file rewritten
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
      if (!MARKS.some((m) => line.includes(m))) continue
      try {
        const r = JSON.parse(line)
        t.total += r.message?.usage?.output_tokens ?? 0
        if (r.type === 'cost-state') t.cost = costOf(r) // a running total: the last one is the one
        if (r.type === 'tools-used' && Array.isArray(r.tools)) t.tools = r.tools // cumulative too
        if (r.isSidechain) continue
        // shortcut: a turn that ends in AskUserQuestion is not an end_turn; that wait is drawn as work. Revisit if the transcript marks that stop.
        if (r.type === 'user' && r.origin?.kind === 'human') t.events.push([Date.parse(r.timestamp), 'p'])
        else if (r.type === 'assistant' && r.message?.stop_reason === 'end_turn') {
          t.events.push([Date.parse(r.timestamp), 'e'])
          const line = textOf(r.message.content).split('\n').find((l) => l.trim()) // how each turn ended, for the list of phases
          if (line) t.answers.push([Date.parse(r.timestamp), line.trim().slice(0, 120)])
        }
        else if (r.type === 'system' && r.subtype === 'compact_boundary') t.events.push([Date.parse(r.timestamp), 'c'])
        else if (r.type === 'system' && r.subtype === 'turn_duration' && r.durationMs >= 0) t.turnDurations.push([Date.parse(r.timestamp), r.durationMs])
      } catch {}
    }
    t.offset = size
    tallies.set(path, t)
  }
  return t
}

// What a cost-state record says so far: dollars, time on the API and in tools, lines, and the split per model.
const costOf = (r) => ({
  usd: r.totalCostUSD ?? 0, apiMs: r.totalAPIDuration ?? 0, toolMs: r.totalToolDuration ?? 0,
  linesAdded: r.totalLinesAdded ?? 0, linesRemoved: r.totalLinesRemoved ?? 0,
  models: Object.entries(r.modelUsage ?? {}).map(([model, m]) => ({ model, usd: m.costUSD ?? 0, outputTokens: m.outputTokens ?? 0 })).sort((a, b) => b.usd - a.usd),
})

// State of a live session: the registry (~/.claude/sessions/<pid>.json) plus what was read from the transcript.
export function derive(s, t, { total = 0, events = [], turnDurations = [], answers = [], cost = null, tools = [] } = {}) {
  // A background task is a child of the Claude Code process: if it was launched before the current process started (resumed session), it died with the previous one.
  const alive = (at) => new Date(at).getTime() >= s.startedAt
  const background = t.background.filter((b) => alive(b.at))
  const agents = t.agentsAt.filter(alive).length + background.filter((b) => b.tool === 'Agent').length
  const pending = t.pendingAt && alive(t.pendingAt) ? t : { currentTool: null, waitingQuestion: null }
  // The registry says busy/idle/waiting (a permission prompt, a plan to approve, a dialog…; `waitingFor` says which) and, at times,
  // transient values: for the page anything that is not idle is "working". AskUserQuestion is not a registry wait, it comes from the transcript.
  const waitingQuestion = pending.waitingQuestion ?? (s.status === 'waiting' ? s.waitingFor ?? '(waiting)' : null)
  const status = waitingQuestion ? 'waiting' : s.status === 'busy' ? 'busy' : background.length ? 'background' : s.status === 'idle' ? 'idle' : 'busy'
  return {
    ...s, ...t, background, agents, currentTool: pending.currentTool, waitingQuestion,
    outputTokens: total, cost, tools,
    events: events.filter(([at]) => at >= s.startedAt).slice(-400), // events before the current process are not part of this timeline
    turnDurations: turnDurations.filter(([at]) => at >= s.startedAt).slice(-400),
    answers: answers.filter(([at]) => at >= s.startedAt).slice(-400),
    status, rawStatus: s.status ?? null, statusSince: pending.waitingQuestion ? null : s.statusUpdatedAt,
  }
}

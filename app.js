// Claude Code Suricata page: receives the snapshot over SSE and renders it. Classic script (not a module): the top-level
// variables are global on purpose, so data can be injected from the console (screenshots with fake data).
// A branch: the fork glyph. A worktree: a trunk with its own branch beside the folder, the way `git worktree` puts a checkout in another folder.
const GIT = {
  branch: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="4" cy="3" r="1.6"/><circle cx="4" cy="11" r="1.6"/><circle cx="10" cy="4.5" r="1.6"/><path d="M4 4.6v4.8M10 6.1c0 2.4-2 2.6-4 3.1" stroke-linecap="round"/></svg>',
  worktree: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M1.5 3.5h3.5l1.2 1.3h5.8v6.7H1.5z"/><path d="M5 9.5h4.5M7.3 9.5V7.2" stroke-linecap="round"/></svg>',
}
const FOLDER = '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M1.5 3.5h3.5l1.2 1.3h5.8v6.7H1.5z"/></svg>'
// Where the session runs: its branch (or worktree), else the folder's own name; the full path is the row's tooltip and in the panel.
const place = (s) => {
  if (!s.branch) return `${FOLDER}${esc(s.cwd.split(/[\\/]/).filter(Boolean).pop() ?? s.cwd)}`
  const wt = s.branch.endsWith(' (worktree)')
  return `${wt ? GIT.worktree : GIT.branch}${esc(wt ? s.branch.slice(0, -11) : s.branch)}`
}
const ICON = {
  // asking: "?"; waiting for you: the prompt chevron, your turn to type; working: in progress; background: in progress, dotted
  waiting: '<svg viewBox="0 0 14 14" fill="currentColor"><circle cx="7" cy="7" r="7"/><path d="M5.2 5.4a1.9 1.9 0 1 1 2.7 1.7c-.6.3-.9.6-.9 1.2v.3" stroke="#191a1f" stroke-width="1.5" fill="none" stroke-linecap="round"/><circle cx="7" cy="10.6" r=".9" fill="#191a1f"/></svg>',
  idle: '<svg viewBox="0 0 14 14" fill="currentColor"><circle cx="7" cy="7" r="7"/><path d="M5.3 4.3L8.2 7l-2.9 2.7" stroke="#191a1f" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  busy: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor"><circle cx="7" cy="7" r="6" stroke-width="1.4"/><path class="spin" d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill="currentColor" stroke="none"/></svg>',
  background: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor"><circle cx="7" cy="7" r="6" stroke-width="1.4" stroke-dasharray="2.2 2"/><path class="spin" d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill="currentColor" stroke="none"/></svg>',
  closed: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor"><circle cx="7" cy="7" r="6" stroke-width="1.4"/></svg>',
}
const CLASS = { waiting: 'need', idle: 'done', busy: 'work', background: 'work', closed: 'off' }
const WORD = { waiting: 'Asking you', idle: 'Waiting for you', busy: 'Working', background: 'In background', closed: 'Closed' }
const GROUPS = [
  { statuses: ['waiting'], label: 'Need you', one: 'asking you', many: 'asking you' },
  { statuses: ['idle'], label: 'Waiting for you', one: 'waiting for you', many: 'waiting for you' },
  { statuses: ['busy', 'background'], label: 'Working', one: 'working', many: 'working' },
  { statuses: ['closed'], label: 'Recent' },
]
const groupOf = (s) => GROUPS.findIndex((g) => g.statuses.includes(s.status))
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const md = (text) => window.marked && window.DOMPurify ? DOMPurify.sanitize(marked.parse(text)) : esc(text)
const k = (n) => n == null ? '' : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
const dur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(s < 36000 ? 1 : 0)} h` }
const sinceOf = (s) => s.status === 'closed' ? s.updatedAt : s.status === 'busy' ? s.lastPrompt?.at ?? s.statusSince : s.status === 'background' ? s.background[0]?.at ?? s.updatedAt : s.status === 'waiting' ? s.updatedAt : s.statusSince ?? s.updatedAt
const modelOf = (s) => s.model?.split('-')[1] ?? ''
const SRC = { cli: 'CLI', 'claude-desktop': 'Desktop', 'claude-vscode': 'VS Code', 'sdk-py': 'SDK', 'sdk-ts': 'SDK' }
const src = (s) => SRC[s.entrypoint] ? `<span class="src">${SRC[s.entrypoint]}</span>` : ''
const firstLine = (t) => (t ?? '').split('\n').find((l) => l.trim())?.replace(/[*`_#]/g, '') ?? ''
// shortcut: the context window is not in the data; above 200k, 1M is assumed.
const gauge = (ctx) => {
  if (!ctx) return '<span></span>'
  const pct = Math.min(100, Math.round((ctx / (ctx > 200_000 ? 1_000_000 : 200_000)) * 100))
  return `<span class="gauge ${pct > 85 ? 'full' : pct > 60 ? 'high' : ''}" title="${k(ctx)} tokens in context. The bar is an estimate: Claude Code does not expose the window; 200k is assumed, or 1M once it is exceeded."><i><b style="width:${pct}%"></b></i><span>${k(ctx)}</span></span>`
}
const time = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
const PAUSE = 3600e3 // a wait longer than an hour is a pause: not counted as waiting, drawn shortened
const timeline = (ev, s, turnDurations = []) => {
  if (!ev) return '<span class="prompt">Loading…</span>'
  const segs = []
  let open = null
  const close = (to) => { if (open && to > open.from) segs.push({ ...open, to, d: to - open.from }); open = null }
  for (const [at, kind] of ev) {
    if (kind === 'c') { const was = open?.kind; close(at); segs.push({ kind: 'compact', from: at, d: 0 }); if (was) open = { kind: was, from: at }; continue } // a compaction is a mark, not a segment
    close(at)
    open = { kind: kind === 'p' ? 'work' : 'wait', from: at }
  }
  if (s.status !== 'closed') close(Date.now())
  if (!segs.length) return '<span class="prompt">No turns yet</span>'
  let work = 0, wait = 0, pauses = 0
  for (const g of segs) { if (g.kind === 'work') work += g.d; else if (g.d > PAUSE) pauses++; else wait += g.d }
  const bar = segs.map((g) => { if (g.kind === 'compact') return `<i class="compact" title="Context compacted · ${time(g.from)}"></i>`; const pause = g.kind === 'wait' && g.d > PAUSE; return `<i class="${g.kind}${pause ? ' pause' : ''}" style="flex:${pause ? PAUSE / 4 : g.d}" title="${pause ? 'Pause' : g.kind === 'work' ? 'Working' : 'Waiting for you'} ${dur(g.d)} · from ${time(g.from)}"></i>` }).join('')
  const pct = Math.round((work / (work + wait || 1)) * 100)
  const compactions = segs.filter((g) => g.kind === 'compact').length
  const measured = turnDurations.map(([, ms]) => ms) // what Claude Code timed per turn, where the bar above is wall-clock between records
  return `<div class="tl">${bar}</div><div class="tlsum">${segs.filter((g) => g.kind === 'work').length} turns · <b class="work">working ${dur(work)}</b> (${pct} %) · <b class="wait">waiting for you ${dur(wait)}</b>${pauses ? ` · ${pauses} ${pauses === 1 ? 'pause' : 'pauses'}` : ''}${compactions ? ` · <b class="compact">${compactions} ${compactions === 1 ? 'compaction' : 'compactions'}</b>` : ''}${measured.length ? `<br>Model time ${dur(measured.reduce((a, b) => a + b, 0))} over ${measured.length} timed turns · longest ${dur(Math.max(...measured))}` : ''}</div>`
}
const NO_DETAILS = { events: null, turnDurations: [], cost: null, tools: [] } // while /timeline is on its way
const closedDetails = new Map() // sessionId -> { events, turnDurations, cost, tools } of a closed session, fetched when opened
const detailsOf = (s) => {
  if (s.status !== 'closed') return s
  if (!closedDetails.has(s.sessionId)) {
    closedDetails.set(s.sessionId, null)
    fetch(`/timeline?id=${s.sessionId}`).then((r) => r.json()).then((d) => { closedDetails.set(s.sessionId, d); render() })
  }
  return closedDetails.get(s.sessionId) ?? NO_DETAILS
}
// The summary Claude Code writes a few minutes after a turn ends while you are away: what the session is at, better than the last answer's first line.
const awayText = (s) => (s.away && (!s.lastAnswer || s.away.at > s.lastAnswer.at) ? s.away.text : null)
const pill = (s) => `<span class="pill ${CLASS[s.status]}">${ICON[s.status]}${WORD[s.status]}</span>`
// "Now" column: question, tool in progress, background tasks and agents, or the first line of the last answer.
const doing = (s) => {
  const extras = []
  if (s.background.length) extras.push(`<span class="tag">${s.background.length === 1 ? `${esc(s.background[0].tool)} in background` : `${s.background.length} in background`}</span>`)
  if (s.agents) extras.push(`<span class="tag">${s.agents} ${s.agents === 1 ? 'agent' : 'agents'}</span>`)
  if (s.match) return `<span class="match">${esc(s.match)}</span>` // a search result: the prompt that matched is why it is here
  if (s.status === 'waiting') return esc(s.waitingQuestion)
  if (s.status === 'background') return `${extras.join('')}${esc(s.background[0].label)}`
  if (s.status === 'busy') return `${s.currentTool ? `<code>${esc(s.currentTool)}</code>` : ''}${extras.join('')}${esc(firstLine(s.lastAnswer?.text)) || (s.currentTool ? '' : 'Thinking')}`
  return `${extras.join('')}${awayText(s) ? `<span class="away">${esc(firstLine(awayText(s)))}</span>` : esc(firstLine(s.lastAnswer?.text))}`
}

const prLink = (s) => (s.pr?.url.startsWith('https://') ? `<a class="pr" href="${esc(s.pr.url)}" target="_blank" rel="noopener" title="${esc(s.pr.repo ?? '')}">#${esc(String(s.pr.number))}</a>` : '')

let sessions = []
let findings = [] // facts worth a look, most urgent first, each pointing at a session
let summary = { text: null, at: 0 } // the two sentences from claude -p
let found = null // search results, shown instead of the sessions while the box has text
let sorted = []
let selectedId = null
let peekOpen = false

// What the session is about: the title Claude Code gave it from the first prompt; the registry name ("workspace-1b") goes under it.
const subject = (s) => s.title ?? s.name ?? s.cwd
const row = (s) => `
  <div class="row ${CLASS[s.status]}${s.sessionId === selectedId ? ' selected' : ''}" role="option" aria-selected="${s.sessionId === selectedId}" tabindex="0" data-id="${s.sessionId}" title="${esc(s.cwd)}">
    ${ICON[s.status]}
    <span class="who"><span class="name">${esc(subject(s))}${src(s)}</span><span class="branch">${s.title && s.name !== s.title ? `${esc(s.name)} · ` : ''}${place(s)}${s.pr ? ` · ${prLink(s)}` : ''}</span></span>
    <span class="doing">${doing(s)}</span>
    <span class="run"><b>${esc(modelOf(s))}</b>${esc(s.permissionMode ?? '')}</span>
    ${gauge(s.contextTokens)}
    <span class="num r">${dur((s.status === 'closed' ? s.updatedAt : Date.now()) - s.startedAt)}</span>
    <span class="num r">${s.prompts ? `<b>${s.prompts}</b> / ${s.turns}` : ''}</span>
    <span class="num r">${k(s.outputTokens)}</span>
    <span class="num r"><b>${dur(Date.now() - new Date(sinceOf(s)))}</b></span>
  </div>`

const usd = (n) => (n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`)
const costSection = (c) => `<section><h3>Cost so far</h3><div class="stats"><b>${usd(c.usd)}</b> · API ${dur(c.apiMs)} · tools ${dur(c.toolMs)} · <span class="add">+${c.linesAdded}</span> <span class="del">−${c.linesRemoved}</span> lines</div>${c.models.length > 1 ? `<div class="stats dim">${c.models.map((m) => `${esc(modelOf(m))} ${usd(m.usd)}`).join(' · ')}</div>` : ''}</section>`
const toolsSection = (tools) => `<section><h3>Tools used</h3><div class="chips">${tools.map((t) => `<span>${esc(t.replace(/^mcp__(.+?)__/, '$1 · '))}</span>`).join('')}</div></section>`

const peek = (s, d = detailsOf(s)) => `
  <div class="head">${pill(s)}<h1>${esc(subject(s))}</h1><button class="close" id="close" title="Close (Esc)" aria-label="Close">×</button></div>
  ${s.waitingQuestion ? `<section><div class="question">${esc(s.waitingQuestion)}</div></section>` : ''}
  ${s.status === 'closed' ? `<section><h3>Resume<button class="copy" id="copy">copy</button></h3><pre class="cmd"><code class="language-bash">cd "${esc(s.cwd)}"
claude --resume ${esc(s.sessionId)}</code></pre></section>` : ''}
  ${awayText(s) ? `<section><h3>Where you left it</h3><div class="away">${esc(awayText(s))}</div></section>` : ''}
  <section><h3>Timeline</h3>${timeline(d.events, s, d.turnDurations)}</section>
  ${d.cost ? costSection(d.cost) : ''}
  ${s.background.length ? `<section><h3>In background</h3>${s.background.map((b) => b.tool === 'Agent' ? `<div class="cmd">Agent: ${esc(b.label)}</div>` : `<pre class="cmd"><code class="language-bash">${esc(b.label)}</code></pre>`).join('')}</section>` : ''}
  <section><h3>Last answer</h3><div class="md">${s.lastAnswer ? md(s.lastAnswer.text) : '<span class="prompt">No answer yet</span>'}</div></section>
  <section><h3>Your last prompt</h3><div class="prompt">${esc(s.lastPrompt?.text ?? '')}</div></section>
  ${s.editedFiles.length ? `<section><h3>Edited files</h3><ul class="files">${s.editedFiles.map((f) => `<li><a href="#" data-file="${esc(f)}" title="Open in VS Code">${esc(f)}<span>open</span></a></li>`).join('')}</ul></section>` : ''}
  ${d.tools.length ? toolsSection(d.tools) : ''}
  <section><h3>Folder</h3><span class="path">${esc(s.cwd)}</span>${s.pr ? `<div class="stats">Pull request ${prLink(s)} <span class="dim">${esc(s.pr.url)}</span></div>` : ''}</section>`

// Session titles and names in the summary become links to the row: the text answers "which one" by itself.
const linkNames = (text) => {
  const labels = sessions.filter((s) => s.status !== 'closed').flatMap((s) => [s.title, s.name].filter(Boolean).map((l) => [esc(l), s.sessionId])).sort((a, b) => b[0].length - a[0].length) // longest first, so a label inside another is not cut
  if (!labels.length) return esc(text)
  const re = new RegExp(labels.map(([l]) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
  return esc(text).replace(re, (m) => `<a data-id="${labels.find(([l]) => l === m)[1]}" tabindex="0">${m}</a>`)
}
// The head of the mascot in icon.svg (same shapes, cropped), peeking at its speech bubble.
const HEAD = '<svg viewBox="7 3 19 11.5" aria-hidden="true"><g fill="#d97757"><rect x="9" y="3.5" width="15" height="10.5" rx="4"/><rect x="7.5" y="6.5" width="2.5" height="3.2" rx="1"/><rect x="23" y="6.5" width="2.5" height="3.2" rx="1"/></g><g fill="#1b1b1f"><rect x="16" y="7" width="2.4" height="3.2" rx=".7"/><rect x="20.5" y="7" width="2.4" height="3.2" rx=".7"/></g></svg>'
let summaryReq = null
function renderInsights() {
  const el = document.getElementById('insights')
  el.hidden = !sessions.some((s) => s.status !== 'closed')
  const [next] = findings // one action, the most urgent; the others are in the list anyway, and in the suricata's prompt
  const text = summary.text ? `${linkNames(summary.text)}<span class="meta">${dur(Date.now() - summary.at)} ago</span>` : `<span class="meta">${summaryReq ? 'looking at your sessions…' : 'nothing to say yet'}</span>`
  el.innerHTML = `<div class="next">${next ? `<b>Next</b><a data-id="${next.sessionId}" tabindex="0">${esc(next.text)}</a>` : '<span class="none">Nothing stands out</span>'}</div>`
    + `<p class="buddy">${HEAD}<span>${text}<button id="resummarize" ${summaryReq ? 'disabled' : ''}>again</button></span></p>` // the paragraph keeps its height while claude thinks: no jump
}
// Only while the tab is visible: a minimised page does not spend your tokens. The server caches, so asking often is free.
const requestSummary = (force) => {
  if (document.visibilityState !== 'visible' || summaryReq || !sessions.some((s) => s.status !== 'closed')) return
  summaryReq = fetch(`/summary${force ? '?force=1' : ''}`).then((r) => r.json()).then((s) => { summary = s }).catch(() => {}).finally(() => { summaryReq = null; renderInsights() })
  renderInsights()
}

function render() {
  renderInsights()
  sorted = [...(found ?? sessions)].sort((a, b) => groupOf(a) - groupOf(b) || b.updatedAt - a.updatedAt)
  if (!sorted.some((s) => s.sessionId === selectedId)) selectedId = sorted[0]?.sessionId ?? null
  const count = (g) => sessions.filter((s) => g.statuses.includes(s.status)).length // the totals stay live while searching
  const pending = count(GROUPS[0]) + count(GROUPS[1])
  document.title = `${pending ? `(${pending}) ` : ''}Claude Code Suricata`
  document.getElementById('totals').innerHTML = GROUPS.slice(0, 3).map((g) => { const n = count(g); return `<span class="${n ? '' : 'zero'}"><b>${n}</b>${n === 1 ? g.one : g.many}</span>` }).join('')
  const cols = '<div class="cols"><span></span><span>Session<i class="grip" title="Drag to resize, double-click to reset"></i></span><span>Now</span><span>Model</span><span>Context</span><span class="r">Open</span><span class="r" title="Your prompts / model turns">Prompts</span><span class="r">Tokens</span><span class="r">Since</span></div>'
  document.getElementById('list').innerHTML = sorted.length
    ? cols + GROUPS.map((g) => { const rows = sorted.filter((s) => g.statuses.includes(s.status)); return rows.length ? `<h2 class="${CLASS[g.statuses[0]]}">${found && g.label === 'Recent' ? 'Closed' : g.label} <span>${rows.length}</span></h2>${rows.map(row).join('')}` : '' }).join('')
    : found ? '<div class="empty"><div><b>Nothing found</b>No prompt contains that text.</div></div>'
    : '<div class="empty"><div><b>No open sessions</b>Open Claude Code in a terminal and it will show up here.</div></div>'
  const s = sorted.find((x) => x.sessionId === selectedId)
  const open = peekOpen && s
  document.getElementById('layout').classList.toggle('peek-open', !!open)
  const aside = document.getElementById('peek')
  aside.hidden = !open
  if (open) {
    aside.innerHTML = peek(s)
    if (window.hljs) aside.querySelectorAll('pre code').forEach((el) => hljs.highlightElement(el))
  }
}

const list = document.getElementById('list')
const select = (id, open) => { selectedId = id; if (open !== undefined) peekOpen = open; render(); list.querySelector('.row.selected')?.scrollIntoView({ block: 'nearest' }) }
list.addEventListener('click', (e) => { const el = e.target.closest('.row'); if (el) select(el.dataset.id, true) })

// The Session column is resizable: drag the grip in its header. The width lives in `--session` (a px value over the
// stylesheet's default) and in localStorage; double-click forgets it. The header is re-rendered, so the listener sits on the list.
const SESSION_COL = 'sessionCol'
const setSessionCol = (px) => {
  if (px) document.documentElement.style.setProperty('--session', `${px}px`)
  else document.documentElement.style.removeProperty('--session')
  try { px ? localStorage.setItem(SESSION_COL, px) : localStorage.removeItem(SESSION_COL) } catch {}
}
try { setSessionCol(Number(localStorage.getItem(SESSION_COL)) || 0) } catch {}
list.addEventListener('dblclick', (e) => { if (e.target.matches('.grip')) setSessionCol(0) })
list.addEventListener('pointerdown', (e) => {
  if (!e.target.matches('.grip')) return
  const cell = e.target.parentElement
  const start = { x: e.clientX, width: cell.getBoundingClientRect().width }
  const max = list.clientWidth - 420 // leaves room for Now and the fixed columns
  const move = (ev) => setSessionCol(Math.round(Math.min(max, Math.max(160, start.width + ev.clientX - start.x))))
  const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.body.classList.remove('resizing') }
  document.addEventListener('pointermove', move)
  document.addEventListener('pointerup', up)
  document.body.classList.add('resizing')
  e.preventDefault()
})
document.getElementById('insights').addEventListener('click', (e) => {
  const el = e.target.closest('[data-id]')
  if (el) { if (found) { q.value = ''; found = null } select(el.dataset.id, true) } // a finding points at a live session: leave the search
  else if (e.target.closest('#resummarize')) requestSummary(true)
})
document.getElementById('insights').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('a[data-id]')) e.target.click() })
document.addEventListener('visibilitychange', () => requestSummary())
document.getElementById('peek').addEventListener('click', (e) => {
  if (e.target.closest('#close')) select(selectedId, false)
  const copy = e.target.closest('#copy')
  if (copy) {
    const s = sorted.find((x) => x.sessionId === selectedId)
    navigator.clipboard.writeText(`cd "${s.cwd}"\nclaude --resume ${s.sessionId}`).then(() => { copy.textContent = 'copied' })
  }
  const a = e.target.closest('a[data-file]')
  if (a) {
    e.preventDefault()
    fetch('/open', { method: 'POST', body: JSON.stringify({ sessionId: selectedId, file: a.dataset.file }) })
      .then((r) => { a.querySelector('span').textContent = r.ok ? 'opened' : 'could not open' })
  }
})
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return
  const i = sorted.findIndex((s) => s.sessionId === selectedId)
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (sorted.length) select(sorted[(i + (e.key === 'ArrowDown' ? 1 : -1) + sorted.length) % sorted.length].sessionId) }
  else if (e.key === 'Enter' && selectedId) select(selectedId, true)
  else if (e.key === 'Escape') select(selectedId, false)
  else if (e.key === '/') { e.preventDefault(); q.focus() }
})

// Search: the whole prompt history, server side; results replace the list while the box has text.
const q = document.getElementById('q')
let searchTimer = null
const search = () => { const text = q.value.trim(); if (text) fetch(`/search?q=${encodeURIComponent(text)}`).then((r) => r.json()).then((rows) => { if (q.value.trim() === text) { found = rows; render() } }) }
q.addEventListener('input', () => { clearTimeout(searchTimer); if (q.value.trim()) searchTimer = setTimeout(search, 250); else { found = null; render() } })
q.addEventListener('keydown', (e) => { if (e.key === 'Escape') { q.value = ''; found = null; q.blur(); render() } })

const live = document.getElementById('live')
const es = new EventSource('/events')
es.onmessage = (e) => { const d = JSON.parse(e.data); sessions = [...d.sessions, ...d.recent]; findings = d.findings ?? []; for (const s of d.sessions) closedDetails.delete(s.sessionId); live.textContent = 'live'; live.classList.remove('off'); render(); search(); requestSummary() }
es.onerror = () => { live.textContent = 'offline'; live.classList.add('off') }
const tick = () => { document.getElementById('clock').textContent = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); if (sessions.length) render() }
setInterval(tick, 30000)
tick()

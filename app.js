// Página de Claude Code Suricata: recibe el snapshot por SSE y lo pinta. Script clásico (no módulo): las variables de
// arriba son globales a propósito, para poder inyectar datos desde la consola (capturas de pantalla con datos falsos).
const ICON = {
  // te pregunta: "?"; esperándote: el chevron del prompt, te toca escribir; trabajando: en curso; background: en curso, punteado
  waiting: '<svg viewBox="0 0 14 14" fill="currentColor"><circle cx="7" cy="7" r="7"/><path d="M5.2 5.4a1.9 1.9 0 1 1 2.7 1.7c-.6.3-.9.6-.9 1.2v.3" stroke="#191a1f" stroke-width="1.5" fill="none" stroke-linecap="round"/><circle cx="7" cy="10.6" r=".9" fill="#191a1f"/></svg>',
  idle: '<svg viewBox="0 0 14 14" fill="currentColor"><circle cx="7" cy="7" r="7"/><path d="M5.3 4.3L8.2 7l-2.9 2.7" stroke="#191a1f" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  busy: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor"><circle cx="7" cy="7" r="6" stroke-width="1.4"/><path class="spin" d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill="currentColor" stroke="none"/></svg>',
  background: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor"><circle cx="7" cy="7" r="6" stroke-width="1.4" stroke-dasharray="2.2 2"/><path class="spin" d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill="currentColor" stroke="none"/></svg>',
  closed: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor"><circle cx="7" cy="7" r="6" stroke-width="1.4"/></svg>',
}
const CLASS = { waiting: 'need', idle: 'done', busy: 'work', background: 'work', closed: 'off' }
const WORD = { waiting: 'Te pregunta', idle: 'Esperándote', busy: 'Trabajando', background: 'En background', closed: 'Cerrada' }
const GROUPS = [
  { statuses: ['waiting'], label: 'Te necesitan', one: 'te pregunta', many: 'te preguntan' },
  { statuses: ['idle'], label: 'Esperándote', one: 'esperándote', many: 'esperándote' },
  { statuses: ['busy', 'background'], label: 'Trabajando', one: 'trabajando', many: 'trabajando' },
  { statuses: ['closed'], label: 'Recientes' },
]
const groupOf = (s) => GROUPS.findIndex((g) => g.statuses.includes(s.status))
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const md = (text) => window.marked && window.DOMPurify ? DOMPurify.sanitize(marked.parse(text)) : esc(text)
const k = (n) => n == null ? '' : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
const dur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(s < 36000 ? 1 : 0)} h` }
const sinceOf = (s) => s.status === 'closed' ? s.updatedAt : s.status === 'busy' ? s.lastPrompt?.at ?? s.statusSince : s.status === 'background' ? s.background[0]?.at ?? s.updatedAt : s.status === 'waiting' ? s.updatedAt : s.statusSince ?? s.updatedAt
const modelOf = (s) => s.model?.split('-')[1] ?? ''
const SRC = { 'claude-desktop': 'Desktop', 'claude-vscode': 'VS Code', 'sdk-py': 'SDK', 'sdk-ts': 'SDK' }
const src = (s) => SRC[s.entrypoint] ? `<span class="src">${SRC[s.entrypoint]}</span>` : ''
const firstLine = (t) => (t ?? '').split('\n').find((l) => l.trim())?.replace(/[*`_#]/g, '') ?? ''
// shortcut: la ventana de contexto no está en los datos; por encima de 200k se asume 1M.
const gauge = (ctx) => {
  if (!ctx) return '<span></span>'
  const pct = Math.min(100, Math.round((ctx / (ctx > 200_000 ? 1_000_000 : 200_000)) * 100))
  return `<span class="gauge ${pct > 85 ? 'full' : pct > 60 ? 'high' : ''}" title="${k(ctx)} tokens en contexto. La barra es una estimación: Claude Code no expone la ventana; se asume 200k, o 1M si ya la supera."><i><b style="width:${pct}%"></b></i><span>${k(ctx)}</span></span>`
}
const time = (ms) => new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
const PAUSE = 3600e3 // una espera de más de una hora es una pausa: no suma como espera y se dibuja acortada
const timeline = (ev, s) => {
  if (!ev) return '<span class="prompt">Cargando…</span>'
  const segs = []
  let open = null
  const close = (to) => { if (open && to > open.from) segs.push({ ...open, to, d: to - open.from }); open = null }
  for (const [at, kind] of ev) { close(at); open = { kind: kind === 'p' ? 'work' : 'wait', from: at } }
  if (s.status !== 'closed') close(Date.now())
  if (!segs.length) return '<span class="prompt">Sin turnos todavía</span>'
  let work = 0, wait = 0, pauses = 0
  for (const g of segs) { if (g.kind === 'work') work += g.d; else if (g.d > PAUSE) pauses++; else wait += g.d }
  const bar = segs.map((g) => { const pause = g.kind === 'wait' && g.d > PAUSE; return `<i class="${g.kind}${pause ? ' pause' : ''}" style="flex:${pause ? PAUSE / 4 : g.d}" title="${pause ? 'Pausa' : g.kind === 'work' ? 'Trabajando' : 'Esperándote'} ${dur(g.d)} · desde las ${time(g.from)}"></i>` }).join('')
  const pct = Math.round((work / (work + wait || 1)) * 100)
  return `<div class="tl">${bar}</div><div class="tlsum">${segs.filter((g) => g.kind === 'work').length} turnos · <b class="work">trabajando ${dur(work)}</b> (${pct} %) · <b class="wait">esperándote ${dur(wait)}</b>${pauses ? ` · ${pauses} ${pauses === 1 ? 'pausa' : 'pausas'}` : ''}</div>`
}
const closedEvents = new Map() // sessionId -> eventos de una sesión cerrada, pedidos al abrirla
const eventsOf = (s) => {
  if (s.status !== 'closed') return s.events
  if (!closedEvents.has(s.sessionId)) {
    closedEvents.set(s.sessionId, null)
    fetch(`/timeline?id=${s.sessionId}`).then((r) => r.json()).then((ev) => { closedEvents.set(s.sessionId, ev); render() })
  }
  return closedEvents.get(s.sessionId)
}
const pill = (s) => `<span class="pill ${CLASS[s.status]}">${ICON[s.status]}${WORD[s.status]}</span>`
// Columna "Ahora": pregunta, herramienta en curso, tareas en background y agentes, o la primera línea de la última respuesta.
const doing = (s) => {
  const extras = []
  if (s.background.length) extras.push(`<span class="tag">${s.background.length === 1 ? `${esc(s.background[0].tool)} en background` : `${s.background.length} en background`}</span>`)
  if (s.agents) extras.push(`<span class="tag">${s.agents} ${s.agents === 1 ? 'agente' : 'agentes'}</span>`)
  if (s.status === 'waiting') return esc(s.waitingQuestion)
  if (s.status === 'background') return `${extras.join('')}${esc(s.background[0].label)}`
  if (s.status === 'busy') return `${s.currentTool ? `<code>${esc(s.currentTool)}</code>` : ''}${extras.join('')}${esc(firstLine(s.lastAnswer?.text)) || (s.currentTool ? '' : 'Pensando')}`
  return `${extras.join('')}${esc(firstLine(s.lastAnswer?.text))}`
}

let sessions = []
let sorted = []
let selectedId = null
let peekOpen = false

const row = (s) => `
  <div class="row ${CLASS[s.status]}${s.sessionId === selectedId ? ' selected' : ''}" role="option" aria-selected="${s.sessionId === selectedId}" tabindex="0" data-id="${s.sessionId}" title="${esc(s.cwd)}">
    ${ICON[s.status]}
    <span class="who"><span class="name">${esc(s.name ?? s.cwd)}${src(s)}</span><span class="branch">${esc(s.branch ?? s.cwd)}</span></span>
    <span class="doing">${doing(s)}</span>
    <span class="run"><b>${esc(modelOf(s))}</b>${esc(s.permissionMode ?? '')}</span>
    ${gauge(s.contextTokens)}
    <span class="num r">${dur((s.status === 'closed' ? s.updatedAt : Date.now()) - s.startedAt)}</span>
    <span class="num r">${s.prompts ? `<b>${s.prompts}</b> / ${s.turns}` : ''}</span>
    <span class="num r">${k(s.outputTokens)}</span>
    <span class="num r"><b>${dur(Date.now() - new Date(sinceOf(s)))}</b></span>
  </div>`

const peek = (s) => `
  <div class="head">${pill(s)}<h1>${esc(s.name ?? s.cwd)}</h1><button class="close" id="close" title="Cerrar (Esc)" aria-label="Cerrar">×</button></div>
  ${s.title && s.title !== s.name ? `<section><h3>Título</h3>${esc(s.title)}</section>` : ''}
  ${s.waitingQuestion ? `<section><div class="question">${esc(s.waitingQuestion)}</div></section>` : ''}
  ${s.status === 'closed' ? `<section><h3>Reanudar<button class="copy" id="copy">copiar</button></h3><pre class="cmd"><code class="language-bash">cd "${esc(s.cwd)}"
claude --resume ${esc(s.sessionId)}</code></pre></section>` : ''}
  <section><h3>Línea de tiempo</h3>${timeline(eventsOf(s), s)}</section>
  ${s.background.length ? `<section><h3>En background</h3>${s.background.map((b) => b.tool === 'Agent' ? `<div class="cmd">Agente: ${esc(b.label)}</div>` : `<pre class="cmd"><code class="language-bash">${esc(b.label)}</code></pre>`).join('')}</section>` : ''}
  <section><h3>Última respuesta</h3><div class="md">${s.lastAnswer ? md(s.lastAnswer.text) : '<span class="prompt">Todavía no ha respondido</span>'}</div></section>
  <section><h3>Tu último prompt</h3><div class="prompt">${esc(s.lastPrompt?.text ?? '')}</div></section>
  ${s.editedFiles.length ? `<section><h3>Ficheros editados</h3><ul class="files">${s.editedFiles.map((f) => `<li><a href="#" data-file="${esc(f)}" title="Abrir en VS Code">${esc(f)}<span>abrir</span></a></li>`).join('')}</ul></section>` : ''}
  <section><h3>Carpeta</h3><span class="path">${esc(s.cwd)}</span></section>`

function render() {
  sorted = [...sessions].sort((a, b) => groupOf(a) - groupOf(b) || b.updatedAt - a.updatedAt)
  if (!sorted.some((s) => s.sessionId === selectedId)) selectedId = sorted[0]?.sessionId ?? null
  const count = (g) => sorted.filter((s) => g.statuses.includes(s.status)).length
  const pending = count(GROUPS[0]) + count(GROUPS[1])
  document.title = `${pending ? `(${pending}) ` : ''}Claude Code Suricata`
  document.getElementById('totals').innerHTML = GROUPS.slice(0, 3).map((g) => { const n = count(g); return `<span class="${n ? '' : 'zero'}"><b>${n}</b>${n === 1 ? g.one : g.many}</span>` }).join('')
  const cols = '<div class="cols"><span></span><span>Sesión</span><span>Ahora</span><span>Modelo</span><span>Contexto</span><span class="r">Abierta</span><span class="r" title="Prompts tuyos / turnos del modelo">Prompts</span><span class="r">Tokens</span><span class="r">Desde</span></div>'
  document.getElementById('list').innerHTML = sorted.length
    ? cols + GROUPS.map((g) => { const rows = sorted.filter((s) => g.statuses.includes(s.status)); return rows.length ? `<h2 class="${CLASS[g.statuses[0]]}">${g.label} <span>${rows.length}</span></h2>${rows.map(row).join('')}` : '' }).join('')
    : '<div class="empty"><div><b>Ninguna sesión abierta</b>Abre Claude Code en una terminal y aparecerá aquí.</div></div>'
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
document.getElementById('peek').addEventListener('click', (e) => {
  if (e.target.closest('#close')) select(selectedId, false)
  const copy = e.target.closest('#copy')
  if (copy) {
    const s = sorted.find((x) => x.sessionId === selectedId)
    navigator.clipboard.writeText(`cd "${s.cwd}"\nclaude --resume ${s.sessionId}`).then(() => { copy.textContent = 'copiado' })
  }
  const a = e.target.closest('a[data-file]')
  if (a) {
    e.preventDefault()
    fetch('/open', { method: 'POST', body: JSON.stringify({ sessionId: selectedId, file: a.dataset.file }) })
      .then((r) => { a.querySelector('span').textContent = r.ok ? 'abierto' : 'no se pudo abrir' })
  }
})
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return
  const i = sorted.findIndex((s) => s.sessionId === selectedId)
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (sorted.length) select(sorted[(i + (e.key === 'ArrowDown' ? 1 : -1) + sorted.length) % sorted.length].sessionId) }
  else if (e.key === 'Enter' && selectedId) select(selectedId, true)
  else if (e.key === 'Escape') select(selectedId, false)
})

const live = document.getElementById('live')
const es = new EventSource('/events')
es.onmessage = (e) => { const d = JSON.parse(e.data); sessions = [...d.sessions, ...d.recent]; for (const s of d.sessions) closedEvents.delete(s.sessionId); live.textContent = 'en directo'; live.classList.remove('off'); render() }
es.onerror = () => { live.textContent = 'sin conexión'; live.classList.add('off') }
const tick = () => { document.getElementById('clock').textContent = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }); if (sessions.length) render() }
setInterval(tick, 30000)
tick()

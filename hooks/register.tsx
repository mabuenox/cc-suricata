// The terminal side of cc-suricata: polls the server's `/snapshot` and shows what matters about your OTHER sessions
// (this one is left out: you are looking at it). A band above the prompt with the next thing to do, the counts in the
// status line, a toast when another session starts asking you, and a `/suricata` pane with the list.
import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'

import type { Finding, Session, Snapshot, Status } from '../types'

const PANE = 'suricata'
const TITLE = 'Suricata'
const POLL_MS = 5_000
const START_EVERY_MS = 60_000 // a server that does not come up is retried, not hammered
const snapshot = atom({ plugin: 'cc-suricata', key: 'snapshot' } as const, null, { shape: 'snapshot-1' })

export const subject = (s: Session): string => s.title ?? s.name ?? s.cwd.split(/[\\/]/).filter(Boolean).pop() ?? s.cwd
export const others = (sessions: Session[], ownId: string): Session[] => sessions.filter((s) => s.sessionId !== ownId)
export const pickNext = (findings: Finding[], ownId: string): Finding | null => findings.find((f) => f.sessionId !== ownId) ?? null

// The same three numbers as the page's header.
export const counts = (sessions: Session[]) => ({
  asking: sessions.filter((s) => s.status === 'waiting').length,
  waiting: sessions.filter((s) => s.status === 'idle').length,
  working: sessions.filter((s) => s.status === 'busy' || s.status === 'background').length,
})
export const statusLine = (c: ReturnType<typeof counts>): string => `suricata · ${c.asking} asking · ${c.waiting} waiting · ${c.working} working`

// Sessions that just started asking: seen before in another state. A session first seen asking is not news, it is the list.
export const newlyAsking = (prev: ReadonlyMap<string, Status>, sessions: Session[]): Session[] =>
  sessions.filter((s) => s.status === 'waiting' && prev.has(s.sessionId) && prev.get(s.sessionId) !== 'waiting')

const RANK: Record<Status, number> = { waiting: 0, busy: 1, background: 1, idle: 2 }
export const sorted = (sessions: Session[]): Session[] => [...sessions].sort((a, b) => RANK[a.status] - RANK[b.status])

// The instant each row's "since" counts from, as the page computes it.
export const sinceOf = (s: Session): number | null => {
  const at = s.status === 'busy' ? s.lastPrompt?.at ?? s.statusSince : s.status === 'background' ? s.background?.[0]?.at ?? s.updatedAt : s.status === 'waiting' ? s.updatedAt : s.statusSince ?? s.updatedAt
  const ms = at == null ? NaN : new Date(at).getTime()
  return Number.isNaN(ms) ? null : ms
}
export const ago = (ms: number): string => (ms < 60_000 ? 'now' : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`)

const GLYPH: Record<Status, { glyph: string; color: string }> = { waiting: { glyph: '?', color: 'warning' }, busy: { glyph: '●', color: 'success' }, background: { glyph: '◐', color: 'success' }, idle: { glyph: '○', color: 'gray' } }
const branchOf = (s: Session): string => (s.branch ? (s.branch.endsWith(' (worktree)') ? `${s.branch.slice(0, -11)} wt` : s.branch) : '')

// Set once by `register` from the manifest's options; the engine checks each poll's `$` against top-level functions.
let port = 4747
let autostart = true
let ownId = ''
let lastStatus: ReadonlyMap<string, Status> = new Map()
let inFlight = false
let lastStartAt = -Infinity

async function start($: EngineInterface) {
  const now = await $.clock.now()
  if (now - lastStartAt < START_EVERY_MS) return
  lastStartAt = now
  // `--daemon` makes the server detach itself and exit: a child of this call would die with the session.
  await $.process.run(['node', `${$.plugin.root}/server.mjs`, '--daemon'], { env: { PORT: String(port) }, timeoutMs: 15_000 }).catch(() => undefined)
}

async function poll($: EngineInterface) {
  if (inFlight) return
  inFlight = true
  ownId = await $.session.id() // read each time: a /clear changes it without a session.start
  try {
    const res = await $.http.fetch(`http://127.0.0.1:${port}/snapshot`).catch(() => null)
    if (!res?.ok) {
      await update($, snapshot, () => ({ down: true }))
      $.ui.status('suricata · off')
      if (autostart) await start($)
      return
    }
    const data = JSON.parse(res.text) as { sessions: Session[]; findings: Finding[]; summary: { text: string | null; at: number } }
    const sessions = others(data.sessions, ownId)
    for (const s of newlyAsking(lastStatus, sessions)) $.ui.toast(`${subject(s)} is asking you`, { timeoutMs: 8_000 })
    lastStatus = new Map(sessions.map((s) => [s.sessionId, s.status]))
    await update($, snapshot, () => ({ down: false, sessions, findings: data.findings, summary: data.summary }))
    $.ui.status(sessions.length ? statusLine(counts(sessions)) : undefined)
  } finally {
    inFlight = false
  }
}

function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: TITLE })
}

export const register: Register = (on, options) => {
  port = Number(options.port ?? 4747)
  autostart = options.autostart !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'suricata', description: 'Your other Claude Code sessions: who is asking you, who is waiting, who is working' })
    void poll($)
    $.clock.every(POLL_MS, () => void poll($))

    return next(e)
  })

  on('command.run', { command: 'suricata' }, async ($) => {
    const opened = await openPane($)

    return { text: opened.isPlaced ? 'Suricata pane opened.' : `Suricata pane opened, not drawn yet: ${opened.reason}` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    const nextAction = snap && !snap.down ? pickNext(snap.findings, ownId) : null
    if (e.props.hasSurvey || nextAction === null) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)

    return (
      <Box gap={1}>
        <Text bold color="warning">Next</Text>
        <Text wrap="truncate-end">{nextAction.text}</Text>
        <Button key="pane" hotkey="s" plain onPress={() => void openPane($)}>sessions</Button>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    if (snap === null) return <Text dimColor>Looking at your sessions…</Text>
    if (snap.down) return <Text dimColor>The cc-suricata server is not running{autostart ? ', starting it' : ''}.</Text>
    if (snap.sessions.length === 0) return <Text dimColor>No other session open.</Text>
    const now = await $.clock.now()
    const nextAction = pickNext(snap.findings, ownId)

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Text dimColor>{statusLine(counts(snap.sessions)).slice(11)}</Text>
        {nextAction !== null && <Text wrap="wrap"><Text bold color="warning">Next </Text>{nextAction.text}</Text>}
        <Box flexDirection="column">
          {sorted(snap.sessions).map((s) => {
            const since = sinceOf(s)

            return (
              <Box key={s.sessionId} gap={1}>
                <Text color={GLYPH[s.status].color}>{GLYPH[s.status].glyph}</Text>
                <Text bold wrap="truncate-end">{subject(s)}</Text>
                <Text dimColor wrap="truncate-end">{[branchOf(s), since === null ? '' : ago(now - since)].filter(Boolean).join(' · ')}</Text>
              </Box>
            )
          })}
        </Box>
        {snap.summary.text !== null && <Text dimColor wrap="wrap">{snap.summary.text}</Text>}
      </Box>
    )
  })
}

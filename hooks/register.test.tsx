import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { ago, counts, newlyAsking, pickNext, sinceOf, sorted, subject } from './register'
import type { Session, Status } from '../types'

const session = (sessionId: string, status: Status, title: string | null = null): Session => ({ sessionId, status, title, name: `workspace-${sessionId}`, cwd: `C:\\Workspace\\${sessionId}`, branch: 'main', updatedAt: 1_000 })

const OWN = 'me'
const payload = (sessions: Session[], findings = sessions.filter((s) => s.status === 'waiting').map((s) => ({ kind: 'wait', sessionId: s.sessionId, text: `${subject(s)} is asking you` }))) =>
  JSON.stringify({ sessions, findings, summary: { text: null, at: 0 } })

const BAND = { plugin: 'cc-suricata', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} } } as const
const PANE = { plugin: 'cc-suricata', component: 'Pane', requestId: 'suricata', props: { title: 'Suricata', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } } as const

// The engine beneath the plugin: each answer is what a session would give.
function engine(on: On, answer: () => { ok: boolean; text: string }) {
  const seen = { toasts: [] as string[], runs: [] as (readonly string[])[], status: [] as (string | undefined)[] }
  on('session.id', () => ({ value: OWN }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'suricata' } }))
  on('http.fetch', () => {
    const { ok, text } = answer()
    return { value: { status: ok ? 200 : 503, ok, headers: {}, text } }
  })
  on('process.run', (_, e) => {
    seen.runs.push(e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  return seen
}

test('pickNext skips this session: the band is about the others', () => {
  const findings = [{ kind: 'wait', sessionId: OWN, text: 'me' }, { kind: 'wait', sessionId: 'b', text: 'b' }]
  expect(pickNext(findings, OWN)?.sessionId).toBe('b')
  expect(pickNext([findings[0]!], OWN)).toBe(null)
})

test('counts, order and since follow the page', () => {
  const list = [session('a', 'idle'), session('b', 'busy'), session('c', 'waiting'), session('d', 'background')]
  expect(counts(list)).toEqual({ asking: 1, waiting: 1, working: 2 })
  expect(sorted(list).map((s) => s.sessionId)).toEqual(['c', 'b', 'd', 'a'])
  expect(sinceOf({ ...session('a', 'idle'), statusSince: '2026-01-01T00:00:00Z' })).toBe(Date.parse('2026-01-01T00:00:00Z'))
  expect(sinceOf({ ...session('a', 'idle'), statusSince: null, updatedAt: null })).toBe(null)
  expect([ago(30_000), ago(120_000), ago(5_400_000)]).toEqual(['now', '2 min', '1.5 h'])
})

test('newlyAsking: a transition into waiting, not a session first seen asking', () => {
  const prev = new Map<string, Status>([['a', 'busy'], ['b', 'waiting']])
  const now = [session('a', 'waiting'), session('b', 'waiting'), session('c', 'waiting')]
  expect(newlyAsking(prev, now).map((s) => s.sessionId)).toEqual(['a'])
})

test('the band shows the next action of another session, on the terminal and the desktop', async ($, on) => {
  mock.clock(on)
  engine(on, () => ({ ok: true, text: payload([session(OWN, 'waiting', 'Mine'), session('b', 'waiting', 'Orders list pagination')]) }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /asking/ }))?.text).toBe('Orders list pagination is asking you')
    await ui.unmount()
  }
})

test('nothing from the others: the band is left to the engine', async ($, on) => {
  mock.clock(on)
  engine(on, () => ({ ok: true, text: payload([session(OWN, 'waiting', 'Mine')]) }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test('a toast when another session starts asking, once; the status line carries the counts', async ($, on) => {
  const clock = mock.clock(on)
  let list = [session('b', 'busy', 'Orders list pagination')]
  const seen = engine(on, () => ({ ok: true, text: payload(list) }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle() // the first poll is not awaited by session.start
  expect(seen.status.at(-1)).toBe('suricata · 0 asking · 0 waiting · 1 working')

  list = [session('b', 'waiting', 'Orders list pagination')]
  await clock.advance(5_000)
  await clock.advance(5_000)
  expect(seen.toasts).toEqual(['Orders list pagination is asking you'])
  expect(seen.status.at(-1)).toBe('suricata · 1 asking · 0 waiting · 0 working')
})

test('a server that does not answer is started with --daemon, at most once a minute', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, () => ({ ok: false, text: '' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(5_000)
  expect(seen.runs.length).toBe(1)
  expect(seen.runs[0]?.slice(-1)).toEqual(['--daemon'])
  expect(seen.status.at(-1)).toBe('suricata · off')

  await clock.advance(60_000)
  expect(seen.runs.length).toBe(2)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /not running/ }))?.text).toBe('The cc-suricata server is not running, starting it.')
  await ui.unmount()
})

test('the pane lists the other sessions, asking first', async ($, on) => {
  mock.clock(on)
  engine(on, () => ({ ok: true, text: payload([session(OWN, 'waiting', 'Mine'), session('a', 'idle', 'Docs'), session('b', 'waiting', 'Orders list pagination')]) }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^1 asking/ }))?.text).toBe('1 asking · 1 waiting · 0 working')
  expect(await ui.find({ type: 'Text', text: /Mine/ })).toBe(undefined)
  expect((await ui.find({ type: 'Text', text: /^Orders/ }))?.text).toBe('Orders list pagination')
  await ui.unmount()
})

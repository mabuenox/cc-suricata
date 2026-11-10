// Each fixture is a minimal, anonymised transcript with the real shape of Claude Code's records.
// One fixture per case: tally caches by path.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { readTranscript, tally, derive } from '../transcript.mjs'

const fx = (name) => fileURLToPath(new URL(`./fixtures/${name}.jsonl`, import.meta.url))
const ms = (iso) => Date.parse(iso)
const registry = (over) => ({ sessionId: 'x', status: 'idle', startedAt: ms('2026-01-01T09:00:00Z'), statusUpdatedAt: 1, ...over })

test('pending question, title, last typed prompt and files relative to the folder', () => {
  const t = readTranscript(fx('ask'), 'C:\\Workspace\\acme-shop')
  assert.equal(t.waitingQuestion, 'Ascending or descending?')
  assert.equal(t.currentTool, null)
  assert.equal(t.title, 'Orders list pagination')
  assert.equal(t.lastPrompt.text, 'And sort by date') // not the task-notification that follows
  assert.equal(t.permissionMode, 'plan')
  assert.deepEqual([t.prompts, t.turns], [2, 3])
  assert.equal(t.lastAnswer.text, 'Done: pages of 20.')
  assert.equal(t.lastTurnEndedAt, '2026-01-01T10:02:00.000Z')
  assert.equal(t.model, 'claude-opus-5-5') // the model's last message
  assert.equal(t.contextTokens, 2220)
  assert.deepEqual(t.editedFiles, ['src\\orders\\list.tsx'])
  assert.equal(derive(registry({ status: 'busy' }), t).status, 'waiting')
})

test('edited files are relative to the folder with the separator of the OS of the transcript', () => {
  assert.deepEqual(readTranscript(fx('posix-paths'), '/home/user/acme-shop').editedFiles, ['src/x.ts'])
})

test('background task whose completion notification already arrived', () => {
  const t = readTranscript(fx('bg-notified'))
  assert.deepEqual(t.background, [])
  assert.equal(derive(registry(), t).status, 'idle')
})

test('background task whose completion notice came as a queue-operation and an attachment, not a user message', () => {
  const t = readTranscript(fx('bg-notified-queue')) // the shape since late 2026: the page showed these as "in background" for days
  assert.deepEqual(t.background, [])
  assert.equal(derive(registry(), t).status, 'idle')
})

test('asynchronous agents: launched at once, alive until their hand-back arrives', () => {
  const t = readTranscript(fx('agent-async'))
  assert.deepEqual(t.background.map((b) => [b.tool, b.label]), [['Agent', 'Explore mod API']]) // the server one handed back
  const s = derive(registry(), t)
  assert.deepEqual([s.status, s.agents], ['background', 1])
})

test('a workflow is a background task named after its script, until its task notification', () => {
  const t = readTranscript(fx('workflow-bg'))
  assert.deepEqual(t.background.map((b) => [b.tool, b.label]), [['Workflow', 'qa-stories']]) // guard-check completed
  assert.equal(derive(registry(), t).status, 'background')
})

test('readTranscript: your own title beats the automatic one; the PR and the away summary are the latest', () => {
  const t = readTranscript(fx('meta'))
  assert.equal(t.title, 'cc-suricata')
  assert.deepEqual(t.pr, { number: 6, url: 'https://github.com/mabuenox/cc-suricata/pull/6', repo: 'mabuenox/cc-suricata' })
  assert.deepEqual(t.away, { text: 'You were opening PR #6 for the terminal mod; next step: ask for a review.', at: '2026-11-10T09:16:00.000Z' })
})

test('tally: compactions in the timeline, measured turn durations, and the last cost and tools totals', () => {
  const r = tally(fx('meta'))
  assert.deepEqual(r.events.map(([, k]) => k), ['p', 'e', 'c', 'p', 'e'])
  assert.deepEqual(r.turnDurations.map(([, ms]) => ms), [180000, 60000])
  assert.deepEqual(r.tools, ['Skill', 'Bash', 'Edit', 'Write'])
  assert.deepEqual(r.cost, { usd: 2.25, apiMs: 200000, toolMs: 45000, linesAdded: 25, linesRemoved: 3, models: [{ model: 'claude-fable-5-1', usd: 2.15, outputTokens: 1500 }, { model: 'claude-haiku-5-5', usd: 0.1, outputTokens: 50 }] })
  const s = derive(registry({ startedAt: ms('2026-11-10T09:05:00Z') }), readTranscript(fx('meta')), r)
  assert.deepEqual([s.cost.usd, s.tools.length, s.turnDurations.length, s.events.length], [2.25, 4, 1, 3]) // totals are the file's; events and durations, this process's
})

test('a registry wait (permission prompt, plan approval…) is "waiting" with its reason', () => {
  const t = readTranscript(fx('bg-notified')) // no pending question in the transcript
  const s = derive(registry({ status: 'waiting', waitingFor: 'approve Bash: npm test' }), t)
  assert.deepEqual([s.status, s.waitingQuestion], ['waiting', 'approve Bash: npm test'])
  assert.deepEqual(derive(registry({ status: 'waiting' }), t).waitingQuestion, '(waiting)')
})

test('background task stopped with TaskStop (by the task id from the result)', () => {
  const t = readTranscript(fx('bg-stopped'))
  assert.deepEqual(t.background, [])
})

test('live background tasks: command and agent, and a resume discards them', () => {
  const t = readTranscript(fx('bg-running')) // ends with a TaskStop without id: must not count as stopping anything
  assert.deepEqual(t.background.map((b) => [b.tool, b.label]), [['Bash', 'pnpm test:e2e'], ['Agent', 'Review the diff']])
  const live = derive(registry(), t)
  assert.equal(live.status, 'background')
  assert.equal(live.agents, 1)
  // Process started after they were launched (session resumed after a reboot): they died with the previous process.
  const resumed = derive(registry({ startedAt: ms('2026-01-01T11:00:00Z') }), t)
  assert.deepEqual(resumed.background, [])
  assert.equal(resumed.status, 'idle')
})

test('subagents (isSidechain) do not count as prompt, answer or event', () => {
  const t = readTranscript(fx('sidechain'))
  assert.equal(t.lastPrompt.text, 'Find where VAT is calculated')
  assert.equal(t.lastAnswer.text, 'VAT is calculated in `src/tax.ts`.')
  const { total, events } = tally(fx('sidechain'))
  assert.equal(total, 125) // the subagent's tokens are still paid for
  assert.deepEqual(events, [[ms('2026-01-01T10:00:00Z'), 'p'], [ms('2026-01-01T10:00:45Z'), 'e']])
})

test('tally: incremental tokens and events, and the timeline starts at the current process', () => {
  const r = tally(fx('bg-notified'))
  assert.equal(r.total, 22)
  assert.deepEqual(r.events.map(([, k]) => k), ['p', 'e', 'e'])
  assert.equal(tally(fx('bg-notified')), r) // second call: nothing new to read, same object
  const s = derive(registry({ startedAt: ms('2026-01-01T10:01:00Z') }), readTranscript(fx('bg-notified')), r)
  assert.equal(s.outputTokens, 22)
  assert.deepEqual(s.events, [[ms('2026-01-01T10:03:05Z'), 'e']])
})

test('readTranscript: the branch is the one of the last record, empty when the records have none', () => {
  assert.equal(readTranscript(fx('ask'), 'C:\Workspace\acme-shop').branch, 'feat/pagination') // the first record says main
  assert.equal(readTranscript(fx('bg-notified')).branch, '')
})

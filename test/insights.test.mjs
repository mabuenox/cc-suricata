import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findings, signature, summaryPrompt, summaryCommand } from '../insights.mjs'

const NOW = 1767265320000
const min = (n) => NOW - n * 60_000
const live = (over) => ({ sessionId: 's1', name: 'acme-shop', cwd: 'C:\\acme', status: 'busy', updatedAt: min(1), statusSince: min(1), background: [], contextTokens: 50_000, prompts: 3, turns: 5, lastPrompt: { at: min(1), text: 'go' }, lastAnswer: { text: 'Done.\nMore.' }, waitingQuestion: null, ...over })

test('findings: a long wait for you, a near-full context and an old background task, each pointing at its session', () => {
  assert.deepEqual(findings([live()], NOW), [])
  assert.deepEqual(findings([live({ status: 'idle', statusSince: min(14) })], NOW), []) // under the threshold
  assert.deepEqual(findings([live({ status: 'idle', statusSince: min(42) })], NOW), [{ kind: 'wait', sessionId: 's1', text: 'acme-shop has been waiting for you for 42 min' }])
  assert.deepEqual(findings([live({ status: 'waiting', updatedAt: min(100), statusSince: null })], NOW).map((f) => f.text), ['acme-shop has been asking you for 1.7 h'])
  assert.deepEqual(findings([live({ contextTokens: 180_000 })], NOW).map((f) => f.text), ['acme-shop is at 90 % of its context'])
  assert.deepEqual(findings([live({ status: 'background', background: [{ tool: 'Bash', label: 'npm test', at: min(31) }] })], NOW).map((f) => f.text), ['acme-shop has had Bash running in the background for 31 min'])
})

test('signature: unchanged when a duration grows, changed when a session changes state or a finding appears', () => {
  const a = live({ status: 'idle', statusSince: min(10) })
  const later = { ...a, statusSince: min(14) }
  assert.equal(signature([a], findings([a], NOW)), signature([later], findings([later], NOW)))
  assert.notEqual(signature([a], findings([a], NOW)), signature([{ ...a, status: 'busy' }], []))
  const longer = { ...a, statusSince: min(20) }
  assert.notEqual(signature([a], findings([a], NOW)), signature([longer], findings([longer], NOW)))
})

test('summaryPrompt: the findings and one line per session with the facts, and only the first line of an answer', () => {
  const s = live({ status: 'idle', statusSince: min(42) })
  const p = summaryPrompt([s], findings([s], NOW), NOW)
  assert.match(p, /^Findings:\n- acme-shop has been waiting for you for 42 min$/m)
  assert.match(p, /^- acme-shop \| idle for 42 min \| context 25 % \| 3 prompts, 5 turns \| last answer: Done\.$/m)
  assert.doesNotMatch(p, /More\./)
  assert.match(summaryPrompt([live()], [], NOW), /^Findings: none$/m)
})

test('summaryCommand: claude -p with nothing that writes under ~/.claude or runs hooks', () => {
  const { cmd, args } = summaryCommand()
  assert.equal(cmd, 'claude')
  for (const flag of ['-p', '--no-session-persistence', '--strict-mcp-config']) assert.ok(args.includes(flag), flag)
  assert.equal(args[args.indexOf('--settings') + 1], '{"disableAllHooks":true}')
})

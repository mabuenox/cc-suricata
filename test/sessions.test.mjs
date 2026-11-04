import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { gitBranch, readHistory, isOwnSession, isAlive, recentSessions, openTarget } from '../sessions.mjs'

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))
const repo = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'suricata-'))
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  return dir
}

test('gitBranch: branch, detached head, worktree with a relative gitdir', () => {
  assert.equal(gitBranch(repo({ '.git/HEAD': 'ref: refs/heads/feat/retries\n' })), 'feat/retries')
  assert.equal(gitBranch(repo({ '.git/HEAD': 'a1f3c9e0d2b4c6e8\n' })), 'a1f3c9e')
  const root = repo({ 'main/.git/HEAD': 'ref: refs/heads/main\n', 'main/.git/worktrees/wt/HEAD': 'ref: refs/heads/fix/cart\n', 'wt/.git': 'gitdir: ../main/.git/worktrees/wt\n' })
  assert.equal(gitBranch(join(root, 'wt')), 'fix/cart')
})

test('gitBranch: nothing to show is an empty string, never an exception (not a repo, UNC gitdir)', () => {
  const error = mock.method(console, 'error', () => {})
  assert.equal(gitBranch(repo({})), '')
  assert.equal(gitBranch(repo({ '.git': 'gitdir: \\\\evil\\share\\repo\\.git\n' })), '') // would make a network request with credentials
  assert.equal(gitBranch(repo({ '.git': 'gitdir: //evil/share/repo/.git\n' })), '')
  assert.equal(gitBranch(join(repo({}), 'missing')), '')
  assert.equal(error.mock.callCount(), 0) // absence is expected: nothing to report
  error.mock.restore()
})

test('gitBranch: an unreadable HEAD is reported and still shows nothing', () => {
  const error = mock.method(console, 'error', () => {})
  assert.equal(gitBranch(repo({ '.git/HEAD/placeholder': '' })), '') // HEAD is a directory: EISDIR, not a missing file
  assert.equal(error.mock.callCount(), 1)
  assert.match(error.mock.calls[0].arguments[0], /git branch of /)
  error.mock.restore()
})

test('readHistory: one entry per session with prompt count, first prompt and time span', () => {
  const h = readHistory(join(fixtures, 'history.jsonl'))
  assert.equal(h.size, 4)
  assert.deepEqual(h.get('hist-live'), { project: 'C:\\Workspace\\acme-shop', first: 'Add pagination to the list', firstAt: 1767261600000, lastAt: 1767261900000, n: 2 })
  assert.equal(readHistory(join(fixtures, 'history.jsonl')), h) // unchanged file: same object
  assert.equal(readHistory(join(fixtures, 'missing.jsonl')).size, 0)
})

test('isOwnSession: interactive, with a folder outside the temp dir', () => {
  const s = { kind: 'interactive', cwd: 'C:\\Workspace\\acme-shop' }
  assert.equal(isOwnSession(s, 'C:\\Temp'), true)
  assert.equal(isOwnSession({ ...s, kind: 'sdk' }, 'C:\\Temp'), false)
  assert.equal(isOwnSession({ ...s, cwd: 'c:\\temp\\claude\\plugin-run' }, 'C:\\Temp'), false) // plugins' claude -p runs
  assert.equal(isOwnSession({ ...s, cwd: undefined }, 'C:\\Temp'), false)
})

test('isAlive: this process yes, an unlikely pid no', () => {
  assert.equal(isAlive(process.pid), true)
  assert.equal(isAlive(2 ** 22 - 1), false)
})

test('recentSessions: closed sessions from the history, newest first, skipping live, temp and transcript-less ones', () => {
  const history = readHistory(join(fixtures, 'history.jsonl'))
  const transcriptOf = (id) => (id === 'hist-closed' ? join(fixtures, 'ask.jsonl') : null)
  const out = recentSessions(history, new Set(['hist-live']), transcriptOf, '/tmp')
  assert.deepEqual(out.map((s) => s.sessionId), ['hist-closed'])
  const [s] = out
  assert.equal(s.status, 'closed')
  assert.equal(s.name, 'Orders list pagination') // the transcript title beats the first prompt
  assert.equal(s.cwd, 'C:\\Workspace\\docs-site')
  assert.deepEqual([s.startedAt, s.updatedAt], [1767262200000, 1767262200000])
  assert.equal(s.lastAnswer.text, 'Done: pages of 20.')
  assert.equal(s.branch, '')
})

test('openTarget: only a file the watcher listed for that session, and only if it exists', () => {
  const sessions = [{ sessionId: 's1', cwd: fixtures, editedFiles: ['ask.jsonl', 'deleted.jsonl'] }]
  assert.equal(openTarget(sessions, 's1', 'ask.jsonl'), join(fixtures, 'ask.jsonl'))
  assert.throws(() => openTarget(sessions, 's1', 'history.jsonl'), /not listed/)
  assert.throws(() => openTarget(sessions, 's2', 'ask.jsonl'), /not listed/)
  assert.throws(() => openTarget(sessions, 's1', 'deleted.jsonl'), /not a file/)
})

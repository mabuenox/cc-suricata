// Sessions: the live registry (~/.claude/sessions), the closed-session index (~/.claude/history.jsonl),
// the git branch of a folder and the "open in VS Code" check. Paths are parameters so it runs on fixtures.
import { readFileSync, statSync } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'
import { readTranscript } from './transcript.mjs'

// Git branch of the folder without running git: reads .git/HEAD (or a worktree's gitdir).
// Returns '' when there is nothing to show: the branch is decorative and must never break the list.
export function gitBranch(cwd) {
  try {
    let gitDir = join(cwd, '.git')
    if (!statSync(gitDir).isDirectory()) gitDir = readFileSync(gitDir, 'utf8').replace(/^gitdir:\s*/, '').trim()
    gitDir = resolve(cwd, gitDir) // relative to the worktree; resolved before looking at the root
    if (gitDir.startsWith('\\\\') || gitDir.startsWith('//')) return '' // a UNC path (\\host\…) would make a network request with credentials
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    return head.startsWith('ref: refs/heads/') ? head.slice(16) : head.slice(0, 7)
  } catch (err) {
    if (!['ENOENT', 'ENOTDIR'].includes(err.code)) console.error(`git branch of ${cwd}:`, err.message) // not a repo is expected; anything else is not
    return ''
  }
}

// history.jsonl (one line per prompt with project, sessionId and timestamp) is the cheap index of closed sessions.
const histories = new Map() // path -> { size, bySession }
export function readHistory(path) {
  const cached = histories.get(path) ?? { size: -1, bySession: new Map() }
  let size
  try {
    size = statSync(path).size
  } catch {
    return cached.bySession // no history yet: nothing closed to show
  }
  if (size === cached.size) return cached.bySession
  const bySession = new Map() // sessionId -> { project, first, firstAt, lastAt, n }
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    const h = bySession.get(r.sessionId) ?? { project: r.project, first: r.display, firstAt: r.timestamp, lastAt: r.timestamp, n: 0 }
    h.n++
    h.lastAt = r.timestamp
    bySession.set(r.sessionId, h)
  }
  histories.set(path, { size, bySession })
  return bySession
}

const underTemp = (cwd, tmp) => cwd.toLowerCase().startsWith(tmp.toLowerCase())

// Your sessions: interactive ones with a folder. Plugins' `claude -p` runs (remember-summarizer…) start from the temp folder.
export const isOwnSession = (s, tmp) => s.kind === 'interactive' && !!s.cwd && !underTemp(s.cwd, tmp)

export function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Closed sessions, newest first. The transcript no longer changes, so its tail is read once per session.
const closedCache = new Map() // sessionId -> readTranscript(), or null when the transcript is gone
export function recentSessions(history, liveIds, transcriptOf, tmp, limit = 20) {
  const out = []
  for (const [id, h] of [...history].sort((a, b) => b[1].lastAt - a[1].lastAt)) {
    if (liveIds.has(id)) { closedCache.delete(id); continue } // resumed: the cached data would be stale when it closes again
    if (!h.project || underTemp(h.project, tmp)) continue
    if (!closedCache.has(id)) { const path = transcriptOf(id); closedCache.set(id, path ? readTranscript(path, h.project) : null) }
    const t = closedCache.get(id)
    if (!t?.lastAnswer) continue // empty sessions (just a /clear, a /resume…) add nothing
    out.push({ ...t, sessionId: id, cwd: h.project, name: t.title ?? h.first.split('\n')[0].slice(0, 80), startedAt: h.firstAt, updatedAt: h.lastAt, prompts: t.prompts ?? h.n, status: 'closed', background: [], agents: 0, currentTool: null, waitingQuestion: null, branch: '' })
    if (out.length === limit) break
  }
  return out
}
export const forgetClosed = (id) => closedCache.delete(id)

// The file to open in VS Code: only one the watcher listed for that session, and only if it exists.
export function openTarget(sessions, sessionId, file) {
  const s = sessions.find((x) => x.sessionId === sessionId)
  if (!s || !s.editedFiles.includes(file)) throw new Error('file not listed')
  const abs = isAbsolute(file) ? file : join(s.cwd, file)
  let isFile = false
  try {
    isFile = statSync(abs).isFile()
  } catch {}
  if (!isFile) throw new Error('not a file')
  return abs
}

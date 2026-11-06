// What a colleague would notice looking at the list: a few rules over the live sessions, and the prompt
// and argv of a `claude -p` call that writes the two-sentence version. Pure, so it runs under test; server.mjs spawns.

const MIN = 60_000
const WAIT = 15 * MIN // waiting for you longer than this is worth a nudge
const BACKGROUND = 30 * MIN
const CONTEXT = 85 // % of the estimated window
const ago = (ms) => (ms < 90 * MIN ? `${Math.round(ms / MIN)} min` : `${(ms / 3600e3).toFixed(1)} h`)
// shortcut: the window is estimated like the page's gauge (200k, or 1M above it), until Claude Code exposes it.
const contextPct = (s) => (s.contextTokens ? Math.round((s.contextTokens / (s.contextTokens > 200_000 ? 1_000_000 : 200_000)) * 100) : 0)
// Same reading as the page's "since" column for a session that needs you; the transcript-derived question has no registry time.
const waitingSince = (s) => (s.status === 'idle' ? s.statusSince ?? s.updatedAt : s.updatedAt)

// Facts worth a look, each pointing at its session: [{ kind, sessionId, text }].
export function findings(sessions, now) {
  const out = []
  for (const s of sessions) {
    const name = s.name ?? s.cwd
    if (['waiting', 'idle'].includes(s.status) && now - new Date(waitingSince(s)) > WAIT) {
      out.push({ kind: 'wait', sessionId: s.sessionId, text: `${name} has been ${s.status === 'waiting' ? 'asking you' : 'waiting for you'} for ${ago(now - new Date(waitingSince(s)))}` })
    }
    if (contextPct(s) > CONTEXT) out.push({ kind: 'context', sessionId: s.sessionId, text: `${name} is at ${contextPct(s)} % of its context` })
    const oldest = s.background?.find((b) => now - new Date(b.at) > BACKGROUND)
    if (oldest) out.push({ kind: 'background', sessionId: s.sessionId, text: `${name} has had ${oldest.tool} running in the background for ${ago(now - new Date(oldest.at))}` })
  }
  return out
}

// Changes when a session appears, leaves or changes state, or a finding appears or disappears; never when a duration grows.
export const signature = (sessions, found) => [...sessions.map((s) => `${s.sessionId}:${s.status}`), ...found.map((f) => `${f.sessionId}:${f.kind}`)].join(',')

const firstLine = (t) => (t ?? '').split('\n').find((l) => l.trim())?.slice(0, 160) ?? ''
export function summaryPrompt(sessions, found, now) {
  const line = (s) => {
    const since = s.status === 'busy' ? s.lastPrompt?.at ?? s.updatedAt : s.status === 'background' ? s.background[0]?.at ?? s.updatedAt : waitingSince(s)
    const doing = s.status === 'waiting' ? `asking: ${firstLine(s.waitingQuestion)}` : `last answer: ${firstLine(s.lastAnswer?.text)}`
    return `- ${s.name ?? s.cwd} | ${s.status} for ${ago(now - new Date(since))} | context ${contextPct(s)} % | ${s.prompts ?? 0} prompts, ${s.turns ?? 0} turns | ${doing}`
  }
  return [
    'You are looking over the Claude Code sessions of one developer. In two or three sentences, in English, tell them what a colleague glancing at this would point out: long waits for them, sessions near their context limit, background work that never ends, anything odd.',
    'Use only the facts below and name sessions exactly as written. If nothing stands out, say so in one sentence. No preamble, no list, no markdown.',
    '',
    `Findings:${found.length ? '' : ' none'}`,
    ...found.map((f) => `- ${f.text}`),
    '',
    'Sessions:',
    ...sessions.map(line),
    '',
    'Answer in English, whatever language the sessions are in.', // last, where it weighs most: the facts above are often in another language
  ].join('\n')
}

// `claude -p` reading the prompt from stdin: no hooks, no MCP servers, no tools and no transcript, so the call costs seconds, not half a minute,
// and leaves nothing under ~/.claude for the watcher to react to. Run from the temp folder, where the list hides plugin runs too.
export const summaryCommand = () => ({ cmd: 'claude', args: ['-p', '--no-session-persistence', '--model', 'haiku', '--output-format', 'text', '--tools', '', '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--disable-slash-commands'] })

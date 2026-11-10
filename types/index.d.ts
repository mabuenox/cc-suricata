// What the mod keeps: the last `/snapshot` the server answered, with this session left out, or `down` when it did not answer.
export type Status = 'waiting' | 'busy' | 'background' | 'idle'

export type Session = {
  sessionId: string
  cwd: string
  status: Status
  title?: string | null
  name?: string | null
  branch?: string
  updatedAt?: number | string | null
  statusSince?: number | string | null
  lastPrompt?: { at: string } | null
  background?: { at: string }[]
}

export type Finding = { kind: string; sessionId: string; text: string }

export type Snapshot =
  | { down: true }
  | { down: false; sessions: Session[]; findings: Finding[]; summary: { text: string | null; at: number } }

declare module 'claude-code' {
  interface PluginState {
    'cc-suricata': { snapshot: Shaped<Snapshot | null> }
  }
}

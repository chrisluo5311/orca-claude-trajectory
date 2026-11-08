// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
// Everything here is plain JSON. Text fields hold short previews that src/redact.ts has
// already cleaned and masked; the panel never receives a whole prompt, reply or tool output.

export type SubCall = {
  id: string
  tool: string
  summary: string
  at: number
  ms: number | null
  done: boolean
  isError: boolean
}

export type Call = SubCall & {
  /** The call's input as [name, value] pairs, each value one line and cut short. */
  input: [string, string][]
  /** The first lines of its result. */
  lines: string[]
  /** The result's size in characters, and its share of the next request in tokens. */
  chars: number | null
  tokens: number | null
  /** For an Agent (Task) call: the subagent's type and the calls it made. */
  agentType: string | null
  sub: SubCall[]
}

export type Step = {
  n: number
  /** When the request was sent, its first block came back, and its last. */
  at: number
  firstAt: number | null
  endedAt: number | null
  status: 'streaming' | 'done'
  /** Input tokens (fresh + cache read + cache write), output tokens, the cached part. */
  input: number | null
  output: number | null
  cacheRead: number
  text: string
  stopReason: string | null
  model: string | null
  isCompacted: boolean
  calls: Call[]
}

export type Turn = {
  n: number
  at: number
  prompt: string
  chars: number
  tokens: number | null
  /** Requests whose prompt fell before what was read. */
  earlier: boolean
  steps: Step[]
}

export type Trajectory = {
  turns: Turn[]
  /** Estimated tokens every request carries before the conversation, or null when unknown. */
  overhead: number | null
  /** The transcript was longer than what is read: its oldest part is left out. */
  truncated: boolean
  requests: number
  calls: number
  tps: number | null
  /** What the next request sends at least: the last one's input and its reply. */
  next: number | null
}

export type SessionInfo = { id: string; title: string; updatedAt: number }
export type WorkspaceInfo = { id: string; name: string }

export type TrajectoryAnswer = {
  workspaces: WorkspaceInfo[]
  workspaceId: string | null
  sessions: SessionInfo[]
  sessionId: string | null
  data: Trajectory | null
  /** Why there is nothing to show, when there isn't. */
  notice: string | null
}

declare module 'orca' {
  interface PluginRequests {
    /** The trajectory of one Claude Code session; omitted ids pick the focused workspace and its newest session. */
    'trajectory.get': {
      input: { workspaceId?: string | null; sessionId?: string | null }
      output: TrajectoryAnswer
    }
  }
  interface PluginPanelEvents {
    /** The watched session's transcript changed: ask again. */
    'trajectory.changed': { sessionId: string }
  }
}

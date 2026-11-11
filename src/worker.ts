// The plugin's worker: finds the focused workspace's Claude Code sessions,
// reads the chosen one's transcript (read-only), and answers the panel with
// its trajectory. It watches that transcript and tells open panels when it
// changes, so the panel follows a session as it runs.
//
// It never writes a file, runs a command or opens a connection. What it sends
// the panel is short previews, cleaned and masked (src/redact.ts).

import type { OrcaWorkerApi } from 'orca/worker'
import { watch, type FSWatcher } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { claudeHome, listSessions, readSubagents, SESSION_ID, TranscriptCache } from './locate.ts'
import { isAgentTool } from './format.ts'
import { build } from './transcript.ts'
import type { Trajectory, TrajectoryAnswer, WorkspaceInfo } from './protocol.ts'
import { cut, stripControls } from './redact.ts'

const MAX_ANSWER = 384 * 1024 // well under what a request may answer (1 MiB) and a panel may draw (512 KiB)
const DEBOUNCE_MS = 600

type Workspace = { id: string; name: string; path: string; branch: string | null; hostId: string | null }

const normBranch = (b: string | null | undefined): string => (b ?? '').replace(/^refs\/heads\//, '')
const label = (s: string): string => cut(stripControls(s).replace(/\s+/g, ' ').trim(), 80) || 'Workspace'

// Workspaces on this machine: a transcript can only be read where it was written.
async function localWorkspaces(orca: OrcaWorkerApi): Promise<Workspace[]> {
  const { workspaces } = await orca.host.call('workspace.list', {})
  return workspaces
    .filter((w) => (w.hostId == null || w.hostId === 'local') && typeof w.path === 'string' && isAbsolute(w.path))
    .map((w) => ({ id: w.id, name: w.name, path: w.path, branch: w.branch, hostId: w.hostId }))
}

// The workspace Orca has focused. Orca names it by display name and branch,
// which several workspaces can share; the one with the newest session wins.
async function focusedWorkspace(orca: OrcaWorkerApi, all: Workspace[], home: string): Promise<Workspace | null> {
  const ctx = await orca.host.call('workspace.readContext', {}).catch(() => null)
  if (!ctx) return null
  const matches = all.filter((w) => w.name === ctx.displayName && normBranch(w.branch) === normBranch(ctx.branch))
  if (matches.length <= 1) return matches[0] ?? null
  let best: { w: Workspace; at: number } | null = null
  for (const w of matches) {
    const { sessions } = await listSessions(home, w.path)
    const at = sessions[0]?.updatedAt ?? -1
    if (!best || at > best.at) best = { w, at }
  }
  return best?.w ?? null
}

// Drops the FIXED breakdown, then the oldest turns, then the oldest requests of
// what is left, until the answer fits what a request may carry and a panel may
// draw: the conversation matters more than what the overhead is made of.
export function fit(answer: TrajectoryAnswer): TrajectoryAnswer {
  const data = answer.data
  if (!data) return answer
  while (JSON.stringify(answer).length > MAX_ANSWER) {
    if (data.fixed) {
      data.fixed = null
      data.fixedTrimmed = true
      continue
    }
    if (data.turns.length > 1) data.turns.shift()
    else if (data.turns[0] && data.turns[0].steps.length > 1) data.turns[0].steps.shift()
    else if (data.turns[0]?.steps[0]?.calls.length) data.turns[0].steps[0].calls.shift()
    else break
    data.truncated = true
  }
  return answer
}

let stop: (() => void) | null = null

export default function activate(orca: OrcaWorkerApi): void {
  const cache = new TranscriptCache()
  let watchers: FSWatcher[] = []
  let watched: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const unwatch = (): void => {
    for (const w of watchers) w.close()
    watchers = []
    watched = null
    if (timer) clearTimeout(timer)
    timer = null
  }
  stop = unwatch

  // Tells open panels the session changed, at most once per DEBOUNCE_MS.
  const follow = (sessionId: string, file: string, dir: string): void => {
    if (watched === file) return
    unwatch()
    watched = file
    const changed = (): void => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        orca.panels.post('trajectory.changed', { sessionId })
      }, DEBOUNCE_MS)
    }
    for (const path of [file, join(dir, sessionId, 'subagents')]) {
      try {
        const w = watch(path, { persistent: false }, changed)
        w.on('error', () => w.close())
        watchers.push(w)
      } catch {
        /* no subagents folder yet, or the file went away */
      }
    }
  }

  orca.panels.handle('trajectory.get', async (input) => {
    const want = typeof input === 'object' && input !== null ? input : {}
    const wantWs = typeof want.workspaceId === 'string' && want.workspaceId.length <= 1024 ? want.workspaceId : null
    const wantSession = typeof want.sessionId === 'string' && SESSION_ID.test(want.sessionId) ? want.sessionId : null
    const home = claudeHome()

    const all = await localWorkspaces(orca)
    // "squad-chat · next": the folder, then Orca's name for the workspace when it says more.
    const workspaces: WorkspaceInfo[] = all.map((w) => {
      const folder = basename(w.path)
      return { id: w.id, name: label(w.name && w.name !== folder ? `${folder} · ${w.name}` : folder) }
    })
    // Only a workspace Orca listed: the id picks one, it is never a path.
    const ws = (wantWs ? all.find((w) => w.id === wantWs) : null) ?? (await focusedWorkspace(orca, all, home))
    const answer: TrajectoryAnswer = { workspaces, workspaceId: ws?.id ?? null, sessions: [], sessionId: null, data: null, notice: null }
    if (!ws) {
      unwatch()
      return { ...answer, notice: 'Pick a workspace on this machine to see its Claude Code sessions.' }
    }

    const { root, sessions } = await listSessions(home, ws.path)
    answer.sessions = sessions.map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
    // Only a session found in that workspace's folder: the id picks one, it is never a path.
    const session = (wantSession ? sessions.find((s) => s.id === wantSession) : null) ?? sessions[0] ?? null
    if (!session) {
      unwatch()
      return { ...answer, notice: 'No Claude Code sessions in this workspace yet.' }
    }
    answer.sessionId = session.id

    let data: Trajectory
    try {
      const { records, complete, before } = await cache.read(session.file)
      const agentCalls = new Set<string>()
      for (const r of records) if (r.k === 'asst') for (const t of r.tools) if (isAgentTool(t.tool)) agentCalls.add(t.id)
      const subagents = agentCalls.size ? await readSubagents(root, session.dir, session.id, agentCalls) : []
      data = build(records, subagents, complete, Date.now(), before)
    } catch (err) {
      cache.clear()
      orca.log(`could not read session ${session.id}: ${err instanceof Error ? err.message : String(err)}`)
      return { ...answer, notice: 'This session’s transcript could not be read.' }
    }
    follow(session.id, session.file, session.dir)
    return fit({ ...answer, data })
  })
}

export function deactivate(): void {
  stop?.()
  stop = null
}

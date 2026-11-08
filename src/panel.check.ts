// `orca plugin check` renders the panel once per scenario, with the worker stubbed by `requests`.
import { defineCheck } from 'orca/testing'
import { build, parseLines } from './transcript.ts'
import { basicSession, jsonl, T0 } from './fixtures.ts'
import type { TrajectoryAnswer } from './protocol.ts'

const base: TrajectoryAnswer = {
  workspaces: [{ id: 'ws-1', name: 'app · main' }],
  workspaceId: 'ws-1',
  sessions: [{ id: '11111111-1111-4111-8111-111111111111', title: 'Fix the parser', updatedAt: T0 }],
  sessionId: '11111111-1111-4111-8111-111111111111',
  data: build(parseLines(jsonl(basicSession())), [], true, T0 + 86_400_000),
  notice: null
}

export default defineCheck({
  session: { requests: { 'trajectory.get': () => base } },
  duration: { requests: { 'trajectory.get': () => base }, persisted: { plugin: { duration: true } } },
  empty: { requests: { 'trajectory.get': () => ({ ...base, sessions: [], sessionId: null, data: null, notice: 'No Claude Code sessions in this workspace yet.' }) } }
})

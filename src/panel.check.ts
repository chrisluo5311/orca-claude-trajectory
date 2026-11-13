// `orca plugin check` renders the panel once per scenario, with the worker stubbed by `requests`.
import { defineCheck } from 'orca/testing'
import { build, parseLines } from './transcript.ts'
import { basicSession, jsonl, showcaseSession, showcaseSubagent, T0, withShape } from './fixtures.ts'
import type { TrajectoryAnswer } from './protocol.ts'

const base: TrajectoryAnswer = {
  workspaces: [{ id: 'ws-1', name: 'app · main' }],
  workspaceId: 'ws-1',
  sessions: [{ id: '11111111-1111-4111-8111-111111111111', title: 'Fix the parser', updatedAt: T0 }],
  sessionId: '11111111-1111-4111-8111-111111111111',
  data: build(parseLines(jsonl(basicSession())), [], true, T0 + 86_400_000),
  notice: null
}

// The session the README's and the listing's screenshots show.
const showcase: TrajectoryAnswer = {
  ...base,
  workspaces: [{ id: 'ws-1', name: 'api · rate-limit' }],
  sessions: [{ id: base.sessionId!, title: 'Rate limit the public API', updatedAt: T0 + 101_000 }],
  data: build(parseLines(jsonl(showcaseSession())), [{ toolUseId: 'toolu_explore', agentType: 'Explore', records: parseLines(jsonl(showcaseSubagent()), { sidechain: true }) }], true, T0 + 86_400_000)
}

export default defineCheck({
  session: { requests: { 'trajectory.get': () => base } },
  showcase: { requests: { 'trajectory.get': () => showcase } },
  'no calls': { requests: { 'trajectory.get': () => base }, persisted: { plugin: { showCalls: false } } },
  breakdown: { requests: { 'trajectory.get': () => ({ ...base, data: build(parseLines(jsonl(withShape())), [], true, T0 + 86_400_000) }) } },
  empty: { requests: { 'trajectory.get': () => ({ ...base, sessions: [], sessionId: null, data: null, notice: 'No Claude Code sessions in this workspace yet.' }) } }
})

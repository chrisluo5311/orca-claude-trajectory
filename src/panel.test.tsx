import { afterEach, assert, mockHost, mount, test, type TestPanel } from 'orca/testing'
import * as panel from './panel.tsx'
import { build, parseLines } from './transcript.ts'
import { basicSession, jsonl, prompt, T0 } from './fixtures.ts'
import type { TrajectoryAnswer } from './protocol.ts'

const S1 = '11111111-1111-4111-8111-111111111111'
const answer = (extra: Partial<TrajectoryAnswer> = {}): TrajectoryAnswer => ({
  workspaces: [{ id: 'ws-1', name: 'app · main' }],
  workspaceId: 'ws-1',
  sessions: [{ id: S1, title: 'Fix the parser', updatedAt: T0 }],
  sessionId: S1,
  data: build(parseLines(jsonl(basicSession())), [], true, T0 + 86_400_000),
  notice: null,
  ...extra
})

let view: TestPanel | undefined
const drawn = (text: string): boolean => JSON.stringify(view!.tree()).includes(JSON.stringify(text).slice(1, -1))
afterEach(async () => {
  await view?.unmount()
  view = undefined
})

test('draws the rows and opens a row’s details', async () => {
  const asked: unknown[] = []
  const host = mockHost({
    capabilities: ['workspace:read', 'agent:read'],
    requests: {
      'trajectory.get': (input) => {
        asked.push(input)
        return answer()
      }
    }
  })
  view = await mount(panel, { host })
  assert.ok(view.find({ role: 'heading', text: 'Claude Trajectory' }))
  const tree = view.find({ label: 'Trajectory rows' })
  assert.ok(tree)
  await view.expand({ label: 'Trajectory rows' }, 'r1')
  await view.selectItem({ label: 'Trajectory rows' }, 'ctoolu_1')
  assert.ok(drawn('Request #1'))
  assert.ok(drawn('Called by'))
  await view.select({ label: 'Details' }, 'Result')
  assert.ok(drawn('line one'))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  assert.ok(asked.length >= 1)
})

test('shows the worker’s notice when there is nothing to draw', async () => {
  const host = mockHost({
    capabilities: ['workspace:read', 'agent:read'],
    requests: { 'trajectory.get': () => answer({ sessions: [], sessionId: null, data: null, notice: 'No Claude Code sessions in this workspace yet.' }) }
  })
  view = await mount(panel, { host })
  assert.ok(drawn('No Claude Code sessions in this workspace yet.'))
  assert.deepEqual(view.errors, [])
})

test('a session picked from the list is asked for by id', async () => {
  const S2 = '22222222-2222-4222-8222-222222222222'
  const asked: { sessionId?: string | null }[] = []
  const two = answer({ sessions: [{ id: S1, title: 'Fix the parser', updatedAt: T0 }, { id: S2, title: 'Second', updatedAt: T0 - 1000 }] })
  const host = mockHost({
    capabilities: ['workspace:read', 'agent:read'],
    requests: {
      'trajectory.get': (input) => {
        asked.push(input as { sessionId?: string | null })
        return input?.sessionId === S2 ? { ...two, sessionId: S2, data: build(parseLines(jsonl([prompt(0, 'second')])), [], true, T0) } : two
      }
    }
  })
  view = await mount(panel, { host })
  await view.select({ label: 'Session' }, S2)
  assert.equal(asked.at(-1)?.sessionId, S2)
  assert.deepEqual(view.errors, [])
})

test('the worker failing shows an error, not a crash', async () => {
  const host = mockHost({
    capabilities: ['workspace:read', 'agent:read'],
    requests: {
      'trajectory.get': () => {
        throw Object.assign(new Error('boom /Users/secret/path'), { code: 'action_failed' })
      }
    }
  })
  view = await mount(panel, { host })
  assert.ok(drawn('The session could not be read.'))
  assert.ok(!JSON.stringify(view.tree()).includes('/Users/secret'))
})

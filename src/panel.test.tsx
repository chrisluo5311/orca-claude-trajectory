import { afterEach, assert, mockHost, mount, test, type TestPanel } from 'orca/testing'
import * as panel from './panel.tsx'
import { cutCells } from './format.ts'
import { build, parseLines } from './transcript.ts'
import { assistant, basicSession, jsonl, prompt, T0, withShape } from './fixtures.ts'
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

// A request row's key: by when it was sent, so it holds as older records leave.
const firstRequest = `r${answer().data!.turns[0].steps[0].at}`

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
  await view.expand({ label: 'Trajectory rows' }, firstRequest)
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

const twoTurns = (): TrajectoryAnswer =>
  answer({
    data: build(
      parseLines(jsonl([...basicSession(), prompt(5000, 'A second question'), assistant(6000, 'r3', [{ type: 'text', text: 'Answered.' }], { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 21000, cache_creation_input_tokens: 0 })])),
      [],
      true,
      T0 + 86_400_000
    )
  })
const hostOf = (a: TrajectoryAnswer) => mockHost({ capabilities: ['workspace:read', 'agent:read'], requests: { 'trajectory.get': () => a } })

test('a folded turn says what it was about', async () => {
  view = await mount(panel, { host: hostOf(twoTurns()) })
  // Turn 1 is folded by default, the newest open.
  assert.ok(drawn('Turn 1 · Read the parser and f…'))
  assert.ok(!drawn('Turn 2 · A second question'))
  assert.deepEqual(view.errors, [])
})

test('the toolbar folds every turn, then opens them', async () => {
  view = await mount(panel, { host: hostOf(twoTurns()) })
  await view.press({ role: 'button', text: 'Fold turns' })
  assert.ok(view.find({ role: 'button', text: 'Open turns' }))
  await view.press({ role: 'button', text: 'Open turns' })
  assert.ok(view.find({ role: 'button', text: 'Fold turns' }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
})

test('Calls off leaves the requests without their calls, and closes a call’s details', async () => {
  view = await mount(panel, { host: hostOf(answer()) })
  await view.expand({ label: 'Trajectory rows' }, firstRequest)
  await view.selectItem({ label: 'Trajectory rows' }, 'ctoolu_1')
  assert.ok(drawn('Called by'))
  await view.toggle({ label: 'Calls' })
  assert.ok(!drawn('Called by'))
  assert.ok(!drawn('parser.ts'))
  await view.toggle({ label: 'Calls' })
  assert.deepEqual(view.errors, [])
})

test('FIXED opens to its categories', async () => {
  view = await mount(panel, { host: hostOf(answer({ data: build(parseLines(jsonl(withShape())), [], true, T0 + 86_400_000) })) })
  await view.selectItem({ label: 'Trajectory rows' }, 'fixed')
  assert.ok(view.find({ label: 'Fixed overhead by category' }))
  for (const name of ['System prompt', 'Built-in tools', 'MCP tools', 'Skills']) assert.ok(drawn(name), name)
  assert.ok(drawn('of its input'))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
})

test('FIXED without a recorded shape says so', async () => {
  view = await mount(panel, { host: hostOf(answer()) })
  await view.selectItem({ label: 'Trajectory rows' }, 'fixed')
  assert.ok(drawn('doesn’t record what it is made of'))
})

test('cuts a folded prompt by cells, and never through a character', () => {
  assert.equal(cutCells('short', 22), 'short')
  assert.equal(cutCells('小螃蟹小一點然後是打招呼的樣子', 8), '小螃蟹…')
  assert.equal(cutCells('abc😀def', 5), 'abc…')
  assert.ok(!/[\uD800-\uDBFF]$/.test(cutCells('a😀😀😀', 4).replace('…', '')))
})

test('prompts sharing a time still draw the rows', async () => {
  const data = build(parseLines(jsonl([prompt(0, 'one'), assistant(10, 'r1', [{ type: 'text', text: 'a' }]), prompt(0, 'two'), assistant(20, 'r2', [{ type: 'text', text: 'b' }])])), [], true, T0 + 86_400_000)
  view = await mount(panel, { host: hostOf(answer({ data })) })
  assert.ok(view.find({ label: 'Trajectory rows' }))
  assert.ok(drawn('Turn 1 · one'))
})

test('an open turn stays open when the oldest leaves the list', async () => {
  const session = (from: number) => build(parseLines(jsonl(Array.from({ length: 4 - from }, (_, k) => [prompt((from + k) * 100, `p${from + k}`), assistant((from + k) * 100 + 5, `r${from + k}`, [{ type: 'text', text: 'ok' }])]).flat())), [], true, T0 + 86_400_000)
  let data = session(0)
  const host = mockHost({ capabilities: ['workspace:read', 'agent:read'], requests: { 'trajectory.get': () => answer({ data }) } })
  view = await mount(panel, { host })
  const second = `t${T0 + 100}`
  await view.expand({ label: 'Trajectory rows' }, second)
  assert.ok(view.expandedOf({ label: 'Trajectory rows' }).includes(second))
  data = session(1)
  await view.press({ label: 'Refresh' })
  assert.ok(view.expandedOf({ label: 'Trajectory rows' }).includes(second))
  assert.deepEqual(view.errors, [])
})

test('FIXED says why its categories are missing when the answer left them out', async () => {
  const data = { ...build(parseLines(jsonl(withShape())), [], true, T0 + 86_400_000), fixed: null, fixedTrimmed: true }
  view = await mount(panel, { host: hostOf(answer({ data })) })
  await view.selectItem({ label: 'Trajectory rows' }, 'fixed')
  assert.ok(drawn('too large to send whole'))
  assert.ok(!drawn('doesn’t record what it is made of'))
})

test('an event draws under its own name, with no YOU row, and isn’t counted as a turn', async () => {
  const data = build(parseLines(jsonl([prompt(0, 'first'), assistant(10, 'r1', [{ type: 'text', text: 'a' }]), prompt(100, '<task-notification>x</task-notification>'), assistant(110, 'r2', [{ type: 'text', text: 'b' }])])), [], true, T0 + 86_400_000)
  view = await mount(panel, { host: hostOf(answer({ data })) })
  assert.ok(drawn('Background task'))
  assert.ok(!drawn('(empty prompt)'))
  assert.ok(drawn('1 turn · 2 requests'))
  assert.deepEqual(view.errors, [])
})

test('a FIXED category opens to what is in it', async () => {
  view = await mount(panel, { host: hostOf(answer({ data: build(parseLines(jsonl(withShape())), [], true, T0 + 86_400_000) })) })
  await view.selectItem({ label: 'Trajectory rows' }, 'fixed')
  await view.expand({ label: 'Fixed overhead by category' }, 'tools/Built-in tools')
  assert.ok(view.expandedOf({ label: 'Fixed overhead by category' }).includes('tools/Built-in tools'))
  assert.ok(drawn('Bash'))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
})

test('the lanes say what they show, and the key lists only what is drawn', async () => {
  view = await mount(panel, { host: hostOf(answer()) })
  assert.ok(drawn('in order'))
  assert.ok(drawn(' model  '))
  assert.ok(!drawn(' error  '))
  assert.ok(!view.find({ label: 'To time' }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
})

test('a selected request stays selected when older records leave', async () => {
  const later = T0 + 86_400_000
  const lines = [prompt(0, 'one'), assistant(10, 'r1', [{ type: 'text', text: 'first reply' }]), prompt(100, 'two'), assistant(110, 'r2', [{ type: 'text', text: 'second reply' }])]
  const whole = build(parseLines(jsonl(lines)), [], true, later)
  // The same session, its first turn no longer read: the second request is now #1.
  const tail = build(parseLines(jsonl(lines.slice(2))), [], false, later, { n: 1, open: false })
  let data = whole
  view = await mount(panel, { host: mockHost({ capabilities: ['workspace:read', 'agent:read'], requests: { 'trajectory.get': () => answer({ data }) } }) })
  await view.selectItem({ label: 'Trajectory rows' }, `r${whole.turns[1].steps[0].at}`)
  assert.ok(drawn('Request #2'))
  data = tail
  await view.press({ label: 'Refresh' })
  assert.ok(drawn('Request #1'))
  assert.ok(drawn('second reply'))
  assert.deepEqual(view.errors, [])
})

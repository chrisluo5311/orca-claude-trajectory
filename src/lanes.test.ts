import { assert, test } from 'orca/testing'
import { CELLS, cellsInOrder, laneItems, MAX_SLOTS } from './lanes.ts'
import { build, parseLines } from './transcript.ts'
import { assistant, jsonl, prompt, T0, toolUse } from './fixtures.ts'

const later = T0 + 7 * 86_400_000
const reply = (ms: number, id: string) => assistant(ms, id, [{ type: 'text', text: 'ok' }])
const itemsOf = (lines: unknown[], subs: { at: number; isError: boolean }[] = []) => {
  const t = build(parseLines(jsonl(lines)), [], true, later)
  const call = t.turns.flatMap((x) => x.steps).flatMap((s) => s.calls)[0]
  if (call) call.sub = subs.map((s, i) => ({ id: `s${i}`, tool: 'Read', summary: '', at: T0 + s.at, ms: 1, done: true, isError: s.isError, by: null }))
  return laneItems(t, later)
}

test('only the newest events fit, each in its own slot', () => {
  const lines = Array.from({ length: MAX_SLOTS }, (_, i) => [prompt(i * 10, `p${i}`), reply(i * 10 + 1, `r${i}`)]).flat()
  const cells = cellsInOrder(itemsOf(lines))
  assert.equal(cells.get('model')!.length, CELLS)
  // Prompt, reply, prompt...: every cell is taken by exactly one of the two lanes.
  assert.equal(cells.get('in')!.filter((c) => c != null).length + cells.get('model')!.filter((c) => c != null).length, CELLS)
})

test('an event nobody typed is not drawn as a prompt', () => {
  const cells = cellsInOrder(itemsOf([prompt(0, 'typed'), reply(10, 'r1'), prompt(20, '<task-notification>x</task-notification>'), reply(30, 'r2')]))
  assert.ok(cells.get('in')!.includes('accent'))
  assert.ok(cells.get('in')!.includes('event'))
})

test('a subagent’s failed call is not hidden by the others in its slot', () => {
  const lines = [prompt(0, 'go'), assistant(10, 'r1', [toolUse('t1', 'Agent', { description: 'look' })], undefined, 'tool_use')]
  const cells = cellsInOrder(itemsOf(lines, [{ at: 20, isError: false }, { at: 30, isError: true }, { at: 40, isError: false }]))
  assert.ok(cells.get('sub')!.includes('danger'))
})

test('nothing to draw draws nothing', () => {
  assert.ok(cellsInOrder([]).get('model')!.every((c) => c == null))
})

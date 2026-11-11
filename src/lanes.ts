// The lanes above the rows, as cells: what each of a lane's cells holds, for
// the newest events in order.

import type { Tone } from 'orca'
import type { Trajectory } from './protocol.ts'
import { isAgentTool } from './format.ts'

export type Lane = 'in' | 'model' | 'tools' | 'sub'
/** A lane's colour, or: `muted` waiting on a first block, `event` something nobody typed started a request. */
export type Fill = Tone | 'muted' | 'event'
/** What a cell holds. */
export type Cell = Fill | null

type Item = { lane: Lane; fill: Fill; t0: number; t1: number; first?: number | null; slot: boolean }
type Cells = Map<Lane, Cell[]>

export const LANES: [Lane, string][] = [
  ['in', 'Input'],
  ['model', 'Model'],
  ['tools', 'Tools'],
  ['sub', 'Agents']
]
export const CELLS = 18 // a glyph is about 13px wide: 18 fit a lane from about 240px (a 330px sidebar)
export const MAX_SLOTS = 9 // in order, the newest slots: two cells each of the 18

export function laneItems(t: Trajectory, now: number): Item[] {
  const items: Item[] = []
  for (const turn of t.turns) {
    if (!turn.earlier) items.push({ lane: 'in', fill: turn.auto ? 'event' : 'accent', t0: turn.at, t1: turn.at, slot: true })
    turn.steps.forEach((s, i) => {
      if (i && turn.steps[i - 1].calls.length) items.push({ lane: 'in', fill: 'warning', t0: s.at, t1: s.at, slot: true })
      items.push({ lane: 'model', fill: 'success', t0: s.at, t1: s.endedAt ?? now, first: s.firstAt, slot: true })
      for (const c of s.calls) {
        items.push({ lane: 'tools', fill: c.isError ? 'danger' : isAgentTool(c.tool) ? 'accent' : 'warning', t0: c.at, t1: c.done ? c.at + (c.ms ?? 0) : now, slot: true })
        for (const sc of c.sub) items.push({ lane: 'sub', fill: sc.isError ? 'danger' : 'accent', t0: sc.at, t1: sc.done ? sc.at + (sc.ms ?? 0) : now, slot: false })
      }
    })
  }
  return items
}

const empty = (): Cells => new Map(LANES.map(([l]) => [l, Array<Cell>(CELLS).fill(null)]))

// A cell shows the one thing in it that matters most: an error is never painted over.
const RANK: Record<string, number> = { danger: 4, accent: 3, event: 2, muted: 0 }
const rank = (c: Cell): number => (c == null ? -1 : (RANK[c] ?? 1))

function paint(cells: Cell[], a: number, b: number, fill: Fill, first?: number): void {
  const wait = first != null && b - a >= 2 ? Math.round((b - a) * first) : 0
  for (let x = a; x < b; x++) {
    const next = x < a + wait ? 'muted' : fill
    if (rank(next) >= rank(cells[x])) cells[x] = next
  }
}

/** The newest events, each given the same room; a subagent's calls share their Agent call's slot. */
export function cellsInOrder(items: Item[]): Cells {
  const out = empty()
  const slotted = items.filter((i) => i.slot)
  const skip = Math.max(0, slotted.length - MAX_SLOTS)
  const n = slotted.length - skip
  let k = -1
  for (const it of items) {
    if (it.slot) k++
    const at = k - skip
    if (at < 0) continue
    const a = Math.min(CELLS - 1, Math.floor((at / n) * CELLS))
    const b = Math.min(CELLS, Math.max(a + 1, Math.round(((at + 0.86) / n) * CELLS)))
    const first = it.first != null && it.t1 > it.t0 ? Math.min(0.6, (it.first - it.t0) / (it.t1 - it.t0)) : undefined
    paint(out.get(it.slot ? it.lane : 'sub')!, a, b, it.fill, first)
  }
  return out
}

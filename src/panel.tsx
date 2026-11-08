// The Trajectory panel: what a Claude Code session did, one row per thing,
// oldest first. FIXED is what every request starts with (the system prompt
// and every tool definition), then each turn: your prompt (YOU), each request
// Claude was sent (CLAUDE), and the tool calls each request made (TOOL, AGENT
// with its own calls under it). Selecting a row opens its details under the
// list. Lanes above the rows draw the same events in order, or in time with
// To time.
//
// A components panel: Orca draws every control itself and the panel has no
// DOM, so transcript text can only ever appear as text.

import {
  atom,
  Box,
  Button,
  Callout,
  Card,
  CodeView,
  EmptyState,
  files,
  Heading,
  IconButton,
  KeyValue,
  on,
  plugin,
  read,
  Row,
  Select,
  set,
  Spinner,
  Stack,
  Switch,
  Tab,
  Table,
  Tabs,
  Text,
  Tree,
  update,
  type IconName,
  type KeyValueItem,
  type OrcaNode,
  type PanelContext,
  type Tone,
  type TreeItem
} from 'orca'
import type { Call, FixedItem, Step, SubCall, Trajectory, TrajectoryAnswer, Turn } from './protocol.ts'
import { cutCells, isAgentTool, kTok, plural, stamp, stepMs, took, trajectoryText, turnName } from './format.ts'

// ---------------------------------------------------------------- state

const answer = atom<TrajectoryAnswer | null>('answer', null)
const failure = atom<string | null>('failure', null)
const loading = atom('loading', false)
/** What the person picked; null follows the focused workspace and its newest session. */
const choice = atom<{ workspaceId: string | null; sessionId: string | null }>('choice', { workspaceId: null, sessionId: null })
const selected = atom<string | null>('selected', null)
const tabOf = atom<Record<string, string>>('tabs', {})
/** Rows opened in the list; null until the person opens or closes one. */
const expanded = atom<string[] | null>('expanded', null)
const duration = atom('duration', false, { persist: 'plugin' })
const showCalls = atom('showCalls', true, { persist: 'plugin' })
const showSubcalls = atom('showSubcalls', true, { persist: 'plugin' })

let seq = 0

async function refresh(): Promise<void> {
  const mine = ++seq
  set(loading, true)
  try {
    const got = await plugin.request('trajectory.get', read(choice), { timeoutMs: 60_000 })
    if (mine !== seq) return
    const was = read(answer)
    if (was && (was.sessionId !== got.sessionId || was.workspaceId !== got.workspaceId)) {
      set(selected, null)
      set(expanded, null)
    } else if (was?.data && got.data && was.data.turns.at(-1)?.at !== got.data.turns.at(-1)?.at) {
      // A new turn opens, and the ones before fold. An answer with no data says nothing about that.
      set(expanded, null)
    }
    set(answer, got)
    set(failure, null)
  } catch (err) {
    if (mine !== seq) return
    const code = (err as { code?: string }).code
    set(failure, code === 'timeout' ? 'Reading the session took too long.' : 'The session could not be read.')
  } finally {
    if (mine === seq) set(loading, false)
  }
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('trajectory.changed', () => void refresh()),
    on('agent.status.changed', () => void refresh()),
    // Fires once as it subscribes, then when focus moves.
    on('workspace.changed', () => {
      if (!read(choice).workspaceId) void refresh()
    })
  )
  void refresh()
}

function pickWorkspace(id: string): void {
  set(choice, { workspaceId: id, sessionId: null })
  set(selected, null)
  set(expanded, null)
  void refresh()
}

function pickSession(id: string): void {
  update(choice, (c) => ({ ...c, sessionId: id }))
  set(selected, null)
  set(expanded, null)
  void refresh()
}

async function exportText(): Promise<void> {
  const data = read(answer)?.data
  if (!data) return
  await files.saveAs({ suggestedName: 'claude-trajectory.txt', mimeType: 'text/plain', data: trajectoryText(data) })
}

// ---------------------------------------------------------------- rows

type Row =
  | { kind: 'fixed' }
  | { kind: 'turn'; turn: Turn }
  | { kind: 'you'; turn: Turn }
  | { kind: 'compact'; step: Step }
  | { kind: 'claude'; step: Step }
  | { kind: 'tool'; call: Call; step: Step }
  | { kind: 'sub'; call: SubCall; parent: Call }

const TAG: Record<string, string> = { fixed: 'FIXED', you: 'YOU', claude: 'CLAUDE', tool: 'TOOL', agent: 'AGENT', compact: 'COMPACT', sub: 'TOOL' }

function figures(...parts: (string | null | undefined | false)[]): string | undefined {
  const s = parts.filter(Boolean).join(' · ')
  return s || undefined
}

// Each turn's key, by when it started: its place in the list shifts as old ones
// leave. Two prompts can share a time, and a Tree's keys must be unique.
function turnKeys(t: Trajectory): string[] {
  const seen = new Map<number, number>()
  return t.turns.map((turn) => {
    const n = seen.get(turn.at) ?? 0
    seen.set(turn.at, n + 1)
    return n ? `t${turn.at}-${n}` : `t${turn.at}`
  })
}

// Open until the person says otherwise: the newest turn and its last request.
function defaultOpen(t: Trajectory): string[] {
  const key = turnKeys(t).at(-1)
  if (!key) return []
  const last = t.turns.at(-1)!.steps.at(-1)
  return last ? [key, `r${last.n}`] : [key]
}

const TURN_PROMPT = 22 // cells of a prompt a folded turn says: its figures keep their room in a sidebar

// The rows as a tree, and each row shown by its key for the details.
function rows(t: Trajectory, now: number, opened: readonly string[]): { items: TreeItem[]; byKey: Map<string, Row> } {
  const calling = read(showCalls)
  const subcalling = read(showSubcalls)
  const byKey = new Map<string, Row>()
  const items: TreeItem[] = []
  const keys = turnKeys(t)
  byKey.set('fixed', { kind: 'fixed' })
  items.push({ key: 'fixed', icon: 'layers', label: `${TAG.fixed}  Fixed overhead`, description: t.overhead != null ? `≈${kTok(t.overhead)}` : undefined })
  t.turns.forEach((turn, i) => {
    const key = keys[i]
    byKey.set(key, { kind: 'turn', turn })
    const children: TreeItem[] = []
    if (!turn.earlier && !turn.auto) {
      byKey.set(`y${key}`, { kind: 'you', turn })
      children.push({ key: `y${key}`, icon: 'edit', label: `${TAG.you}  ${turn.prompt || '(empty prompt)'}`, description: figures(kTok(turn.tokens ?? Math.round(turn.chars / 4))) })
    }
    for (const s of turn.steps) {
      if (s.isCompacted) {
        byKey.set(`k${s.n}`, { kind: 'compact', step: s })
        children.push({ key: `k${s.n}`, icon: 'collapse', label: `${TAG.compact}  Context compacted` })
      }
      const sk = `r${s.n}`
      byKey.set(sk, { kind: 'claude', step: s })
      const live = s.status === 'streaming'
      const calls: TreeItem[] = !calling ? [] : s.calls.map((c) => {
        const ck = `c${c.id}`
        byKey.set(ck, { kind: 'tool', call: c, step: s })
        const agent = isAgentTool(c.tool)
        const sub: TreeItem[] = !subcalling ? [] : c.sub.map((sc) => {
          // Two Agent calls could list the same id: keyed by the call as well.
          byKey.set(`s${c.id}/${sc.id}`, { kind: 'sub', call: sc, parent: c })
          return { key: `s${c.id}/${sc.id}`, icon: sc.isError ? 'error' : sc.done ? 'hammer' : 'activity', label: `${TAG.sub}  ${sc.tool}${sc.summary ? ` ${sc.summary}` : ''}${sc.isError ? ' ✗' : ''}`, description: figures(sc.done ? took(sc.ms) : took(now - sc.at)) }
        })
        const name = agent ? (c.agentType ?? 'Agent') : c.tool
        return {
          key: ck,
          icon: c.isError ? 'error' : !c.done ? 'activity' : agent ? 'agent' : 'wrench',
          label: `${agent ? TAG.agent : TAG.tool}  ${name}${c.summary ? ` ${c.summary}` : ''}${c.isError ? ' ✗' : ''}${c.sub.length ? ` · ${plural(c.sub.length, 'call')}` : ''}`,
          description: figures(kTok(c.tokens), c.done ? took(c.ms) : took(now - c.at)),
          children: sub.length ? sub : undefined
        }
      })
      const text = s.text || (live ? '…' : s.calls.length ? '' : '(no text)')
      children.push({
        key: sk,
        icon: live ? 'activity' : 'bot',
        label: `${TAG.claude}  #${s.n}${text ? ` ${text}` : ''}`,
        description: figures(s.output != null && kTok(s.output), took(stepMs(s, now))),
        children: calls.length ? calls : undefined
      })
    }
    const span = turn.steps.length ? took((turn.steps.at(-1)!.endedAt ?? now) - (turn.earlier ? turn.steps[0].at : turn.at)) : ''
    // Folded, a turn still says what it was about.
    const about = !opened.includes(key) && turn.prompt ? cutCells(turn.prompt, TURN_PROMPT) : null
    const name = turnName(turn)
    items.push({ key, icon: turn.auto ? 'activity' : 'flag', label: about ? `${name} · ${about}` : name, description: figures(plural(turn.steps.length, 'request'), span), children })
  })
  return { items, byKey }
}

// ---------------------------------------------------------------- the toolbar

// All the turns folded, or all of them open with their requests.
function toggleTurns(t: Trajectory, opened: readonly string[]): void {
  const turns = turnKeys(t)
  if (turns.some((k) => opened.includes(k))) {
    set(expanded, opened.filter((k) => !turns.includes(k)))
    return
  }
  set(expanded, [...new Set([...opened, ...turns, ...t.turns.flatMap((x) => x.steps.map((s) => `r${s.n}`))])])
}

function toolbar(t: Trajectory, opened: readonly string[]) {
  const anyOpen = turnKeys(t).some((k) => opened.includes(k))
  return (
    <Row wrap gap="sm" align="center">
      <Button size="sm" variant="ghost" icon={anyOpen ? 'collapse' : 'expand'} onPress={() => toggleTurns(t, opened)}>
        {anyOpen ? 'Fold turns' : 'Open turns'}
      </Button>
      <Switch label="Calls" checked={read(showCalls)} onChange={(v) => set(showCalls, v)} />
      <Switch label="Subcalls" checked={read(showSubcalls)} onChange={(v) => set(showSubcalls, v)} />
    </Row>
  )
}

// ---------------------------------------------------------------- details

function tabs(key: string, names: string[], body: (tab: string) => OrcaNode) {
  const saved = read(tabOf)[key]
  const cur = saved && names.includes(saved) ? saved : names[0]
  return (
    <Tabs label="Details" value={cur} onChange={(v) => update(tabOf, (m) => ({ ...m, [key]: v }))}>
      {names.map((n) => (
        <Tab value={n} label={n}>
          {n === cur ? body(n) : null}
        </Tab>
      ))}
    </Tabs>
  )
}

const kv = (items: (KeyValueItem | null | false)[]) => <KeyValue items={items.filter(Boolean) as KeyValueItem[]} />

function callStatus(c: SubCall): KeyValueItem {
  return { label: 'Status', value: !c.done ? 'Running' : c.isError ? 'Failed' : 'Completed', tone: !c.done ? 'warning' : c.isError ? 'danger' : undefined }
}

// A category of the fixed overhead as a tree row, with what's in it under it.
function fixedRow(x: FixedItem & { note?: string | null }, path: string): TreeItem {
  const key = `${path}/${x.name}`
  const children = x.items?.map((c, i) => fixedRow(c, `${key}#${i}`))
  return { key, label: x.name, description: figures(`≈${kTok(x.tokens)}`, x.note), children }
}

function fixedDetails(t: Trajectory) {
  const last = t.turns.flatMap((x) => x.steps).filter((s) => s.input != null).at(-1)
  const share = t.overhead != null && last?.input ? Math.min(100, Math.round((t.overhead / last.input) * 100)) : null
  return (
    <Stack gap="sm">
      <Text muted size="sm">
        Sent with every request: the system prompt, the tool definitions, memory files and anything else that comes before the conversation.
      </Text>
      {kv([
        { label: 'Tokens', value: t.overhead != null ? `≈${kTok(t.overhead)}` : 'Unknown' },
        share != null && { label: 'Last request', value: `${share}% of its input` }
      ])}
      {t.fixed ? <Tree label="Fixed overhead by category" items={t.fixed.map((p) => fixedRow(p, p.key))} maxHeight="md" /> : null}
      <Text muted size="xs">
        {t.overhead == null
          ? 'The start of this session is past what was read, so it cannot be estimated.'
          : t.fixed
            ? 'Estimated from the first request: its input less what its prompt added, shared out by the size of each part.'
            : t.fixedTrimmed
              ? 'Estimated from the first request: its input less what its prompt added. Its categories are left out because this session is too large to send whole.'
              : 'Estimated from the first request: its input less what its prompt added. This transcript doesn’t record what it is made of.'}
      </Text>
    </Stack>
  )
}

function details(key: string, r: Row, t: Trajectory, now: number) {
  if (r.kind === 'fixed') return fixedDetails(t)
  if (r.kind === 'turn') {
    const s = r.turn.steps
    return kv([
      { label: 'Requests', value: s.length },
      { label: 'Tool calls', value: s.reduce((n, x) => n + x.calls.length, 0) },
      { label: 'Output', value: `${kTok(s.reduce((n, x) => n + (x.output ?? 0), 0))} tokens` },
      r.turn.earlier ? null : { label: 'Started', value: stamp(r.turn.at) }
    ])
  }
  if (r.kind === 'you') {
    return (
      <Stack gap="sm">
        {kv([{ label: 'Tokens', value: `${kTok(r.turn.tokens ?? Math.round(r.turn.chars / 4))}${r.turn.tokens == null ? ' (est.)' : ''}` }])}
        <Text muted size="sm">
          {r.turn.prompt || '(empty prompt)'}
        </Text>
      </Stack>
    )
  }
  if (r.kind === 'compact') return <Text muted size="sm">The conversation was summarized here, and the requests after it start from the summary.</Text>
  if (r.kind === 'claude') {
    const s = r.step
    return tabs(key, ['Summary', 'Timing'], (tab) => {
      if (tab === 'Summary') {
        return (
          <Stack gap="sm">
            {kv([
              { label: 'Status', value: s.status === 'streaming' ? 'Under way' : `Completed${s.stopReason ? ` · ${s.stopReason}` : ''}`, tone: s.status === 'streaming' ? 'warning' : undefined },
              s.input != null && { label: 'Input', value: `${kTok(s.input)} tokens (${kTok(s.cacheRead)} from cache)` },
              s.output != null && { label: 'Output', value: `${kTok(s.output)} tokens` },
              s.input != null && { label: 'Cache hit', value: `${s.input ? Math.round((s.cacheRead / s.input) * 100) : 0}%` },
              s.model ? { label: 'Model', value: s.model, code: true } : null
            ])}
            {s.text ? (
              <Text muted size="sm">
                {s.text}
              </Text>
            ) : null}
          </Stack>
        )
      }
      const gen = s.firstAt != null && s.endedAt != null ? s.endedAt - s.firstAt : null
      return kv([
        { label: 'Sent', value: stamp(s.at) },
        { label: 'Duration', value: took(stepMs(s, now)) },
        s.firstAt != null && { label: 'First block', value: took(s.firstAt - s.at) },
        gen != null && { label: 'First to last block', value: took(gen) },
        s.status === 'done' && s.output && stepMs(s, now) > 0 ? { label: 'Throughput', value: `${Math.round(s.output / (stepMs(s, now) / 1000))} tok/s, end to end` } : null
      ])
    })
  }
  if (r.kind === 'sub') {
    const c = r.call
    return kv([
      { label: 'Inside', value: `${c.by ? `${c.by}, started under ` : ''}${r.parent.agentType ?? 'Agent'}${r.parent.summary ? ` · ${r.parent.summary}` : ''}`, tone: 'success' },
      callStatus(c),
      { label: 'Started', value: stamp(c.at) },
      { label: 'Duration', value: c.done ? took(c.ms) : took(now - c.at) }
    ])
  }
  const c = r.call
  const agent = isAgentTool(c.tool)
  return tabs(key, agent ? ['Summary', 'Calls', 'Timing'] : ['Summary', 'Input', 'Result', 'Timing'], (tab) => {
    if (tab === 'Summary') {
      return kv([
        { label: 'Called by', value: `Request #${r.step.n}`, tone: 'accent' },
        callStatus(c),
        { label: 'Result', value: c.tokens != null ? `${kTok(c.tokens)} tokens` : c.chars != null ? `${kTok(c.chars)} characters` : '–' },
        agent ? { label: 'Agent', value: `${c.agentType ?? 'Agent'} · ${plural(c.sub.length, 'call')}` } : null
      ])
    }
    if (tab === 'Input') {
      return c.input.length ? kv(c.input.map(([label, value]) => ({ label, value, code: true }))) : <Text muted>No input.</Text>
    }
    if (tab === 'Result') {
      if (!c.done) return <Text muted>Still running.</Text>
      if (!c.lines.length) return <Text muted>No output.</Text>
      return <CodeView code={c.lines.join('\n')} label="First lines of the result" wrap maxHeight="sm" />
    }
    if (tab === 'Calls') {
      return (
        <Table
          label="Subagent calls"
          maxHeight="sm"
          emptyText="No calls yet."
          columns={[
            { key: 'tool', label: 'Tool', width: 'sm' },
            { key: 'about', label: 'About' },
            { key: 'took', label: 'Took', align: 'end', width: 'xs' }
          ]}
          rows={c.sub.map((sc) => ({ key: sc.id, cells: { tool: `${sc.tool}${sc.isError ? ' ✗' : ''}`, about: sc.summary, took: sc.done ? took(sc.ms) : '…' } }))}
        />
      )
    }
    return kv([
      { label: 'Started', value: stamp(c.at) },
      { label: 'Duration', value: c.done ? took(c.ms) : took(now - c.at) }
    ])
  })
}

// ---------------------------------------------------------------- lanes

type Lane = 'in' | 'model' | 'tools' | 'sub'
type Fill = Tone | 'muted'
type Item = { lane: Lane; fill: Fill; t0: number; t1: number; first?: number | null; slot: boolean }

const LANES: [Lane, string][] = [
  ['in', 'Input'],
  ['model', 'Model'],
  ['tools', 'Tools'],
  ['sub', 'Agents']
]
const MAX_SLOTS = 9 // in order, the newest slots: two cells each of the 18

function laneItems(t: Trajectory, now: number): Item[] {
  const items: Item[] = []
  for (const turn of t.turns) {
    if (!turn.earlier) items.push({ lane: 'in', fill: 'accent', t0: turn.at, t1: turn.at, slot: true })
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

type Seg = { x: number; w: number; fill: Fill; first?: number }

// Each lane's bars as [start, width] shares of the lane, in order (equal slots) or in time.
function laneSegments(items: Item[], inTime: boolean): Map<Lane, Seg[]> {
  const out = new Map<Lane, Seg[]>(LANES.map(([l]) => [l, []]))
  if (!items.length) return out
  if (inTime) {
    const start = Math.min(...items.map((i) => i.t0))
    const end = Math.max(...items.map((i) => i.t1), start + 1)
    const span = end - start
    for (const it of items) {
      const first = it.first != null && it.t1 > it.t0 ? Math.min(1, Math.max(0, (it.first - it.t0) / (it.t1 - it.t0))) : undefined
      out.get(it.lane)!.push({ x: (it.t0 - start) / span, w: (it.t1 - it.t0) / span, fill: it.fill, first })
    }
  } else {
    // The newest slots that fit; a subagent's calls share their Agent call's slot.
    const slotted = items.filter((i) => i.slot)
    const skip = Math.max(0, slotted.length - MAX_SLOTS)
    const n = slotted.length - skip
    let k = -1
    for (const it of items) {
      if (it.slot) k++
      const at = k - skip
      if (at < 0) continue
      if (it.slot) out.get(it.lane)!.push({ x: at / n, w: (1 / n) * 0.86, fill: it.fill, first: it.first != null && it.t1 > it.t0 ? Math.min(0.6, (it.first - it.t0) / (it.t1 - it.t0)) : undefined })
      else {
        const lane = out.get('sub')!
        if (!lane.some((s) => s.x === at / n)) lane.push({ x: at / n, w: (1 / n) * 0.86, fill: it.fill })
      }
    }
  }
  return out
}

// One lane as a row of cells spread across the panel: a full block "█" in the
// tone of what is there, a quiet "─" where nothing is. Box backgrounds only tint, so the lanes are drawn in
// text, as the squad-chat terminal draws them.
const CELLS = 18 // a glyph is about 13px wide: 18 fit a lane from about 240px (a 330px sidebar)
function laneRow(segs: Seg[]) {
  const cells: (Fill | null)[] = Array(CELLS).fill(null)
  for (const s of segs) {
    const a = Math.min(CELLS - 1, Math.max(0, Math.floor(s.x * CELLS)))
    const b = Math.min(CELLS, Math.max(a + 1, Math.round((s.x + s.w) * CELLS)))
    const wait = s.first != null && b - a >= 2 ? Math.round((b - a) * s.first) : 0
    for (let x = a; x < b; x++) cells[x] = x < a + wait ? 'muted' : s.fill
  }
  // Each cell takes an equal share of the lane, so the lane spans the panel
  // however wide it is: a run of blocks reads as one bar.
  return (
    <Box direction="row" grow shrink minWidth={1} justify="between" align="center">
      {cells.map((c) =>
        c == null ? (
          <Text size="xs" muted>
            ─
          </Text>
        ) : c === 'muted' ? (
          <Text size="xs" muted>
            ▒
          </Text>
        ) : (
          <Text size="xs" tone={c}>
            █
          </Text>
        )
      )}
    </Box>
  )
}

function lanes(t: Trajectory, now: number) {
  const inTime = read(duration)
  const segs = laneSegments(laneItems(t, now), inTime)
  return (
    <Stack gap="xs">
      <Row justify="between" align="center">
        <Text muted size="xs">
          {inTime ? 'Whole session, to time' : `Newest ${MAX_SLOTS} events, in order`}
        </Text>
        <Switch label="To time" checked={inTime} onChange={(v) => set(duration, v)} />
      </Row>
      {LANES.filter(([lane]) => lane !== 'sub' || segs.get('sub')!.length).map(([lane, name]) => (
        <Row gap="sm" align="center">
          <Box width={52} shrink={false}>
            <Text muted size="xs">
              {name}
            </Text>
          </Box>
          {laneRow(segs.get(lane)!)}
        </Row>
      ))}
      {/* What each colour means: a key, not buttons. */}
      <Text size="xs" muted>
        <Text tone="accent">█</Text> prompt / agent  <Text tone="success">█</Text> model  <Text muted>▒</Text> waiting  <Text tone="warning">█</Text> tool  <Text tone="danger">█</Text> error
      </Text>
    </Stack>
  )
}

// ---------------------------------------------------------------- the panel

const ICON: Record<string, IconName> = { refresh: 'refresh', export: 'download' }

export default function Panel() {
  const a = read(answer)
  const err = read(failure)
  const busy = read(loading)
  const now = Date.now()
  const header = (
    <Row justify="between" align="center">
      <Heading level={2}>Claude Trajectory</Heading>
      <Row gap="xs" align="center">
        {busy ? <Spinner label="Reading" labelHidden /> : null}
        <IconButton icon={ICON.refresh} label="Refresh" variant="ghost" size="sm" onPress={() => void refresh()} />
        <IconButton icon={ICON.export} label="Export as text" tooltip="Export as text (no prompt, reply or output text)" variant="ghost" size="sm" disabled={!a?.data} onPress={exportText} />
      </Row>
    </Row>
  )
  if (!a) {
    return (
      <Stack gap="md">
        {header}
        {err ? <Callout tone="danger" title="Couldn’t read the session">{err}</Callout> : <Spinner label="Reading the session" />}
      </Stack>
    )
  }
  const pickers = (
    <Stack gap="sm">
      <Select
        label="Workspace"
        value={a.workspaceId ?? undefined}
        placeholder="Pick a workspace"
        options={a.workspaces.slice(0, 400).map((w) => ({ value: w.id, label: w.name }))}
        onChange={pickWorkspace}
      />
      {a.sessions.length ? (
        <Select
          label="Session"
          value={a.sessionId ?? undefined}
          options={a.sessions.map((s, i) => ({ value: s.id, label: `${s.title}${i === 0 ? ' · newest' : ''} · ${stamp(s.updatedAt).slice(0, 16)}` }))}
          onChange={pickSession}
        />
      ) : null}
    </Stack>
  )
  const t = a.data
  if (!t) {
    return (
      <Stack gap="md">
        {header}
        {pickers}
        {err ? <Callout tone="danger">{err}</Callout> : null}
        <EmptyState icon="activity" title="Nothing to show yet" description={a.notice ?? 'Each request to Claude shows up here.'} />
      </Stack>
    )
  }
  const opened = read(expanded) ?? defaultOpen(t)
  const { items, byKey } = rows(t, now, opened)
  const sel = read(selected)
  const row = sel ? byKey.get(sel) : undefined
  return (
    <Stack gap="md">
      {header}
      {pickers}
      {err ? <Callout tone="danger">{err}</Callout> : null}
      {t.requests ? lanes(t, now) : null}
      {t.requests ? toolbar(t, opened) : null}
      <Tree
        label="Trajectory rows"
        items={items}
        selected={row ? sel! : undefined}
        expanded={opened}
        maxHeight="lg"
        onSelect={({ key }) => set(selected, key === read(selected) ? null : key)}
        onToggle={({ key, expanded: isOpen }) => set(expanded, isOpen ? [...new Set([...opened, key])] : opened.filter((k) => k !== key))}
      />
      {row && sel ? <Card title={cardTitle(row)}>{details(sel, row, t, now)}</Card> : null}
      <Stack gap="xs">
        <Text muted size="xs">
          {[plural(t.turns.filter((x) => !x.earlier && !x.auto).length, 'turn'), plural(t.requests, 'request'), plural(t.calls, 'call'), t.tps ? `${t.tps} tok/s end to end` : null].filter(Boolean).join(' · ')}
        </Text>
        {t.next != null ? (
          <Text muted size="xs">
            The next request sends at least {kTok(t.next)} tokens.
          </Text>
        ) : null}
        {t.truncated ? (
          <Text muted size="xs">
            Only the newest part of this session is shown.
          </Text>
        ) : null}
      </Stack>
    </Stack>
  )
}

function cardTitle(r: Row): string {
  switch (r.kind) {
    case 'fixed':
      return 'Fixed overhead'
    case 'turn':
      return turnName(r.turn)
    case 'you':
      return 'Your prompt'
    case 'compact':
      return 'Context compacted'
    case 'claude':
      return `Request #${r.step.n}`
    case 'sub':
      return r.call.tool
    default:
      return isAgentTool(r.call.tool) ? (r.call.agentType ?? 'Agent') : r.call.tool
  }
}

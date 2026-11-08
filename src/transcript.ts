// A Claude Code session transcript (one JSON object per line) turned into a
// trajectory: each prompt starts a turn, each request the main loop sent the
// model is a step of it, and each tool call hangs under the request that made
// it, a subagent's own calls under the Agent call that started it.
//
// Plain logic, no I/O. Every line is untrusted: fields are type-checked as
// they are read, and only short cleaned previews are kept (see redact.ts).
// Parsing happens in two passes so a growing file can be read incrementally:
// `slim()` reduces each line to a small record as it arrives, and `build()`
// turns the records into the trajectory on each request.

import type { Call, FixedItem, FixedPart, Step, SubCall, Trajectory, Turn } from './protocol.ts'
import { isAgentTool, plural } from './format.ts'
import { firstLines, HIDDEN, preview, findSecret, stripControls, cut } from './redact.ts'

export const LIMITS = {
  steps: 60, // requests kept, newest
  subcalls: 40, // per Agent call, newest
  inputPairs: 8,
  valueChars: 160,
  previewChars: 200,
  records: 50_000, // slim records kept per file, newest
  fixedItems: 200, // listed per category of the fixed overhead, largest
  fixedName: 80
}

// ---------------------------------------------------------------- reading fields

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, max = 256): string | null => (typeof v === 'string' && v.length <= max ? v : null)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
function time(v: unknown): number | null {
  if (typeof v !== 'string' || v.length > 40) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}
const ID = /^[A-Za-z0-9_-]{1,128}$/
const id = (v: unknown): string | null => (typeof v === 'string' && ID.test(v) ? v : null)
const TOOL = /^[A-Za-z0-9_.:-]{1,128}$/
const toolName = (v: unknown): string | null => (typeof v === 'string' && TOOL.test(v) ? v : null)

// ---------------------------------------------------------------- tool calls

// A few words on what a call is about: the command for Bash, a file's name, a
// search pattern. Masked when it looks secret.
export function toolSummary(tool: string, input: unknown): string {
  const i = isObj(input) ? input : {}
  const s = (k: string): string => (typeof i[k] === 'string' ? (i[k] as string) : '')
  const base = (p: string): string => p.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
  let out: string
  switch (tool) {
    // A leading "cd <dir> &&" says where, not what: the command after it is the news.
    case 'Bash':
      out = s('command').replace(/^\s*cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, '')
      break
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      out = base(s('file_path') || s('notebook_path'))
      break
    case 'Grep':
      out = s('pattern') ? `"${s('pattern')}"` : ''
      break
    case 'Glob':
      out = s('pattern')
      break
    case 'WebFetch':
      out = s('url')
      break
    case 'WebSearch':
      out = s('query')
      break
    case 'Agent':
    case 'Task':
      out = s('description')
      break
    case 'Skill':
      out = [s('skill'), s('args')].filter(Boolean).join(' ')
      break
    default:
      out = s('description') || s('command') || s('query') || s('pattern') || s('url')
  }
  return preview(out, 80)
}

// A call's input as [name, value] pairs, each value one line and cut short.
function inputPairs(input: unknown): [string, string][] {
  if (!isObj(input)) return []
  const out: [string, string][] = []
  for (const k of Object.keys(input)) {
    const v = input[k]
    if (v === undefined || v === null) continue
    const name = cut(stripControls(k).replace(/\s+/g, ' '), 40)
    let text: string
    try {
      text = typeof v === 'string' ? v : (JSON.stringify(v) ?? '')
    } catch {
      text = ''
    }
    out.push([name, preview(text, LIMITS.valueChars) || (text ? '' : '–')])
    if (out.length >= LIMITS.inputPairs) break
  }
  return out
}

// ---------------------------------------------------------------- slim records

export type ToolUse = { id: string; tool: string; summary: string; input: [string, string][]; agentType: string | null }

// What a request's fixed part is made of. Only names and sizes are kept: never the text.
type Sized = { name: string; chars: number }
type CtxCat = 'skills' | 'mcpInstructions' | 'agents' | 'deferred' | 'memory' | 'other'

export type Rec =
  | { k: 'req'; ts: number; id: string; main: boolean; shape: string | null }
  | { k: 'shape'; hash: string; system: number; tools: Sized[] }
  | { k: 'ctx'; cat: CtxCat; chars: number; items: Sized[] }
  | { k: 'compact'; ts: number }
  | { k: 'prompt'; ts: number; text: string; chars: number; auto: string | null }
  | { k: 'result'; ts: number; id: string; isError: boolean; chars: number; lines: string[] }
  | {
      k: 'asst'
      ts: number
      key: string
      ref: string | null
      usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null
      stop: string | null
      model: string | null
      text: string
      tools: ToolUse[]
    }

// The text of a tool result's content: a string, or text blocks.
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const b of content) {
    if (isObj(b) && b.type === 'text' && typeof b.text === 'string') out += (out ? '\n' : '') + b.text
    if (out.length > 200_000) break
  }
  return out
}

// A user line's text with the reminders Claude Code adds taken out; null when it holds no prompt.
function userText(content: unknown): string | null {
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    for (const b of content) {
      if (!isObj(b)) continue
      if (b.type === 'tool_result') return null
      if (b.type === 'text' && typeof b.text === 'string') text += (text ? '\n' : '') + b.text
    }
  } else return null
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
}

// Lines Claude Code writes as a user's that nobody typed, each starting requests of its own.
const EVENTS: Readonly<Record<string, string>> = {
  'task-notification': 'Background task',
  'ci-monitor-event': 'CI event',
  'side-sessions-event': 'Side session'
}

function eventOf(text: string): string | null {
  const tag = /^<([a-z-]{1,40})>/.exec(text)?.[1]
  return tag && Object.hasOwn(EVENTS, tag) ? EVENTS[tag] : null
}

// What a person typed, from a user line's text; null when the line is not a prompt.
function promptText(raw: string): string | null {
  let text = raw
  // Output of local commands and the caveat before it are not prompts.
  if (/^\s*<(?:local-command-(?:stdout|stderr|caveat)|bash-(?:stdout|stderr))>/.test(text)) return null
  if (/^\s*Caveat: The messages below/.test(text)) return null
  if (/^\s*\[Request interrupted by user/.test(text)) return null
  // A slash command reads as what was typed: "/name args".
  const cmd = /<command-name>([^<]{1,100})<\/command-name>/.exec(text)
  if (cmd) {
    const args = /<command-args>([^<]{0,2000})<\/command-args>/.exec(text)
    const name = cmd[1].trim()
    return `${name.startsWith('/') ? name : `/${name}`}${args?.[1].trim() ? ` ${args[1].trim()}` : ''}`
  }
  // A command run with "!" reads as what was typed.
  const bash = /^\s*<bash-input>([\s\S]*?)<\/bash-input>/.exec(text)
  if (bash) return `! ${bash[1].trim()}`
  // What the editor had open comes before the words typed.
  for (let m; (m = /^\s*<(ide_opened_file|ide_selection)>[\s\S]*?<\/\1>/.exec(text)); ) text = text.slice(m[0].length)
  return text.trim() || null
}

const sizeOf = (v: unknown): number => {
  try {
    return JSON.stringify(v)?.length ?? 0
  } catch {
    return 0
  }
}
const textLen = (v: unknown): number => (typeof v === 'string' ? v.length : 0)
const itemName = (v: unknown): string => preview(v, LIMITS.fixedName)

// An `api-request-shape` line: the system prompt and the tool definitions a request was sent with.
function shapeRec(line: Obj): Rec | null {
  const hash = id(line.shapeHash)
  const shape = isObj(line.shape) ? line.shape : null
  if (!hash || !shape) return null
  const system = Array.isArray(shape.system) ? shape.system.reduce((n: number, b) => n + (isObj(b) ? textLen(b.text) : 0), 0) : 0
  const tools: Sized[] = []
  if (Array.isArray(shape.tools)) {
    for (const t of shape.tools.slice(0, 1000)) {
      const name = isObj(t) ? toolName(t.name) : null
      if (name) tools.push({ name, chars: sizeOf(t) })
    }
  }
  return { k: 'shape', hash, system, tools }
}

const LISTED = 1000 // names read from any one listing

// A listing as a size per name. `names` says what is listed, so a bullet in a
// wrapped description is part of the entry above it and not an entry of its own.
function listed(text: string, names: unknown): Sized[] {
  if (!Array.isArray(names)) return []
  const known = new Set(names.slice(0, LISTED).filter((n): n is string => typeof n === 'string'))
  const out: Sized[] = []
  for (const l of text.split('\n')) {
    const end = l.startsWith('- ') ? l.indexOf(': ') : -1
    const name = l.startsWith('- ') ? (end > 0 ? l.slice(2, end) : l.slice(2)).trim() : ''
    if (known.has(name) && out.length < LISTED) out.push({ name: itemName(name), chars: l.length })
    else if (out.length) out[out.length - 1].chars += l.length
  }
  return out
}

// Two lists read side by side: a name and the text it stands for.
function zipped(names: unknown, texts: unknown): Sized[] {
  if (!Array.isArray(names) || !Array.isArray(texts)) return []
  return names.slice(0, 1000).map((n, i) => ({ name: itemName(n), chars: textLen(texts[i]) })).filter((x) => x.name)
}

// An `attachment` line: context Claude Code adds to a request, by what it is.
function ctxRec(line: Obj): Rec | null {
  const a = isObj(line.attachment) ? line.attachment : null
  if (!a || !Array.isArray(line.rendered)) return null
  const chars = line.rendered.reduce((n: number, r) => n + (isObj(r) ? textLen(r.content) : 0), 0)
  if (!chars) return null
  switch (a.type) {
    case 'skill_listing':
      return { k: 'ctx', cat: 'skills', chars, items: typeof a.content === 'string' ? listed(a.content, a.names) : [] }
    case 'mcp_instructions_delta':
      return { k: 'ctx', cat: 'mcpInstructions', chars, items: zipped(a.addedNames, a.addedBlocks) }
    case 'agent_listing_delta':
      return { k: 'ctx', cat: 'agents', chars, items: zipped(a.addedTypes, a.addedLines) }
    case 'deferred_tools_delta':
      return { k: 'ctx', cat: 'deferred', chars, items: [] }
    case 'instructions': {
      const files = Array.isArray(a.files) ? a.files.filter(isObj) : []
      return { k: 'ctx', cat: 'memory', chars, items: files.slice(0, 1000).map((f) => ({ name: preview(f.path, 200), chars: textLen(f.content) })).filter((x) => x.name) }
    }
    default:
      return { k: 'ctx', cat: 'other', chars, items: [{ name: itemName(a.type) || 'other', chars }] }
  }
}

/** One transcript line, parsed, as the small record the trajectory needs, or null. */
export function slim(line: unknown, sidechain = false): Rec | null {
  if (!isObj(line)) return null
  // Subagents' work lives in their own files (read with `sidechain`); inline sidechains are left out.
  if (!sidechain && line.isSidechain === true) return null
  const ts = time(line.timestamp)
  const type = line.type
  if (type === 'api-request') {
    const reqId = id(line.id)
    if (ts == null || !reqId) return null
    const source = str(line.querySource, 80)
    return { k: 'req', ts, id: reqId, main: source == null || /^(?:repl_main_thread|sdk)/.test(source), shape: id(line.shapeHash) }
  }
  if (type === 'api-request-shape') return shapeRec(line)
  if (type === 'attachment') return sidechain ? null : ctxRec(line)
  if (type === 'system') {
    if (line.subtype === 'compact_boundary' && ts != null) return { k: 'compact', ts }
    return null
  }
  if (ts == null) return null
  const message = isObj(line.message) ? line.message : null
  if (!message) return null
  if (type === 'user') {
    const content = message.content
    if (Array.isArray(content) && content.some((b) => isObj(b) && b.type === 'tool_result')) {
      // One record per result; the caller spreads them.
      const b = content.find((x) => isObj(x) && x.type === 'tool_result') as Obj
      const useId = id(b.tool_use_id)
      if (!useId) return null
      const text = resultText(b.content)
      return { k: 'result', ts, id: useId, isError: b.is_error === true, chars: text.length, lines: firstLines(text) }
    }
    if (line.isMeta === true || line.isCompactSummary === true) return null
    const raw = userText(content)
    if (raw == null) return null
    const auto = eventOf(raw)
    if (auto) return { k: 'prompt', ts, text: '', chars: raw.length, auto } // none of its text is kept
    const text = promptText(raw)
    if (text == null) return null
    return { k: 'prompt', ts, text: preview(text, LIMITS.previewChars), chars: text.length, auto: null }
  }
  if (type === 'assistant') {
    const key = str(line.requestId, 128) ?? str(message.id, 128) ?? str(line.uuid, 128)
    if (!key) return null
    const u = isObj(message.usage) ? message.usage : null
    let text = ''
    const tools: ToolUse[] = []
    if (Array.isArray(message.content)) {
      for (const b of message.content) {
        if (!isObj(b)) continue
        if (b.type === 'text' && typeof b.text === 'string') text += (text ? ' ' : '') + b.text.slice(0, 2000)
        if (b.type === 'tool_use') {
          const useId = id(b.id)
          const tool = toolName(b.name)
          if (!useId || !tool) continue
          const input = isObj(b.input) ? b.input : {}
          tools.push({
            id: useId,
            tool,
            summary: toolSummary(tool, input),
            input: inputPairs(input),
            agentType: isAgentTool(tool) ? (preview(input.subagent_type, 60) || null) : null
          })
        }
      }
    }
    return {
      k: 'asst',
      ts,
      key,
      ref: id(line.requestRef),
      usage: u
        ? {
            input: num(u.input_tokens),
            output: num(u.output_tokens),
            cacheRead: num(u.cache_read_input_tokens),
            cacheWrite: num(u.cache_creation_input_tokens)
          }
        : null,
      stop: str(message.stop_reason, 40),
      model: str(message.model, 80),
      text: preview(text, LIMITS.previewChars),
      tools
    }
  }
  return null
}

/** Every tool result in a user line: `slim` keeps the first, this the rest. */
export function slimAll(line: unknown, sidechain = false): Rec[] {
  const first = slim(line, sidechain)
  if (!first) return []
  if (first.k !== 'result' || !isObj(line)) return [first]
  const message = line.message as Obj
  const out: Rec[] = []
  for (const b of message.content as unknown[]) {
    if (!isObj(b) || b.type !== 'tool_result') continue
    const useId = id(b.tool_use_id)
    if (!useId) continue
    const text = resultText(b.content)
    out.push({ k: 'result', ts: first.ts, id: useId, isError: b.is_error === true, chars: text.length, lines: firstLines(text) })
  }
  return out
}

/** Lines of JSONL text as records. Lines that are not JSON, or too long, are skipped. */
export function parseLines(text: string, { sidechain = false, maxLine = 4 * 1024 * 1024 } = {}): Rec[] {
  const out: Rec[] = []
  for (const line of text.split('\n')) {
    if (!line || line.length > maxLine) continue
    let o: unknown
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    for (const r of slimAll(o, sidechain)) out.push(r)
  }
  return out
}

// ---------------------------------------------------------------- a subagent

export type Subagent = { toolUseId: string; agentType: string | null; records: Rec[] }

// A subagent's own calls, oldest first. `by` names the agent when its calls sit under another's.
function subCalls(sa: Subagent, by: string | null): SubCall[] {
  const calls = new Map<string, SubCall>()
  for (const r of sa.records) {
    if (r.k === 'asst') {
      for (const t of r.tools) calls.set(t.id, { id: t.id, tool: t.tool, summary: t.summary, at: r.ts, ms: null, done: false, isError: false, by })
    } else if (r.k === 'result') {
      const c = calls.get(r.id)
      if (c) Object.assign(c, { ms: Math.max(0, r.ts - c.at), done: true, isError: r.isError })
    }
  }
  return [...calls.values()]
}

// The Agent call in the main loop an agent's work hangs under: its own, or
// the one that led to it when another subagent started it.
function ownerCall(sa: Subagent, calls: ReadonlyMap<string, Call>, startedBy: ReadonlyMap<string, string>): Call | null {
  const seen = new Set<string>() // a transcript could say two agents started each other
  for (let at: string | undefined = sa.toolUseId; at && !seen.has(at); at = startedBy.get(at)) {
    const c = calls.get(at)
    if (c) return c
    seen.add(at)
  }
  return null
}

// ---------------------------------------------------------------- the fixed overhead

const LABEL: Record<CtxCat, string> = {
  skills: 'Skills',
  mcpInstructions: 'MCP server instructions',
  agents: 'Agents',
  deferred: 'Deferred tool names',
  memory: 'Memory files',
  other: 'Environment and reminders'
}
const ID_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i

function merged(list: readonly Sized[]): Sized[] {
  const by = new Map<string, number>()
  for (const x of list) by.set(x.name, (by.get(x.name) ?? 0) + x.chars)
  return [...by].map(([name, chars]) => ({ name, chars })).sort((a, b) => b.chars - a.chars)
}

/**
 * The fixed overhead by what it is made of. A transcript gives each part's
 * size in characters, and tool definitions take more tokens per character
 * than prose, so no count per character holds: `total` is spread over the
 * parts by size, and each figure is its share of the estimate.
 */
function fixedParts(total: number, shape: Extract<Rec, { k: 'shape' }> | null, ctx: readonly Extract<Rec, { k: 'ctx' }>[]): FixedPart[] | null {
  if (!shape) return null
  type Draft = { key: string; name: string; chars: number; note: string | null; items: Sized[]; groups?: { name: string; chars: number; items: Sized[] }[] }
  const drafts: Draft[] = []
  const add = (d: Draft): void => {
    if (d.chars > 0) drafts.push(d)
  }
  add({ key: 'system', name: 'System prompt', chars: shape.system, note: null, items: [] })
  const builtIn = shape.tools.filter((t) => !t.name.startsWith('mcp__'))
  add({ key: 'tools', name: 'Built-in tools', chars: builtIn.reduce((n, t) => n + t.chars, 0), note: plural(builtIn.length, 'tool'), items: merged(builtIn) })
  const servers = new Map<string, Sized[]>()
  for (const t of shape.tools) {
    const m = /^mcp__(.+?)__(.+)$/.exec(t.name)
    if (m) servers.set(m[1], [...(servers.get(m[1]) ?? []), { name: m[2], chars: t.chars }])
  }
  const groups = [...servers].map(([server, items]) => {
    const tools = merged(items)
    // A connector's server can be named by an id: its first tools say more.
    const name = ID_LIKE.test(server) ? `Connector · ${tools.slice(0, 3).map((x) => x.name).join(', ')}${tools.length > 3 ? ', …' : ''}` : itemName(server)
    return { name, chars: tools.reduce((n, x) => n + x.chars, 0), items: tools }
  }).sort((a, b) => b.chars - a.chars)
  add({ key: 'mcp', name: 'MCP tools', chars: groups.reduce((n, g) => n + g.chars, 0), note: plural(groups.length, 'server'), items: [], groups })
  for (const cat of ['mcpInstructions', 'memory', 'skills', 'agents', 'deferred', 'other'] as const) {
    const recs = ctx.filter((r) => r.cat === cat)
    const items = merged(recs.flatMap((r) => r.items))
    const noun = cat === 'memory' ? 'file' : cat === 'skills' ? 'skill' : cat === 'agents' ? 'agent type' : cat === 'mcpInstructions' ? 'server' : null
    add({ key: cat, name: LABEL[cat], chars: recs.reduce((n, r) => n + r.chars, 0), note: noun && items.length ? plural(items.length, noun) : null, items })
  }
  const sum = drafts.reduce((n, d) => n + d.chars, 0)
  if (!sum) return null
  const scale = total / sum
  const leaf = (x: Sized): FixedItem => ({ name: x.name, tokens: Math.round(x.chars * scale) })
  const pieces: Piece[] = drafts.map((d) => ({ chars: d.chars, tokens: null }))
  splitBySize(pieces, total)
  return drafts.map((d, i) => {
    const items: FixedItem[] = d.groups
      ? d.groups.map((g) => ({ name: g.name, tokens: Math.round(g.chars * scale), items: g.items.slice(0, LIMITS.fixedItems).map(leaf) }))
      : d.items.slice(0, LIMITS.fixedItems).map(leaf)
    return { key: d.key, name: d.name, note: d.note, tokens: pieces[i].tokens ?? 0, ...(items.length ? { items } : {}) }
  })
}

// ---------------------------------------------------------------- the trajectory

type Piece = { chars: number; tokens: number | null; call?: Call; turn?: Turn }
type StepW = Step & { key: string; added: Piece[]; turnN: number; usageSeen: boolean }

// Spreads `total` over `pieces` by their characters. The parts sum to it and
// none is below zero: what rounding down leaves goes to the largest remainders.
function splitBySize(pieces: Piece[], total: number): void {
  const sum = pieces.reduce((n, p) => n + Math.max(1, p.chars), 0)
  const exact = pieces.map((p) => (total * Math.max(1, p.chars)) / sum)
  const shares = exact.map(Math.floor)
  let left = total - shares.reduce((n, x) => n + x, 0)
  const order = exact.map((x, i) => ({ i, rem: x - Math.floor(x) })).sort((a, b) => b.rem - a.rem || a.i - b.i)
  for (const { i } of order) {
    if (left <= 0) break
    shares[i]++
    left--
  }
  pieces.forEach((p, i) => {
    p.tokens = shares[i]
  })
}

const LIVE_MS = 10 * 60_000 // a request with no end this recent is still under way

/**
 * The trajectory from a session's records, oldest first. `complete` says the
 * records start at the session's start (so the first request tells the fixed
 * overhead); `now` decides what is still under way.
 */
export function build(records: readonly Rec[], subagents: readonly Subagent[], complete: boolean, now = Date.now()): Trajectory {
  const turns: Turn[] = []
  const steps: StepW[] = []
  const calls = new Map<string, Call>()
  const reqAt = new Map<string, number>()
  let stepIn: Piece[] = []
  let turn: Turn | null = null
  let compactNext = false
  let lastTs: number | null = null
  let pending: { ts: number; id: string } | null = null
  let cur: StepW | null = null
  const shapes = new Map<string, Extract<Rec, { k: 'shape' }>>()
  const ctxFirst: Extract<Rec, { k: 'ctx' }>[] = [] // what came with the first request
  const shapeOf = new Map<string, string>() // main requests' shapes, by request
  let shapeBefore: string | null = null // the last sent before the first reply: an earlier one may have been retried
  let firstRef: string | null = null

  const earlierTurn = (at: number): Turn => {
    const t: Turn = { n: 0, at, prompt: '', chars: 0, tokens: null, earlier: true, auto: null, steps: [] }
    turns.push(t)
    return t
  }

  for (const r of records) {
    if (r.k === 'req') {
      reqAt.set(r.id, r.ts)
      if (r.main) pending = { ts: r.ts, id: r.id }
      if (r.main && r.shape) {
        shapeOf.set(r.id, r.shape)
        if (!steps.length) shapeBefore = r.shape
      }
    } else if (r.k === 'shape') {
      shapes.set(r.hash, r)
      continue
    } else if (r.k === 'ctx') {
      if (!steps.length) ctxFirst.push(r)
      continue
    } else if (r.k === 'compact') {
      compactNext = true
      cur = null
    } else if (r.k === 'prompt') {
      turn = { n: 0, at: r.ts, prompt: r.text, chars: r.chars, tokens: null, earlier: false, auto: r.auto, steps: [] }
      turns.push(turn)
      stepIn.push({ chars: r.chars, tokens: null, turn })
      cur = null
    } else if (r.k === 'result') {
      const c = calls.get(r.id)
      if (c) {
        Object.assign(c, { ms: Math.max(0, r.ts - c.at), done: true, isError: r.isError, chars: r.chars, lines: r.lines })
        stepIn.push({ chars: r.chars, tokens: null, call: c })
      }
      cur = null
    } else if (r.k === 'asst') {
      if (!cur || cur.key !== r.key) {
        const t: Turn = turn ?? earlierTurn(r.ts)
        turn = t
        if (!steps.length) firstRef = r.ref
        const sent = (r.ref ? reqAt.get(r.ref) : undefined) ?? lastTs ?? r.ts
        cur = {
          key: r.key,
          n: steps.length + 1,
          at: Math.min(sent, r.ts),
          firstAt: r.ts,
          endedAt: r.ts,
          status: 'done',
          input: null,
          output: null,
          cacheRead: 0,
          text: '',
          stopReason: null,
          model: null,
          isCompacted: compactNext,
          calls: [],
          added: stepIn,
          turnN: t.n,
          usageSeen: false
        }
        compactNext = false
        stepIn = []
        steps.push(cur)
        t.steps.push(cur)
        if (r.ref && pending?.id === r.ref) pending = null
      }
      cur.endedAt = r.ts
      if (r.usage) {
        cur.usageSeen = true
        cur.input = r.usage.input + r.usage.cacheRead + r.usage.cacheWrite
        cur.output = r.usage.output
        cur.cacheRead = r.usage.cacheRead
      }
      if (r.stop) cur.stopReason = r.stop
      if (r.model) cur.model = r.model
      if (r.text) cur.text = cur.text ? preview(`${cur.text} ${r.text}`, LIMITS.previewChars) : r.text
      for (const t of r.tools) {
        if (calls.has(t.id)) continue
        const c: Call = { ...t, at: r.ts, ms: null, done: false, isError: false, by: null, lines: [], chars: null, tokens: null, sub: [] }
        calls.set(t.id, c)
        cur.calls.push(c)
      }
    }
    lastTs = Math.max(lastTs ?? r.ts, r.ts)
  }

  // A request sent after the last reply with nothing back yet: under way.
  const lastStep = steps.at(-1)
  if (pending && (!lastStep || pending.ts >= (lastStep.endedAt ?? 0)) && now - pending.ts < LIVE_MS) {
    const t: Turn = turn ?? earlierTurn(pending.ts)
    const s: StepW = {
      key: pending.id, n: steps.length + 1, at: pending.ts, firstAt: null, endedAt: null, status: 'streaming',
      input: null, output: null, cacheRead: 0, text: '', stopReason: null, model: null, isCompacted: compactNext,
      calls: [], added: stepIn, turnN: t.n, usageSeen: false
    }
    steps.push(s)
    t.steps.push(s)
  } else if (lastStep && !lastStep.stopReason && lastStep.endedAt != null && now - lastStep.endedAt < LIVE_MS) {
    lastStep.status = 'streaming'
  }

  // Subagents' calls under the Agent call that started each.
  // An agent another subagent started goes under the same call, its calls among theirs.
  const startedBy = new Map<string, string>()
  const known = new Set(subagents.map((sa) => sa.toolUseId))
  for (const sa of subagents) {
    for (const r of sa.records) {
      if (r.k !== 'asst') continue
      for (const t of r.tools) if (known.has(t.id)) startedBy.set(t.id, sa.toolUseId)
    }
  }
  const owners = new Set<Call>()
  for (const sa of subagents) {
    const c = ownerCall(sa, calls, startedBy)
    if (!c) continue
    c.sub.push(...subCalls(sa, sa.toolUseId === c.id ? null : (sa.agentType ?? 'Agent')))
    owners.add(c)
    if (sa.agentType && sa.toolUseId === c.id) c.agentType = sa.agentType
  }
  // A transcript can repeat an id: each call once, or the rows can't be told apart.
  for (const c of owners) c.sub = [...new Map(c.sub.map((sc) => [sc.id, sc])).values()].sort((a, b) => a.at - b.at).slice(-LIMITS.subcalls)

  // What each request carried new, in tokens: its growth over the last one, spread by size.
  let prev: StepW | null = null
  for (const s of steps) {
    if (s.input == null) continue
    if (prev?.input != null && prev.output != null) {
      if (s.input < prev.input) s.isCompacted = true
      else if (s.added.length) splitBySize(s.added, Math.max(0, s.input - prev.input - prev.output))
    }
    for (const p of s.added) {
      if (p.tokens == null) continue
      if (p.call) p.call.tokens = p.tokens
      if (p.turn) p.turn.tokens = p.tokens
    }
    prev = s
  }

  // The fixed overhead: the first request's input less what its prompt added.
  let overhead: number | null = null
  const first = steps[0]
  if (complete && first?.input != null) {
    const typed = first.added.reduce((n, p) => n + Math.round(p.chars / 4), 0)
    overhead = Math.max(0, first.input - typed)
  }

  // Keep the newest steps, and the turns they belong to (plus a prompt waiting on its first reply).
  const keep = new Set(steps.slice(-LIMITS.steps))
  const lastTurn = turns.at(-1)
  // Numbered before any are left out, so a turn keeps its number as the session grows.
  // A prompt that sent no request (a local command, say) is not a turn.
  let turnN = 0
  for (const t of turns) if (!t.earlier && !t.auto && (t.steps.length || t === lastTurn)) t.n = ++turnN
  const outTurns: Turn[] = []
  for (const t of turns) {
    const kept = t.steps.filter((s) => keep.has(s as StepW))
    if (!kept.length && t !== lastTurn) continue
    if (!kept.length && (t.earlier || t.auto)) continue
    outTurns.push({ ...t, steps: kept.map(clean) })
  }

  const shown = steps.filter((s) => keep.has(s))
  // Output speed end to end, request sent to last block: the transcript stamps
  // a block when it is written whole, so the time spent generating is not known.
  const done = shown.filter((s) => s.status === 'done' && s.output != null && s.endedAt != null)
  const gen = done.reduce((n, s) => n + Math.max(0, (s.endedAt ?? s.at) - s.at), 0)
  const out = done.reduce((n, s) => n + (s.output ?? 0), 0)
  const last = steps.filter((s) => s.input != null).at(-1)
  return {
    turns: outTurns,
    overhead,
    fixed: overhead != null ? fixedParts(overhead, shapes.get((firstRef ? shapeOf.get(firstRef) : null) ?? shapeBefore ?? '') ?? null, ctxFirst) : null,
    fixedTrimmed: false,
    truncated: !complete || steps.length > LIMITS.steps,
    requests: steps.length,
    calls: [...calls.values()].reduce((n, c) => n + 1 + c.sub.length, 0),
    tps: gen >= 200 ? Math.round(out / (gen / 1000)) : null,
    next: last ? (last.input ?? 0) + (last.output ?? 0) : null
  }
}

// A step as the panel gets it: the working fields dropped.
function clean(s: Step): Step {
  const { n, at, firstAt, endedAt, status, input, output, cacheRead, text, stopReason, model, isCompacted, calls } = s
  return { n, at, firstAt, endedAt, status, input, output, cacheRead, text, stopReason, model, isCompacted, calls }
}

/** A session title from an `ai-title` or `summary` line, cleaned. */
export function titleOf(line: unknown): string | null {
  if (!isObj(line)) return null
  const t = line.type === 'ai-title' ? line.aiTitle : line.type === 'summary' ? line.summary : line.type === 'custom-title' ? line.customTitle : null
  const p = preview(t, 80)
  return p && p !== HIDDEN ? p : null
}

/** The working directory a transcript line was written in, or null. */
export function cwdOf(line: unknown): string | null {
  return isObj(line) && typeof line.cwd === 'string' && line.cwd.length <= 4096 ? line.cwd : null
}

export { findSecret }

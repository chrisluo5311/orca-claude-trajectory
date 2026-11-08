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

import type { Call, Step, SubCall, Trajectory, Turn } from './protocol.ts'
import { firstLines, HIDDEN, preview, findSecret, stripControls, cut } from './redact.ts'

export const LIMITS = {
  steps: 60, // requests kept, newest
  subcalls: 40, // per Agent call, newest
  inputPairs: 8,
  valueChars: 160,
  previewChars: 200,
  records: 50_000 // slim records kept per file, newest
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

const isAgentTool = (tool: string): boolean => tool === 'Agent' || tool === 'Task'

// ---------------------------------------------------------------- slim records

export type ToolUse = { id: string; tool: string; summary: string; input: [string, string][]; agentType: string | null }

export type Rec =
  | { k: 'req'; ts: number; id: string; main: boolean }
  | { k: 'compact'; ts: number }
  | { k: 'prompt'; ts: number; text: string; chars: number }
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

// What a person typed, from a user line's content; null when the line is not a prompt.
function promptText(content: unknown): string | null {
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    for (const b of content) {
      if (!isObj(b)) continue
      if (b.type === 'tool_result') return null
      if (b.type === 'text' && typeof b.text === 'string') text += (text ? '\n' : '') + b.text
    }
  } else return null
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
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  return text || null
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
    return { k: 'req', ts, id: reqId, main: source == null || /^(?:repl_main_thread|sdk)/.test(source) }
  }
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
    const text = promptText(content)
    if (text == null) return null
    return { k: 'prompt', ts, text: preview(text, LIMITS.previewChars), chars: text.length }
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

// A subagent's own calls, oldest first, the newest LIMITS.subcalls of them.
function subCalls(sa: Subagent): SubCall[] {
  const calls = new Map<string, SubCall>()
  for (const r of sa.records) {
    if (r.k === 'asst') {
      for (const t of r.tools) calls.set(t.id, { id: t.id, tool: t.tool, summary: t.summary, at: r.ts, ms: null, done: false, isError: false })
    } else if (r.k === 'result') {
      const c = calls.get(r.id)
      if (c) Object.assign(c, { ms: Math.max(0, r.ts - c.at), done: true, isError: r.isError })
    }
  }
  return [...calls.values()].slice(-LIMITS.subcalls)
}

// ---------------------------------------------------------------- the trajectory

type Piece = { chars: number; tokens: number | null; call?: Call; turn?: Turn }
type StepW = Step & { key: string; added: Piece[]; turnN: number; usageSeen: boolean }

// Spreads `total` over `pieces` by their characters; the parts sum to it.
function splitBySize(pieces: Piece[], total: number): void {
  const sum = pieces.reduce((n, p) => n + Math.max(1, p.chars), 0)
  let left = total
  pieces.forEach((p, i) => {
    p.tokens = i === pieces.length - 1 ? left : Math.round((total * Math.max(1, p.chars)) / sum)
    left -= p.tokens
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

  const earlierTurn = (at: number): Turn => {
    const t: Turn = { n: 0, at, prompt: '', chars: 0, tokens: null, earlier: true, steps: [] }
    turns.push(t)
    return t
  }

  for (const r of records) {
    if (r.k === 'req') {
      reqAt.set(r.id, r.ts)
      if (r.main) pending = { ts: r.ts, id: r.id }
    } else if (r.k === 'compact') {
      compactNext = true
      cur = null
    } else if (r.k === 'prompt') {
      turn = { n: turns.filter((t) => !t.earlier).length + 1, at: r.ts, prompt: r.text, chars: r.chars, tokens: null, earlier: false, steps: [] }
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
        const c: Call = { ...t, at: r.ts, ms: null, done: false, isError: false, lines: [], chars: null, tokens: null, sub: [] }
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
  for (const sa of subagents) {
    const c = calls.get(sa.toolUseId)
    if (!c) continue
    c.sub = subCalls(sa)
    if (sa.agentType) c.agentType = sa.agentType
  }

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
  const outTurns: Turn[] = []
  for (const t of turns) {
    const kept = t.steps.filter((s) => keep.has(s as StepW))
    if (!kept.length && t !== lastTurn) continue
    if (!kept.length && t.earlier) continue
    outTurns.push({ ...t, steps: kept.map(clean) })
  }
  // Numbered as shown: a prompt that sent no request (a local command, say) is not a turn.
  let shownN = 0
  for (const t of outTurns) if (!t.earlier) t.n = ++shownN

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

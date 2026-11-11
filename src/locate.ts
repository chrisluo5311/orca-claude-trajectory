// Finding and reading a workspace's Claude Code transcripts, read-only.
//
// Claude Code keeps each session as `<config>/projects/<dir>/<session-id>.jsonl`,
// where <dir> is the working directory with every character other than a
// letter or digit turned into "-" (cut at 200 characters with a hash after it
// when longer). A subagent's transcript is `<session-id>/subagents/agent-<id>.jsonl`
// with a `.meta.json` beside it naming the Agent call that started it.
//
// Every path built here stays inside the projects folder: names are matched
// against strict patterns before they are joined, symbolic links are refused,
// and the real path is checked to be under the real projects folder before a
// file is opened. Files are opened with O_NOFOLLOW and read up to a byte cap.

import { constants, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { cwdOf, LIMITS, parseLines, tallyTurns, titleOf, type Rec, type Subagent, type TurnTally } from './transcript.ts'
import { isAgentTool } from './format.ts'
import type { SessionInfo } from './protocol.ts'

export const CAPS = {
  transcriptBytes: 32 * 1024 * 1024, // the newest part of a session read
  tallyBytes: 512 * 1024 * 1024, // of the part before it, scanned to number its turns: past this, numbers run low
  subagentBytes: 4 * 1024 * 1024,
  metaBytes: 16 * 1024,
  headBytes: 64 * 1024, // read to learn a session's working directory
  sessions: 20, // newest sessions listed per workspace
  subagents: 50 // newest subagent transcripts read per session
}

export const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const AGENT_META = /^agent-[A-Za-z0-9_-]{1,64}\.meta\.json$/
const MAX_SANITIZED = 200

/** Claude Code's config folder: $CLAUDE_CONFIG_DIR when it is an absolute path, else ~/.claude. */
export function claudeHome(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CLAUDE_CONFIG_DIR
  return dir && isAbsolute(dir) ? resolve(dir) : join(homedir(), '.claude')
}

/** A working directory as Claude Code names its project folder. */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Whether `child` is `root` or inside it, both real paths. */
export function within(root: string, child: string): boolean {
  return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep)
}

async function realRoot(home: string): Promise<string | null> {
  try {
    return await fs.realpath(join(home, 'projects'))
  } catch {
    return null
  }
}

// A real, non-link entry of `kind` inside `root`, or null.
async function safeEntry(root: string, path: string, kind: 'file' | 'dir'): Promise<string | null> {
  try {
    const st = await fs.lstat(path)
    if (st.isSymbolicLink()) return null
    if (kind === 'file' ? !st.isFile() : !st.isDirectory()) return null
    const real = await fs.realpath(path)
    return within(root, real) ? real : null
  } catch {
    return null
  }
}

/** Up to `max` bytes from the end of a file (`from: 'end'`) or its start, and whether that is all of it. */
export async function readCapped(path: string, max: number, from: 'end' | 'start' = 'end'): Promise<{ text: string; complete: boolean; size: number; startsAt: number }> {
  const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const st = await handle.stat()
    if (!st.isFile()) throw new Error('not a file')
    const size = st.size
    const length = Math.min(size, max)
    const start = from === 'end' ? size - length : 0
    const buf = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const { bytesRead } = await handle.read(buf, read, length - read, start + read)
      if (!bytesRead) break
      read += bytesRead
    }
    let text = buf.subarray(0, read).toString('utf8')
    const complete = start === 0 && read >= size
    // Started inside a line: drop it. Ended inside one: drop that too.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1)
    if (from === 'start' && !complete) text = text.slice(0, text.lastIndexOf('\n') + 1)
    return { text, complete, size, startsAt: start > 0 ? start + buf.subarray(0, read).indexOf(10) + 1 : 0 }
  } finally {
    await handle.close()
  }
}

/** The project folders that may hold a workspace's sessions, inside the projects folder. */
export async function projectDirs(home: string, cwd: string): Promise<{ root: string; dirs: { path: string; exact: boolean }[] } | null> {
  const root = await realRoot(home)
  if (!root || !isAbsolute(cwd)) return null
  const name = projectDirName(cwd)
  const dirs: { path: string; exact: boolean }[] = []
  if (name.length <= MAX_SANITIZED) {
    const p = await safeEntry(root, join(root, name), 'dir')
    if (p) dirs.push({ path: p, exact: true })
  } else {
    // Long paths are cut and given a hash Claude Code computes: match the cut, then check each session's cwd.
    const prefix = name.slice(0, MAX_SANITIZED)
    let entries: string[] = []
    try {
      entries = await fs.readdir(root)
    } catch {
      return { root, dirs }
    }
    for (const e of entries) {
      if (!e.startsWith(prefix) || e.length > MAX_SANITIZED + 40 || /[\\/]/.test(e)) continue
      const p = await safeEntry(root, join(root, e), 'dir')
      if (p) dirs.push({ path: p, exact: false })
    }
  }
  return { root, dirs }
}

type Found = SessionInfo & { file: string; dir: string }

// What a session's first and last lines said, by file, size and time: listing
// a workspace reads each session file only when it changed.
const heads = new Map<string, { key: string; cwd: string | null; title: string | null }>()
const HEADS = 500

async function sessionHead(file: string, size: number, mtime: number): Promise<{ cwd: string | null; title: string | null } | null> {
  const key = `${size}:${mtime}`
  const hit = heads.get(file)
  if (hit?.key === key) return hit
  const head = await readCapped(file, CAPS.headBytes, 'start').catch(() => null)
  if (!head) return null
  let cwd: string | null = null
  let title: string | null = null
  for (const line of head.text.split('\n')) {
    if (!line) continue
    let o: unknown
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    cwd ??= cwdOf(o)
    title = titleOf(o) ?? title
  }
  if (!head.complete) {
    // The newest title is near the end.
    const tail = await readCapped(file, CAPS.headBytes, 'end').catch(() => null)
    for (const line of tail?.text.split('\n') ?? []) {
      if (!line.includes('"ai-title"') && !line.includes('"summary"') && !line.includes('"custom-title"')) continue
      try {
        title = titleOf(JSON.parse(line)) ?? title
      } catch {
        /* a cut line */
      }
    }
  }
  const entry = { key, cwd, title }
  heads.delete(file)
  heads.set(file, entry)
  if (heads.size > HEADS) heads.delete(heads.keys().next().value!)
  return entry
}

/**
 * A workspace's sessions, newest first. A session is listed only when its
 * transcript says it ran in `cwd`; one too new to say is listed when its
 * folder's name matches exactly (two working directories can share a name).
 */
export async function listSessions(home: string, cwd: string): Promise<{ root: string; sessions: Found[] }> {
  const found = await projectDirs(home, cwd)
  if (!found) return { root: '', sessions: [] }
  const { root, dirs } = found
  const realCwd = await fs.realpath(cwd).catch(() => cwd)
  const candidates: { file: string; dir: string; exact: boolean; mtime: number; size: number; id: string }[] = []
  for (const d of dirs) {
    let names: string[] = []
    try {
      names = await fs.readdir(d.path)
    } catch {
      continue
    }
    for (const n of names) {
      if (!SESSION_FILE.test(n)) continue
      const file = await safeEntry(root, join(d.path, n), 'file')
      if (!file) continue
      const st = await fs.stat(file).catch(() => null)
      if (st) candidates.push({ file, dir: d.path, exact: d.exact, mtime: st.mtimeMs, size: st.size, id: n.slice(0, -'.jsonl'.length) })
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  const sessions: Found[] = []
  for (const c of candidates.slice(0, CAPS.sessions * 3)) {
    if (sessions.length >= CAPS.sessions) break
    const head = await sessionHead(c.file, c.size, c.mtime)
    if (!head) continue
    if (head.cwd ? head.cwd !== cwd && head.cwd !== realCwd : !c.exact) continue
    sessions.push({ id: c.id, title: head.title ?? 'Untitled session', updatedAt: Math.round(c.mtime), file: c.file, dir: c.dir })
  }
  return { root, sessions }
}

/** The subagents of a session: each one's Agent call id, type, and records. */
export async function readSubagents(root: string, dir: string, sessionId: string, mainCalls: ReadonlySet<string>): Promise<Subagent[]> {
  if (!SESSION_ID.test(sessionId)) return []
  const sub = await safeEntry(root, join(dir, sessionId, 'subagents'), 'dir')
  if (!sub) return []
  let names: string[] = []
  try {
    names = (await fs.readdir(sub)).filter((n) => AGENT_META.test(n))
  } catch {
    return []
  }
  const metas: { meta: string; jsonl: string; mtime: number; size: number }[] = []
  for (const n of names) {
    const meta = await safeEntry(root, join(sub, n), 'file')
    const jsonl = await safeEntry(root, join(sub, n.replace(/\.meta\.json$/, '.jsonl')), 'file')
    if (!meta || !jsonl) continue
    const st = await fs.stat(jsonl).catch(() => null)
    if (st) metas.push({ meta, jsonl, mtime: st.mtimeMs, size: st.size })
  }
  metas.sort((a, b) => b.mtime - a.mtime)
  // What each file says started it, whether or not it turns out to be wanted.
  const started: { m: (typeof metas)[number]; toolUseId: string; agentType: string | null }[] = []
  for (const m of metas.slice(0, CAPS.subagents)) {
    try {
      let said = metasRead.get(m.meta)
      if (!said) {
        const meta: unknown = JSON.parse((await readCapped(m.meta, CAPS.metaBytes, 'start')).text)
        if (typeof meta !== 'object' || meta === null) continue
        const { toolUseId, agentType } = meta as Record<string, unknown>
        if (typeof toolUseId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(toolUseId)) continue
        said = { toolUseId, agentType: typeof agentType === 'string' && /^[A-Za-z0-9_:.-]{1,60}$/.test(agentType) ? agentType : null }
        metasRead.set(m.meta, said)
        if (metasRead.size > CAPS.subagents * 4) metasRead.delete(metasRead.keys().next().value!)
      }
      started.push({ m, ...said })
    } catch {
      /* an unreadable subagent is left out */
    }
  }
  // Agents the main loop started, then any those started: an Agent call can sit in a subagent's own file.
  const wanted = new Set(mainCalls)
  const out: Subagent[] = []
  const left = new Set(started)
  for (let grew = true; grew; ) {
    grew = false
    for (const s of left) {
      if (!wanted.has(s.toolUseId)) continue
      left.delete(s)
      grew = true
      try {
        const agent = await readAgent(s.m, s.toolUseId, s.agentType)
        out.push(agent)
        for (const r of agent.records) if (r.k === 'asst') for (const t of r.tools) if (isAgentTool(t.tool)) wanted.add(t.id)
      } catch {
        /* an unreadable subagent is left out */
      }
    }
  }
  return out
}

async function readAgent(m: { jsonl: string; mtime: number; size: number }, toolUseId: string, agentType: string | null): Promise<Subagent> {
  const key = `${m.mtime}:${m.size}`
  const hit = agents.get(m.jsonl)
  if (hit?.key === key) return hit.agent
  const { text } = await readCapped(m.jsonl, CAPS.subagentBytes, 'end')
  const agent: Subagent = { toolUseId, agentType, records: parseSidechain(text) }
  agents.delete(m.jsonl)
  agents.set(m.jsonl, { key, agent })
  if (agents.size > CAPS.subagents * 2) agents.delete(agents.keys().next().value!)
  return agent
}

// What a subagent's meta file says started it, which doesn't change once written.
const metasRead = new Map<string, { toolUseId: string; agentType: string | null }>()

// Subagent transcripts already read, by file, size and time.
const agents = new Map<string, { key: string; agent: Subagent }>()

// A subagent's lines are all marked sidechain: read them as its own main loop.
function parseSidechain(text: string): Rec[] {
  return parseLines(text, { sidechain: true }).slice(-LIMITS.records)
}

// ---------------------------------------------------------------- a growing transcript

type Cached = { file: string; ino: number; size: number; complete: boolean; replied: boolean; records: Rec[]; before: TurnTally }

// Context lines only tell what came with the first request, so those after its
// reply aren't kept: they would push real records out. Says whether a reply came.
function dropLateContext(records: Rec[], replied: boolean): { records: Rec[]; replied: boolean } {
  const out: Rec[] = []
  for (const r of records) {
    if (r.k === 'asst') replied = true
    if (r.k !== 'ctx' || !replied) out.push(r)
  }
  return { records: out, replied }
}

/**
 * Reads a session's records, keeping what it read: a file that only grew is
 * read from where it ended; anything else is read again from the start.
 */
export class TranscriptCache {
  private entry: Cached | null = null

  async read(file: string): Promise<{ records: Rec[]; complete: boolean; before: TurnTally }> {
    const st = await fs.lstat(file)
    if (st.isSymbolicLink() || !st.isFile()) throw new Error('not a file')
    const e = this.entry
    if (e && e.file === file && e.ino === st.ino && st.size >= e.size && st.size - e.size <= CAPS.transcriptBytes) {
      if (st.size > e.size) {
        const added = await readRange(file, e.size, st.size)
        // Only whole lines: a line still being written is read next time.
        const end = added.lastIndexOf('\n') + 1
        const fresh = dropLateContext(parseLines(added.toString('utf8', 0, end)), e.replied)
        e.replied = fresh.replied
        e.records.push(...fresh.records)
        if (e.records.length > LIMITS.records) {
          // The session's start is gone now: its first request can't be told.
          tallyTurns(e.records.splice(0, e.records.length - LIMITS.records), e.before)
          e.complete = false
        }
        e.size += end
      }
      return { records: e.records, complete: e.complete, before: e.before }
    }
    const { text, complete: whole0, size, startsAt } = await readCapped(file, CAPS.transcriptBytes, 'end')
    const whole = text.slice(0, text.lastIndexOf('\n') + 1)
    const parsed = dropLateContext(parseLines(whole), false)
    const complete = whole0 && parsed.records.length <= LIMITS.records
    const records = parsed.records.slice(-LIMITS.records)
    const before = await tallyBefore(file, startsAt)
    tallyTurns(parsed.records.slice(0, -LIMITS.records), before)
    const consumed = size - Buffer.byteLength(text.slice(whole.length), 'utf8')
    this.entry = { file, ino: st.ino, size: consumed, complete, replied: parsed.replied, records, before }
    return { records, complete, before }
  }

  clear(): void {
    this.entry = null
  }
}

// The turns in the part of a transcript that isn't kept, a chunk at a time so
// a long session is never in memory whole. `end` is where a line starts.
async function tallyBefore(file: string, end: number): Promise<TurnTally> {
  const tally: TurnTally = { n: 0, open: false }
  if (end <= 0) return tally
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stop = Math.min(end, CAPS.tallyBytes)
    const chunk = Buffer.alloc(Math.min(stop, 1024 * 1024))
    let carry = Buffer.alloc(0)
    for (let at = 0; at < stop; ) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, stop - at), at)
      if (!bytesRead) break
      at += bytesRead
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead)
      const whole = data.lastIndexOf(10) + 1
      tallyTurns(parseLines(data.toString('utf8', 0, whole)), tally)
      carry = Buffer.from(data.subarray(whole))
    }
    return tally
  } finally {
    await handle.close()
  }
}

async function readRange(file: string, from: number, to: number): Promise<Buffer> {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const buf = Buffer.alloc(to - from)
    let read = 0
    while (read < buf.length) {
      const { bytesRead } = await handle.read(buf, read, buf.length - read, from + read)
      if (!bytesRead) break
      read += bytesRead
    }
    return buf.subarray(0, read)
  } finally {
    await handle.close()
  }
}

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
import { cwdOf, LIMITS, parseLines, titleOf, type Rec, type Subagent } from './transcript.ts'
import type { SessionInfo } from './protocol.ts'

export const CAPS = {
  transcriptBytes: 32 * 1024 * 1024, // the newest part of a session read
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
export async function readCapped(path: string, max: number, from: 'end' | 'start' = 'end'): Promise<{ text: string; complete: boolean; size: number }> {
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
    return { text, complete, size }
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
export async function readSubagents(root: string, dir: string, sessionId: string, wanted: ReadonlySet<string>): Promise<Subagent[]> {
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
  const out: Subagent[] = []
  for (const m of metas.slice(0, CAPS.subagents)) {
    try {
      const key = `${m.mtime}:${m.size}`
      const hit = agents.get(m.jsonl)
      if (hit?.key === key) {
        if (wanted.has(hit.agent.toolUseId)) out.push(hit.agent)
        continue
      }
      const meta: unknown = JSON.parse((await readCapped(m.meta, CAPS.metaBytes, 'start')).text)
      if (typeof meta !== 'object' || meta === null) continue
      const { toolUseId, agentType } = meta as Record<string, unknown>
      if (typeof toolUseId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(toolUseId) || !wanted.has(toolUseId)) continue
      const { text } = await readCapped(m.jsonl, CAPS.subagentBytes, 'end')
      const agent: Subagent = {
        toolUseId,
        agentType: typeof agentType === 'string' && /^[A-Za-z0-9_:.-]{1,60}$/.test(agentType) ? agentType : null,
        records: parseSidechain(text)
      }
      agents.delete(m.jsonl)
      agents.set(m.jsonl, { key, agent })
      if (agents.size > CAPS.subagents * 2) agents.delete(agents.keys().next().value!)
      out.push(agent)
    } catch {
      /* an unreadable subagent is left out */
    }
  }
  return out
}

// Subagent transcripts already read, by file, size and time.
const agents = new Map<string, { key: string; agent: Subagent }>()

// A subagent's lines are all marked sidechain: read them as its own main loop.
function parseSidechain(text: string): Rec[] {
  return parseLines(text, { sidechain: true }).slice(-LIMITS.records)
}

// ---------------------------------------------------------------- a growing transcript

type Cached = { file: string; ino: number; size: number; complete: boolean; records: Rec[] }

/**
 * Reads a session's records, keeping what it read: a file that only grew is
 * read from where it ended; anything else is read again from the start.
 */
export class TranscriptCache {
  private entry: Cached | null = null

  async read(file: string): Promise<{ records: Rec[]; complete: boolean }> {
    const st = await fs.lstat(file)
    if (st.isSymbolicLink() || !st.isFile()) throw new Error('not a file')
    const e = this.entry
    if (e && e.file === file && e.ino === st.ino && st.size >= e.size && st.size - e.size <= CAPS.transcriptBytes) {
      if (st.size > e.size) {
        const added = await readRange(file, e.size, st.size)
        // Only whole lines: a line still being written is read next time.
        const end = added.lastIndexOf('\n') + 1
        e.records.push(...parseLines(added.toString('utf8', 0, end)))
        if (e.records.length > LIMITS.records) e.records.splice(0, e.records.length - LIMITS.records)
        e.size += end
      }
      return { records: e.records, complete: e.complete }
    }
    const { text, complete, size } = await readCapped(file, CAPS.transcriptBytes, 'end')
    const whole = text.slice(0, text.lastIndexOf('\n') + 1)
    const records = parseLines(whole).slice(-LIMITS.records)
    const consumed = size - Buffer.byteLength(text.slice(whole.length), 'utf8')
    this.entry = { file, ino: st.ino, size: consumed, complete, records }
    return { records, complete }
  }

  clear(): void {
    this.entry = null
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

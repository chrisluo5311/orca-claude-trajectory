import { afterEach, assert, beforeEach, test } from 'orca/testing'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeHome, listSessions, projectDirName, readCapped, readSubagents, TranscriptCache, within } from './locate.ts'
import { LIMITS } from './transcript.ts'
import { assistant, attachment, basicSession, jsonl, prompt, toolUse } from './fixtures.ts'

const S1 = '11111111-1111-4111-8111-111111111111'
const S2 = '22222222-2222-4222-8222-222222222222'

let home: string
let root: string
const cwd = '/work/app'

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'traj-')))
  root = join(home, 'projects')
  mkdirSync(join(root, projectDirName(cwd)), { recursive: true })
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const dir = (): string => join(root, projectDirName(cwd))

test('names project folders as Claude Code does', () => {
  assert.equal(projectDirName('/Users/me/程式/my_app.v2'), '-Users-me----my-app-v2')
  assert.equal(claudeHome({ CLAUDE_CONFIG_DIR: '/opt/claude' }), '/opt/claude')
  // A relative value is ignored, not resolved against the worker's cwd.
  assert.ok(claudeHome({ CLAUDE_CONFIG_DIR: 'rel/dir' }).endsWith('.claude'))
  assert.ok(within('/a/b', '/a/b/c'))
  assert.ok(!within('/a/b', '/a/bc'))
})

test('lists sessions newest first, with their titles', async () => {
  writeFileSync(join(dir(), `${S1}.jsonl`), jsonl(basicSession()))
  writeFileSync(join(dir(), `${S2}.jsonl`), jsonl([prompt(0, 'hello')]))
  const { sessions } = await listSessions(home, cwd)
  assert.deepEqual(new Set(sessions.map((s) => s.id)), new Set([S1, S2]))
  assert.equal(sessions.find((s) => s.id === S1)?.title, 'Fix the parser')
  assert.equal(sessions.find((s) => s.id === S2)?.title, 'Untitled session')
})

test('leaves out sessions that ran somewhere else, links, and odd names', async () => {
  writeFileSync(join(dir(), `${S1}.jsonl`), jsonl([{ ...prompt(0, 'x'), cwd: '/work/app-other' }]))
  const outside = join(home, 'outside.jsonl')
  writeFileSync(outside, jsonl(basicSession()))
  symlinkSync(outside, join(dir(), `${S2}.jsonl`))
  writeFileSync(join(dir(), 'notes.jsonl'), jsonl(basicSession()))
  writeFileSync(join(dir(), `${S1}.jsonl.bak`), jsonl(basicSession()))
  const { sessions } = await listSessions(home, cwd)
  assert.deepEqual(sessions, [])
})

test('refuses a project folder that is a link out of the projects folder', async () => {
  rmSync(dir(), { recursive: true })
  const elsewhere = join(home, 'elsewhere')
  mkdirSync(elsewhere)
  writeFileSync(join(elsewhere, `${S1}.jsonl`), jsonl(basicSession()))
  symlinkSync(elsewhere, dir())
  const { sessions } = await listSessions(home, cwd)
  assert.deepEqual(sessions, [])
})

test('a relative workspace path finds nothing', async () => {
  const { sessions } = await listSessions(home, 'work/app')
  assert.deepEqual(sessions, [])
})

test('long working directories match by the cut name and their cwd', async () => {
  const long = `/work/${'x'.repeat(250)}`
  const name = `${projectDirName(long).slice(0, 200)}-abc123`
  mkdirSync(join(root, name))
  writeFileSync(join(root, name, `${S1}.jsonl`), jsonl([{ ...prompt(0, 'long'), cwd: long }]))
  const { sessions } = await listSessions(home, long)
  assert.equal(sessions.length, 1)
})

test('reads the end of a big file from a line start', async () => {
  const f = join(home, 'big.jsonl')
  writeFileSync(f, 'aaaa\nbbbb\ncccc\n')
  const r = await readCapped(f, 7)
  assert.equal(r.text, 'cccc\n')
  assert.equal(r.complete, false)
  const all = await readCapped(f, 1000)
  assert.ok(all.complete)
})

test('the cache reads only what a growing transcript added', async () => {
  const f = join(dir(), `${S1}.jsonl`)
  writeFileSync(f, jsonl(basicSession().slice(0, 3)))
  const cache = new TranscriptCache()
  const a = await cache.read(f)
  const before = a.records.length
  // Half a line: not read until it is whole.
  const line = JSON.stringify(assistant(5000, 'r7', [{ type: 'text', text: 'later' }]))
  appendFileSync(f, line.slice(0, 20))
  assert.equal((await cache.read(f)).records.length, before)
  appendFileSync(f, `${line.slice(20)}\n`)
  const b = await cache.read(f)
  assert.equal(b.records.length, before + 1)
  assert.ok(a.complete && b.complete)
  // Rewritten smaller: read again from the start.
  writeFileSync(f, jsonl([prompt(0, 'fresh')]))
  assert.equal((await cache.read(f)).records.length, 1)
})

test('reads subagents linked to wanted calls only', async () => {
  const sub = join(dir(), S1, 'subagents')
  mkdirSync(sub, { recursive: true })
  const lines = jsonl([{ ...assistant(10, 's1', [toolUse('toolu_x', 'Grep', { pattern: 'a' })]), isSidechain: true }])
  writeFileSync(join(sub, 'agent-a1.jsonl'), lines)
  writeFileSync(join(sub, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 'toolu_ag' }))
  writeFileSync(join(sub, 'agent-a2.jsonl'), lines)
  writeFileSync(join(sub, 'agent-a2.meta.json'), JSON.stringify({ agentType: 'Plan', toolUseId: 'toolu_other' }))
  writeFileSync(join(sub, 'agent-a3.jsonl'), lines)
  writeFileSync(join(sub, 'agent-a3.meta.json'), JSON.stringify({ agentType: '<b>x</b>', toolUseId: '../../x' }))
  const got = await readSubagents(realpathSync(root), realpathSync(dir()), S1, new Set(['toolu_ag', '../../x']))
  assert.equal(got.length, 1)
  assert.equal(got[0].agentType, 'Explore')
  assert.equal(got[0].records.length, 1)
  assert.deepEqual(await readSubagents(realpathSync(root), realpathSync(dir()), '../escape', new Set(['toolu_ag'])), [])
})

test('follows an agent a subagent started, however new its file', async () => {
  const sub = join(dir(), S1, 'subagents')
  mkdirSync(sub, { recursive: true })
  const write = (name: string, toolUseId: string, lines: unknown[]): void => {
    writeFileSync(join(sub, `agent-${name}.meta.json`), JSON.stringify({ agentType: 'Explore', toolUseId }))
    writeFileSync(join(sub, `agent-${name}.jsonl`), jsonl(lines))
  }
  write('top', 'toolu_top', [assistant(0, 'a', [toolUse('toolu_inner', 'Agent', { description: 'inner' })])])
  write('inner', 'toolu_inner', [assistant(1, 'b', [toolUse('toolu_read', 'Read', { file_path: '/a' })])])
  write('other', 'toolu_other_session', [assistant(2, 'c', [toolUse('toolu_x', 'Read', { file_path: '/b' })])])
  const got = await readSubagents(realpathSync(root), realpathSync(dir()), S1, new Set(['toolu_top']))
  assert.deepEqual(got.map((a) => a.toolUseId).sort(), ['toolu_inner', 'toolu_top'])
})

test('a session past the record cap no longer claims to start at its start', async () => {
  const was = LIMITS.records
  LIMITS.records = 3
  try {
    const file = join(dir(), `${S1}.jsonl`)
    writeFileSync(file, jsonl([prompt(0, 'a'), prompt(1, 'b')]))
    const cache = new TranscriptCache()
    assert.equal((await cache.read(file)).complete, true)
    appendFileSync(file, jsonl([prompt(2, 'c'), prompt(3, 'd')]))
    const grown = await cache.read(file)
    assert.equal(grown.records.length, 3)
    assert.equal(grown.complete, false)
    assert.equal((await new TranscriptCache().read(file)).complete, false)
  } finally {
    LIMITS.records = was
  }
})

test('context after the first reply is not kept', async () => {
  const file = join(dir(), `${S1}.jsonl`)
  const ctx = attachment('environment', 'on a mac')
  writeFileSync(file, jsonl([ctx, prompt(0, 'a'), assistant(5, 'r1', [{ type: 'text', text: 'ok' }]), ctx]))
  const cache = new TranscriptCache()
  assert.equal((await cache.read(file)).records.filter((r) => r.k === 'ctx').length, 1)
  appendFileSync(file, jsonl([ctx]))
  assert.equal((await cache.read(file)).records.filter((r) => r.k === 'ctx').length, 1)
})

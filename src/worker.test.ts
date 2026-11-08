import { afterEach, assert, beforeEach, mockHost, mountWorker, test, type TestWorker } from 'orca/testing'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as main from './worker.ts'
import { projectDirName } from './locate.ts'
import { basicSession, jsonl, prompt } from './fixtures.ts'
import type { TrajectoryAnswer } from './protocol.ts'

const S1 = '11111111-1111-4111-8111-111111111111'
const S2 = '22222222-2222-4222-8222-222222222222'

let home: string
let work: string
let worker: TestWorker | undefined
const saved = process.env.CLAUDE_CONFIG_DIR

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'traj-home-')))
  work = realpathSync(mkdtempSync(join(tmpdir(), 'traj-ws-')))
  process.env.CLAUDE_CONFIG_DIR = home
  const dir = join(home, 'projects', projectDirName(work))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${S1}.jsonl`), jsonl(basicSession().map((l) => ({ ...(l as object), cwd: work }))))
})
afterEach(async () => {
  await worker?.deactivate()
  worker = undefined
  rmSync(home, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = saved
})

function host(focused = true) {
  return mockHost({
    results: {
      'workspace.list': {
        workspaces: [
          { id: 'ws-1', kind: 'worktree', name: 'app', path: work, branch: 'refs/heads/main', hostId: 'local' },
          { id: 'ws-remote', kind: 'worktree', name: 'app', path: work, branch: 'main', hostId: 'ssh-box' }
        ],
        truncated: false
      },
      'workspace.readContext': focused ? { branch: 'main', displayName: 'app', terminals: [] } : null
    }
  })
}

test('answers the focused workspace’s newest session', async () => {
  worker = await mountWorker(main, { host: host() })
  const a = await worker.request('trajectory.get', {})
  assert.equal(a.workspaceId, 'ws-1')
  assert.deepEqual(a.workspaces.map((w) => w.id), ['ws-1'])
  assert.equal(a.sessionId, S1)
  assert.equal(a.data?.requests, 2)
  assert.equal(a.data?.turns[0].prompt, 'Read the parser and fix it')
  assert.deepEqual(worker.refusals, [])
})

test('ids that are not listed are ignored, never used as paths', async () => {
  worker = await mountWorker(main, { host: host() })
  for (const input of [
    { sessionId: '../../../../etc/passwd' },
    { sessionId: S2 },
    { workspaceId: '/etc' },
    { workspaceId: 'ws-remote' },
    { workspaceId: 42 as unknown as string, sessionId: { toString: () => S1 } as unknown as string }
  ]) {
    const a: TrajectoryAnswer = await worker.request('trajectory.get', input)
    assert.equal(a.workspaceId, 'ws-1', JSON.stringify(input))
    assert.equal(a.sessionId, S1, JSON.stringify(input))
  }
})

test('no focused workspace asks for one', async () => {
  worker = await mountWorker(main, { host: host(false) })
  const a = await worker.request('trajectory.get', {})
  assert.equal(a.workspaceId, null)
  assert.equal(a.data, null)
  assert.ok(a.notice)
})

test('a workspace with no sessions says so', async () => {
  rmSync(join(home, 'projects'), { recursive: true })
  mkdirSync(join(home, 'projects'))
  worker = await mountWorker(main, { host: host() })
  const a = await worker.request('trajectory.get', {})
  assert.equal(a.data, null)
  assert.equal(a.sessions.length, 0)
  assert.ok(a.notice)
})

test('picks a listed session by id', async () => {
  const dir = join(home, 'projects', projectDirName(work))
  writeFileSync(join(dir, `${S2}.jsonl`), jsonl([{ ...prompt(0, 'second'), cwd: work }]))
  worker = await mountWorker(main, { host: host() })
  const a = await worker.request('trajectory.get', { sessionId: S2 })
  assert.equal(a.sessionId, S2)
  assert.equal(a.data?.turns[0].prompt, 'second')
})

test('a huge answer is trimmed to fit, oldest first', async () => {
  const { fit } = await import('./worker.ts')
  const call = (i: number) => ({ id: `c${i}`, tool: 'Bash', summary: 'x'.repeat(80), at: 0, ms: 1, done: true, isError: false, by: null, input: Array.from({ length: 8 }, (_, k): [string, string] => [`k${k}`, 'v'.repeat(160)]), lines: ['l'.repeat(160), 'l'.repeat(160), 'l'.repeat(160)], chars: 1, tokens: 1, agentType: null, sub: [] })
  const step = (n: number) => ({ n, at: 0, firstAt: 0, endedAt: 1, status: 'done' as const, input: 1, output: 1, cacheRead: 0, text: 't'.repeat(200), stopReason: null, model: null, isCompacted: false, calls: Array.from({ length: 30 }, (_, i) => call(n * 100 + i)) })
  const a: TrajectoryAnswer = {
    workspaces: [], workspaceId: 'ws', sessions: [], sessionId: S1, notice: null,
    data: { turns: [{ n: 1, at: 0, prompt: 'p', chars: 1, tokens: 1, earlier: false, auto: null, steps: Array.from({ length: 60 }, (_, i) => step(i + 1)) }], overhead: null, fixed: null, fixedTrimmed: false, truncated: false, requests: 60, calls: 1800, tps: null, next: null }
  }
  const out = fit(a)
  assert.ok(JSON.stringify(out).length <= 384 * 1024)
  assert.ok(out.data!.truncated)
  assert.equal(out.data!.turns[0].steps.at(-1)!.n, 60)
})

test('the FIXED breakdown goes first, before any of the conversation', async () => {
  const { fit } = await import('./worker.ts')
  const a: TrajectoryAnswer = {
    workspaces: [], workspaceId: 'ws', sessions: [], sessionId: S1, notice: null,
    data: { turns: [{ n: 1, at: 0, prompt: 'p', chars: 1, tokens: 1, earlier: false, auto: null, steps: [] }, { n: 2, at: 1, prompt: 'q', chars: 1, tokens: 1, earlier: false, auto: null, steps: [] }], overhead: 9, fixed: [{ key: 'tools', name: 'x'.repeat(400 * 1024), note: null, tokens: 9 }], fixedTrimmed: false, truncated: false, requests: 0, calls: 0, tps: null, next: null }
  }
  const out = fit(a).data!
  assert.equal(out.fixed, null)
  assert.ok(out.fixedTrimmed)
  assert.equal(out.turns.length, 2)
  assert.equal(out.truncated, false)
})

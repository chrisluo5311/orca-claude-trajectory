// Transcript lines for the tests, shaped like Claude Code's.

export const T0 = Date.parse('2026-11-07T10:00:00.000Z')
export const iso = (ms: number): string => new Date(T0 + ms).toISOString()

export const prompt = (ms: number, text: string, extra: object = {}) => ({ type: 'user', timestamp: iso(ms), cwd: '/work/app', message: { role: 'user', content: text }, ...extra })
export const apiRequest = (ms: number, id: string, querySource = 'repl_main_thread') => ({ type: 'api-request', id, timestamp: iso(ms), querySource })
export const assistant = (
  ms: number,
  requestId: string,
  content: object[],
  usage: object | null = { input_tokens: 2, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
  stop: string | null = 'end_turn',
  ref?: string
) => ({
  type: 'assistant',
  timestamp: iso(ms),
  requestId,
  requestRef: ref,
  message: { id: `msg_${requestId}`, model: 'claude-opus-5-5', role: 'assistant', content, stop_reason: stop, usage }
})
export const toolUse = (id: string, name: string, input: object) => ({ type: 'tool_use', id, name, input })
export const toolResult = (ms: number, id: string, content: unknown, isError = false) => ({
  type: 'user',
  timestamp: iso(ms),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }
})
export const jsonl = (lines: unknown[]): string => lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'

/** A session: a prompt, a request that reads a file, a request that answers. */
export function basicSession(): unknown[] {
  return [
    { type: 'ai-title', aiTitle: 'Fix the parser', sessionId: 'x' },
    prompt(0, 'Read the parser and fix it'),
    apiRequest(100, 'req-a'),
    assistant(900, 'r1', [{ type: 'text', text: 'Reading it.' }], { input_tokens: 2, output_tokens: 50, cache_read_input_tokens: 20000, cache_creation_input_tokens: 0 }, null, 'req-a'),
    assistant(1000, 'r1', [toolUse('toolu_1', 'Read', { file_path: '/work/app/src/parser.ts' })], { input_tokens: 2, output_tokens: 80, cache_read_input_tokens: 20000, cache_creation_input_tokens: 0 }, 'tool_use', 'req-a'),
    toolResult(1400, 'toolu_1', 'line one\nline two\nline three\nline four'),
    apiRequest(1500, 'req-b'),
    assistant(3500, 'r2', [{ type: 'text', text: 'Fixed.' }], { input_tokens: 2, output_tokens: 300, cache_read_input_tokens: 20500, cache_creation_input_tokens: 0 }, 'end_turn', 'req-b')
  ]
}

export const requestShape = (hash: string, tools: object[] = []) => ({
  type: 'api-request-shape',
  shapeHash: hash,
  shape: { system: [{ type: 'text', text: 'SYSTEM-WORDS '.repeat(200) }], tools }
})
const toolDef = (name: string, words: number) => ({ name, description: 'TOOL-WORDS '.repeat(words), input_schema: { type: 'object' } })
export const attachment = (type: string, rendered: string, extra: object = {}) => ({
  type: 'attachment',
  timestamp: iso(1),
  attachment: { type, ...extra },
  rendered: [{ content: rendered }]
})

/** The basic session with the lines that say what its first request was made of. */
export function withShape(): unknown[] {
  const skills = `- long-skill: ${'SKILL-WORDS '.repeat(40)}\n- short:skill`
  const [title, firstPrompt, firstRequest, ...rest] = basicSession()
  return [
    title,
    requestShape('h1', [toolDef('Read', 20), toolDef('Bash', 90), toolDef('mcp__figma__use_figma', 60), toolDef('mcp__1a59c906-aaaa-bbbb-cccc-1234567890ab__batch', 10)]),
    attachment('skill_listing', skills, { content: skills, names: ['long-skill', 'short:skill'] }),
    attachment('mcp_instructions_delta', 'SERVER-WORDS '.repeat(30), { addedNames: ['figma'], addedBlocks: ['SERVER-WORDS '.repeat(30)] }),
    attachment('agent_listing_delta', '- Explore: looks around', { addedTypes: ['Explore'], addedLines: ['- Explore: looks around'] }),
    attachment('deferred_tools_delta', 'one\ntwo', { addedNames: ['one', 'two'] }),
    attachment('instructions', 'MEMORY-WORDS '.repeat(50), { files: [{ path: '/work/app/CLAUDE.md', type: 'Project', content: 'MEMORY-WORDS '.repeat(50) }] }),
    attachment('environment', 'on a mac'),
    firstPrompt,
    { ...(firstRequest as object), shapeHash: 'h1' },
    ...rest
  ]
}

// ---------------------------------------------------------------- the showcase

const tokens = (input: number, output: number) => ({ input_tokens: 4, output_tokens: output, cache_read_input_tokens: input - 4, cache_creation_input_tokens: 0 })

// One request: sent at `ms`, its text `wait` later, then its tool calls.
function request(ms: number, wait: number, id: string, text: string, tools: object[], input: number, output: number, shape?: string): unknown[] {
  const sent = { ...apiRequest(ms, `req-${id}`), ...(shape ? { shapeHash: shape } : {}) }
  const said = assistant(ms + wait, id, [{ type: 'text', text }], tokens(input, output), tools.length ? null : 'end_turn', `req-${id}`)
  return tools.length ? [sent, said, assistant(ms + wait + 400, id, tools, tokens(input, output), 'tool_use', `req-${id}`)] : [sent, said]
}

/**
 * A fuller session, for the panel's `showcase` scenario and the screenshots made from it:
 * two turns, a subagent, a failed call, and the lines that say what the first request carried.
 */
export function showcaseSession(): unknown[] {
  const skills = `- code-review: ${'SKILL-WORDS '.repeat(60)}\n- deploy-checklist: ${'SKILL-WORDS '.repeat(25)}\n- release-notes`
  const memory = 'MEMORY-WORDS '.repeat(220)
  return [
    { type: 'ai-title', aiTitle: 'Rate limit the public API', sessionId: 'x' },
    requestShape('s1', [
      toolDef('Bash', 260),
      toolDef('Agent', 210),
      toolDef('Edit', 120),
      toolDef('Read', 110),
      toolDef('Grep', 90),
      toolDef('Write', 70),
      toolDef('Glob', 40),
      toolDef('mcp__github__create_pull_request', 150),
      toolDef('mcp__github__list_issues', 80),
      toolDef('mcp__linear__create_issue', 70)
    ]),
    attachment('skill_listing', skills, { content: skills, names: ['code-review', 'deploy-checklist', 'release-notes'] }),
    attachment('mcp_instructions_delta', 'SERVER-WORDS '.repeat(90), { addedNames: ['github'], addedBlocks: ['SERVER-WORDS '.repeat(90)] }),
    attachment('agent_listing_delta', '- Explore: looks around\n- Plan: plans the work', { addedTypes: ['Explore', 'Plan'], addedLines: ['- Explore: looks around', '- Plan: plans the work'] }),
    attachment('deferred_tools_delta', 'WebSearch\nNotebookEdit', { addedNames: ['WebSearch', 'NotebookEdit'] }),
    attachment('instructions', memory, { files: [{ path: '/work/app/CLAUDE.md', type: 'Project', content: memory }] }),

    prompt(0, 'Add rate limiting to the public API'),
    ...request(200, 2600, 'r1', 'I’ll look at how requests reach the router.', [toolUse('toolu_grep', 'Grep', { pattern: 'app.use', path: 'src/' })], 21_400, 96, 's1'),
    toolResult(3_500, 'toolu_grep', 'src/server.ts:14:app.use(json())\nsrc/server.ts:15:app.use(auth)\nsrc/server.ts:22:app.use(\'/api\', router)'),
    ...request(3_700, 3100, 'r2', 'Two places need limits. I’ll check the middleware that is already there.', [toolUse('toolu_explore', 'Agent', { description: 'Find existing middleware', subagent_type: 'Explore', prompt: 'List the middleware under src/middleware and how the router mounts it.' })], 21_680, 148),
    toolResult(25_200, 'toolu_explore', 'Three middleware: auth, json and cors. The router mounts them in src/server.ts.\nNone of them counts requests.'),
    ...request(25_400, 4200, 'r3', 'Now the limiter, with a sliding window per API key.', [
      toolUse('toolu_write', 'Write', { file_path: '/work/app/src/middleware/limiter.ts', content: 'export function limiter(max: number, windowMs: number) { /* … */ }' }),
      toolUse('toolu_edit', 'Edit', { file_path: '/work/app/src/server.ts', old_string: "app.use('/api', router)", new_string: "app.use('/api', limiter(100, 60_000), router)" })
    ], 23_150, 1_240),
    toolResult(31_000, 'toolu_write', 'File created: src/middleware/limiter.ts'),
    toolResult(31_300, 'toolu_edit', 'The file src/server.ts has been updated.'),
    ...request(31_500, 1900, 'r4', 'Running the tests.', [toolUse('toolu_test', 'Bash', { command: 'npm test', description: 'Run the unit tests' })], 24_520, 64),
    toolResult(44_300, 'toolu_test', 'FAIL src/server.test.ts\n  expected header x-ratelimit-remaining to be undefined\nTests: 1 failed, 41 passed', true),
    ...request(44_500, 2800, 'r5', 'One test still expects no rate-limit header. I’ll bring it up to date and run them again.', [
      toolUse('toolu_fix', 'Edit', { file_path: '/work/app/src/server.test.ts', old_string: 'toBeUndefined()', new_string: "toBe('99')" }),
      toolUse('toolu_retest', 'Bash', { command: 'npm test', description: 'Run the unit tests' })
    ], 24_910, 312),
    toolResult(48_100, 'toolu_fix', 'The file src/server.test.ts has been updated.'),
    toolResult(60_400, 'toolu_retest', 'Tests: 42 passed\nTime: 11.8s'),
    ...request(60_600, 2400, 'r6', 'Rate limiting is in: 100 requests a minute per API key, with the remaining count in a header.', [], 25_430, 268),

    prompt(95_000, 'Make the limit configurable per route'),
    ...request(95_200, 2300, 'r7', 'The limiter already takes its numbers as arguments, so each route can pass its own.', [
      toolUse('toolu_read', 'Read', { file_path: '/work/app/src/routes/index.ts' }),
      toolUse('toolu_routes', 'Edit', { file_path: '/work/app/src/routes/index.ts', old_string: "router.post('/upload', upload)", new_string: "router.post('/upload', limiter(10, 60_000), upload)" })
    ], 25_760, 540),
    toolResult(98_300, 'toolu_read', "import { Router } from 'express'\nexport const router = Router()\nrouter.post('/upload', upload)"),
    toolResult(98_700, 'toolu_routes', 'The file src/routes/index.ts has been updated.'),
    ...request(98_900, 2100, 'r8', 'Uploads now allow 10 a minute; every other route keeps the default of 100.', [], 26_480, 184)
  ]
}

/** What the showcase's Explore subagent did, as its own transcript's lines. */
export function showcaseSubagent(): unknown[] {
  return [
    assistant(7_600, 'e1', [toolUse('toolu_e1', 'Glob', { pattern: 'src/middleware/**' })], undefined, 'tool_use'),
    toolResult(7_900, 'toolu_e1', 'src/middleware/auth.ts\nsrc/middleware/cors.ts'),
    assistant(9_400, 'e2', [toolUse('toolu_e2', 'Read', { file_path: '/work/app/src/middleware/auth.ts' })], undefined, 'tool_use'),
    toolResult(9_700, 'toolu_e2', 'export function auth() {}'),
    assistant(12_800, 'e3', [toolUse('toolu_e3', 'Grep', { pattern: 'rateLimit|throttle' })], undefined, 'tool_use'),
    toolResult(13_500, 'toolu_e3', 'No matches found'),
    assistant(16_900, 'e4', [toolUse('toolu_e4', 'Read', { file_path: '/work/app/src/server.ts' })], undefined, 'tool_use'),
    toolResult(17_300, 'toolu_e4', 'app.use(json())')
  ]
}

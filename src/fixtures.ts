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

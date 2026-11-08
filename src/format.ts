// Figures as the panel writes them, and the trajectory as plain text for Export.

import type { Step, Trajectory } from './protocol.ts'

/** "6.2k", "182", "1.4M": a token count with no unit. */
export function kTok(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return ''
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** "120ms", "1.8s", "41s", "1:12". */
export function took(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  if (s < 3600) return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

/** "2026-11-07 23:41:04.504", in local time. */
export function stamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
export const stepMs = (s: Step, now: number): number => (s.endedAt ?? now) - s.at
export const isAgentTool = (tool: string): boolean => tool === 'Agent' || tool === 'Task'

/**
 * The trajectory as plain text: each turn and request with its figures, and
 * the calls by tool and what they were about. No prompt, reply, input or
 * result text: those stay in the panel.
 */
export function trajectoryText(t: Trajectory, now = Date.now()): string {
  const out = [`Trajectory · ${plural(t.requests, 'request')} to Claude · ${plural(t.calls, 'tool call')}`]
  if (t.overhead != null) out.push(`Fixed overhead ≈${kTok(t.overhead)} tokens, sent with every request`)
  if (t.truncated) out.push('(the oldest part of the session is left out)')
  for (const turn of t.turns) {
    out.push('', `${turn.earlier ? 'Earlier' : `Turn ${turn.n}`} · ${plural(turn.steps.length, 'request')}`)
    for (const s of turn.steps) {
      if (s.isCompacted) out.push('  Context compacted')
      const figures = s.status === 'streaming' ? 'under way' : `${kTok(s.input) || '–'} in · ${kTok(s.output) || '–'} out`
      out.push(`  #${s.n}  ${figures} · ${took(stepMs(s, now))}`)
      for (const c of s.calls) {
        out.push(`    ${c.tool}${c.summary ? ` ${c.summary}` : ''}${c.isError ? ' ✗' : ''} · ${kTok(c.tokens) || '–'} · ${c.done ? took(c.ms) : 'running'}`)
        for (const sc of c.sub) out.push(`      ${sc.tool}${sc.summary ? ` ${sc.summary}` : ''}${sc.isError ? ' ✗' : ''} · ${sc.done ? took(sc.ms) : 'running'}`)
      }
    }
  }
  const tail = [t.tps ? `${t.tps} tok/s end to end` : null, t.next != null ? `the next request sends ≥${kTok(t.next)}` : null].filter(Boolean)
  if (tail.length) out.push('', tail.join(' · '))
  return out.join('\n').trimEnd()
}

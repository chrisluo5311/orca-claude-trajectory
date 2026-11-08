// Everything the panel shows from a transcript goes through here first. A
// transcript is untrusted text: prompts, replies, tool inputs and outputs can
// hold secrets, terminal escapes, or bidi controls that make text read
// differently than it is. Previews are cut short, flattened to one line,
// stripped of control characters, and hidden whole when they look secret.

export const HIDDEN = '(hidden: looks secret)'

// Things that should never be drawn. Each match names what it looks like.
// Every repeat next to another is bounded, so a hostile line cannot make a
// pattern backtrack for long (each is run on up to 8000 characters).
const SECRETS: readonly (readonly [RegExp, string])[] = [
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/, 'an API key'],
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/, 'a Stripe key'],
  [/\bsb_secret_[A-Za-z0-9_-]{10,}/, 'a Supabase secret key'],
  [/\b(?:ghp|gho|ghs|ghu|ghr|github_pat)_[A-Za-z0-9_]{20,}/, 'a GitHub token'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/, 'a GitLab token'],
  [/\bnpm_[A-Za-z0-9]{36}\b/, 'an npm token'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'a Google API key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'a JWT'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s/:@]{1,256}:[^\s/@]{3,256}@/i, 'a password in a URL'],
  [/\b(?:authorization|bearer)\b["']?[ \t]{0,4}[:=]?[ \t]{0,4}["']?(?:bearer[ \t]{1,4})?[A-Za-z0-9._~+/-]{20,}/i, 'a bearer token'],
  [
    /(?:^|[\s;&|'"])(?:export[ \t]{1,4})?[A-Za-z_][A-Za-z0-9_]{0,64}(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY)[A-Za-z0-9_]{0,64}[ \t]{0,4}[=:][ \t]{0,4}["']?[^\s"']{8,}/i,
    'a secret assignment'
  ]
]

/** What a text looks like it holds (e.g. "an API key"), or null. */
export function findSecret(text: string): string | null {
  for (const [pattern, what] of SECRETS) if (pattern.test(text)) return what
  return null
}

// C0/C1 controls (escape sequences among them), and the bidi and invisible
// formatting characters used to make code or text read as something else.
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g
const FORMATTING = /[؜​-‏‪-‮⁠-⁤⁦-⁩﻿]/g

/** Text with control and bidi characters removed; newlines and tabs kept. */
export function stripControls(text: string): string {
  return text.replace(CONTROLS, '').replace(FORMATTING, '')
}

/** At most `n` characters, never ending on half of a surrogate pair. */
export function cut(text: string, n: number): string {
  if (text.length <= n) return text
  let s = text.slice(0, Math.max(0, n - 1))
  const last = s.charCodeAt(s.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1)
  return `${s}…`
}

/** A text's first `n` characters on one line, cleaned, or HIDDEN when it looks secret. */
export function preview(value: unknown, n = 200): string {
  if (typeof value !== 'string' || !value) return ''
  // Look at a bounded window: enough to judge, never the whole of a huge string.
  const raw = value.length > 8000 ? value.slice(0, 8000) : value
  const s = stripControls(raw).replace(/\s+/g, ' ').trim()
  if (!s) return ''
  if (findSecret(s)) return HIDDEN
  return cut(s, n)
}

/** A text's first non-blank lines, each cleaned and cut, or [HIDDEN] when any looks secret. */
export function firstLines(value: unknown, lines = 3, width = 160): string[] {
  if (typeof value !== 'string' || !value.trim()) return []
  const head = value.length > 8000 ? value.slice(0, 8000) : value
  if (findSecret(head)) return [HIDDEN]
  const out: string[] = []
  for (const line of head.split('\n')) {
    const l = stripControls(line).replace(/\t/g, '  ').replace(/\s+$/, '')
    if (!l.trim()) continue
    out.push(cut(l, width))
    if (out.length >= lines) break
  }
  return out
}

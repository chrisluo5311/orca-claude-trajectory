# Security Policy

Claude Trajectory reads Claude Code transcripts, which can hold prompts, code, command output and secrets, so security reports are very welcome.

## Reporting a vulnerability

**Please don't open a public issue for a security problem.** Report it privately instead:

1. Go to the Security tab of this repository.
2. Click **Report a vulnerability**.
3. Describe the problem, how to reproduce it, and what an attacker could do with it.

Only the maintainer can see the report. You'll get a reply within 7 days. Once a fix is released, the advisory is published with credit to you, unless you'd rather stay anonymous.

## Supported versions

Only the latest release gets security fixes.

## What's in scope

- **Reading outside Claude Code's transcripts.** Any way the worker can be made to open a file other than a session or subagent transcript under the Claude Code projects folder (path traversal, symbolic links, crafted ids or workspace paths).
- **Writing, running or sending.** Any way the plugin writes a file, runs a command, or sends data over the network.
- **Secrets reaching the panel or the export.** A common credential format that the masking in `src/redact.ts` misses, or a path where transcript text reaches the panel without going through it.
- **Injection into the panel.** Transcript content that changes what the panel draws beyond text: controls, links, layout, or spoofed text through control or bidi characters.
- **Denial of service.** A transcript that makes the worker or Orca hang, use unbounded memory, or crash.

## Out of scope

- What another program or user with write access to your `~/.claude` folder can do: they already have your transcripts.
- Secrets in a form no reasonable pattern can tell from ordinary text. Masking is a best effort.
- Vulnerabilities in Orca or Claude Code themselves: report those to their projects.

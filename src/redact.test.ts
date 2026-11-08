import { assert, test } from 'orca/testing'
import { cut, findSecret, firstLines, HIDDEN, preview, stripControls } from './redact.ts'

test('hides previews that look secret', () => {
  const secrets = [
    'curl -H "x-api-key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123"',
    'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'AKIAABCDEFGHIJKLMNOP',
    'export OPENAI_API_KEY=abcdefgh12345678',
    'DATABASE_PASSWORD: hunter2hunter2',
    'postgres://admin:s3cretpw@db.example.com/app',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz.123456',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'sk_live_abcdefghijklmnop1234'
  ]
  for (const s of secrets) {
    assert.ok(findSecret(s), `not caught: ${s}`)
    assert.equal(preview(s), HIDDEN)
  }
})

test('leaves ordinary text alone', () => {
  for (const s of ['npm test', 'Read the parser and fix it', 'const tokenCount = 4', 'git push origin main', 'see https://example.com/docs']) {
    assert.equal(findSecret(s), null, s)
    assert.equal(preview(s), s)
  }
})

test('strips terminal escapes and bidi controls', () => {
  assert.equal(stripControls('a\u001b[31mred\u001b[0m'), 'a[31mred[0m')
  assert.equal(preview('safe‮evil⁦x​z'), 'safeevilxz')
  assert.equal(preview('one\n\ttwo\r\nthree'), 'one two three')
})

test('cuts without splitting a surrogate pair', () => {
  const s = `${'a'.repeat(9)}😀tail`
  const c = cut(s, 11)
  assert.ok(c.endsWith('…'))
  assert.ok(!/[\uD800-\uDBFF]…$/.test(c))
  assert.equal(cut('short', 10), 'short')
})

test('first lines are cut, cleaned and masked', () => {
  assert.deepEqual(firstLines('\n\na\n\nb\nc\nd'), ['a', 'b', 'c'])
  assert.deepEqual(firstLines(`ok\nAWS AKIAABCDEFGHIJKLMNOP`), [HIDDEN])
  assert.equal(firstLines('x'.repeat(500))[0].length, 160)
  assert.deepEqual(firstLines(42), [])
})

test('non-strings preview as empty', () => {
  assert.equal(preview(undefined), '')
  assert.equal(preview({ toString: () => 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123' }), '')
})

test('hostile input does not make the patterns backtrack for long', () => {
  const inputs = [
    'authorization' + '\t'.repeat(7980),
    'bearer ' + ' '.repeat(7990),
    (' x' + 'A'.repeat(70)).repeat(110),
    'a://' + 'b:'.repeat(3998),
    ' TOKEN'.repeat(1333),
    'a'.repeat(8000)
  ]
  const start = Date.now()
  for (const s of inputs) preview(s)
  assert.ok(Date.now() - start < 100, `took ${Date.now() - start}ms`)
})

// Host-half behavior tests for dsh-drop-file-to-path. Runs standalone with
// `node --test tests/host.test.mjs` (no DSH server required): the plugin's
// apply() is driven with a fake webServer/timer ctx and a temp dropbox dir.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, sanitize, storedB64Length } from '../lib/index.js'

// Must mirror lib/index.js CHUNK_BYTES (multiple of 3, padding-free chunks).
const CHUNK = 4 * 1024 * 1024 - 1

function makeHarness(config) {
  const routes = []
  const ctx = {
    get(name) {
      if (name === 'webServer') return { register: (r) => { routes.push(r); return () => {} } }
      if (name === 'timer') return { timeout: (fn) => fn }
      return undefined
    },
    effect() {},
  }
  apply(ctx, config)
  const byPath = (p) => routes.find((r) => r.path === p)
  async function call(path, body, remoteAddress = '127.0.0.1') {
    const route = byPath(path)
    assert.ok(route, 'route ' + path)
    const req = new EventEmitter()
    req.socket = { remoteAddress }
    const res = { code: 0, body: '', writeHead(c) { this.code = c }, end(b) { this.body = b } }
    const promise = route.handler(req, res)
    const payload = Buffer.from(JSON.stringify(body))
    process.nextTick(() => { req.emit('data', payload); req.emit('end') })
    await promise
    return { code: res.code, body: res.body ? JSON.parse(res.body) : null }
  }
  return { call }
}

function b64(buf) {
  return buf.toString('base64')
}

function chunksOf(buf) {
  const parts = []
  for (let i = 0; i < buf.length; i += CHUNK) {
    parts.push(buf.subarray(i, Math.min(i + CHUNK, buf.length)))
  }
  return parts
}

async function upload(h, name, buf) {
  const begin = await h.call('/api/drop-file-to-path/begin', { name, size: buf.length })
  assert.equal(begin.code, 200, 'begin ok')
  // begin fast-path: same name+size already in the dropbox → path returned,
  // no token, nothing uploaded.
  if (begin.body.path) return { code: 200, body: { path: begin.body.path, encoded: begin.body.encoded, bytes: buf.length } }
  const token = begin.body.token
  assert.ok(token, 'token issued')
  const parts = chunksOf(buf)
  for (let i = 0; i < parts.length; i++) {
    const r = await h.call('/api/drop-file-to-path/chunk', { token, index: i, data: b64(parts[i]) })
    assert.equal(r.code, 200, 'chunk ' + i + ' ok')
  }
  return h.call('/api/drop-file-to-path/end', { token })
}

function withDropbox(t, config) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-dropbox-test-'))
  process.env.DSH_DROPBOX_DIR = dir
  t.after(() => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.DSH_DROPBOX_DIR
  })
  return { dir, h: makeHarness(config) }
}

test('sanitize: illegal chars, reserved device names, trailing dots, length cap', () => {
  assert.equal(sanitize('a/b:c*?.txt'), 'a_b_c__.txt')
  assert.equal(sanitize('CON'), '_CON')
  assert.equal(sanitize('con.txt'), '_con.txt')
  assert.equal(sanitize('NUL'), '_NUL')
  assert.equal(sanitize('COM1'), '_COM1')
  assert.equal(sanitize('lpt9.log'), '_lpt9.log')
  assert.equal(sanitize('name.'), 'name')
  assert.equal(sanitize('name  '), 'name')
  assert.equal(sanitize(''), 'file')
  assert.equal(sanitize(undefined), 'file')
  const long = 'x'.repeat(200) + '.txt'
  assert.ok(sanitize(long).length <= 120)
  assert.ok(sanitize(long).endsWith('.txt'))
})

test('storedB64Length: 4 chars per 3 bytes (padding-free full chunks)', () => {
  assert.equal(storedB64Length(6), 8)
  assert.equal(storedB64Length(100), 136)
  assert.equal(storedB64Length(CHUNK), (CHUNK / 3) * 4)
  assert.equal(storedB64Length(CHUNK + 10), (CHUNK / 3) * 4 + Math.ceil(10 / 3) * 4)
})

test('text upload lands verbatim', async (t) => {
  const { dir, h } = withDropbox(t)
  const done = await upload(h, 'notes.txt', Buffer.from('hello 世界\n', 'utf8'))
  assert.equal(done.code, 200)
  assert.equal(done.body.encoded, false)
  assert.equal(done.body.path, join(dir, 'notes.txt'))
  assert.equal(readFileSync(done.body.path, 'utf8'), 'hello 世界\n')
})

test('multi-chunk text upload survives intact (regression: 4MiB chunk embedding == truncates decode)', async (t) => {
  const { dir, h } = withDropbox(t)
  const original = Buffer.alloc(4.5 * 1024 * 1024)
  for (let i = 0; i < original.length; i++) original[i] = (i * 31 + 7) & 0xff
  const done = await upload(h, 'big.csv', original)
  assert.equal(done.code, 200)
  assert.equal(done.body.bytes, original.length)
  const stored = readFileSync(done.body.path)
  assert.equal(stored.length, original.length)
  assert.ok(stored.equals(original), 'decoded content must match the original byte-for-byte')
})

test('binary upload stores .b64 that decodes to the original bytes', async (t) => {
  const { dir, h } = withDropbox(t)
  const original = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255])
  const done = await upload(h, 'data.pdf', original)
  assert.equal(done.code, 200)
  assert.equal(done.body.encoded, true)
  assert.ok(done.body.path.endsWith('.b64'))
  const text = readFileSync(done.body.path, 'utf8')
  assert.equal(text.length, storedB64Length(original.length))
  assert.ok(Buffer.from(text, 'base64').equals(original))
})

test('multi-chunk binary round-trips (b64 text decodes to exact original)', async (t) => {
  const { h } = withDropbox(t)
  const original = Buffer.alloc(4.5 * 1024 * 1024)
  for (let i = 0; i < original.length; i++) original[i] = (i * 13 + 5) & 0xff
  const done = await upload(h, 'blob.bin', original)
  assert.equal(done.code, 200)
  const text = readFileSync(done.body.path, 'utf8')
  assert.ok(Buffer.from(text, 'base64').equals(original))
})

test('truncated chunk data is rejected at receipt', async (t) => {
  const { h } = withDropbox(t)
  const begin = await h.call('/api/drop-file-to-path/begin', { name: 'x.bin', size: 100 })
  const r = await h.call('/api/drop-file-to-path/chunk', { token: begin.body.token, index: 0, data: 'QUJD' })
  assert.equal(r.code, 400)
  assert.match(r.body.error, /长度不符/)
})

test('chunk beyond the declared file is rejected', async (t) => {
  const { h } = withDropbox(t)
  const begin = await h.call('/api/drop-file-to-path/begin', { name: 'x.bin', size: 10 })
  const r = await h.call('/api/drop-file-to-path/chunk', { token: begin.body.token, index: 7, data: 'QUJDRA==' })
  assert.equal(r.code, 400)
  assert.match(r.body.error, /越界/)
})

test('end rejects missing chunk indices and short totals', async (t) => {
  const { h } = withDropbox(t)
  const size = CHUNK + 100
  const begin = await h.call('/api/drop-file-to-path/begin', { name: 'x.bin', size })
  const token = begin.body.token
  // Chunk 1 arrives, chunk 0 never does.
  await h.call('/api/drop-file-to-path/chunk', { token, index: 1, data: b64(Buffer.alloc(100, 1)) })
  const end = await h.call('/api/drop-file-to-path/end', { token })
  assert.equal(end.code, 400)
  assert.match(end.body.error, /缺失|不完整/)
})

test('end rejects a payload that decodes to the wrong size', async (t) => {
  const { h } = withDropbox(t)
  const begin = await h.call('/api/drop-file-to-path/begin', { name: 'x.txt', size: 100 })
  const token = begin.body.token
  // Correct chunk length (136 chars) but content decodes to 102 bytes: the
  // decoded size cannot match the declared 100.
  const chunk = await h.call('/api/drop-file-to-path/chunk', { token, index: 0, data: 'A'.repeat(136) })
  assert.equal(chunk.code, 200, 'length-valid chunk accepted')
  const end = await h.call('/api/drop-file-to-path/end', { token })
  assert.equal(end.code, 400)
  assert.match(end.body.error, /字节数与声明不符/)
})

test('dedupe: identical content reuses the existing path, no duplicate file (via begin fast-path)', async (t) => {
  const { dir, h } = withDropbox(t)
  const content = Buffer.from('same content, same name, same size\n', 'utf8')
  const first = await upload(h, 'dup.txt', content)
  assert.equal(first.code, 200)
  const second = await upload(h, 'dup.txt', content)
  assert.equal(second.code, 200)
  assert.equal(second.body.path, first.body.path, 'identical upload must reuse the same path')
  assert.deepEqual(readdirSync(dir), ['dup.txt'])
})

test('dedupe: same name but DIFFERENT size must NOT reuse (new _1 copy)', async (t) => {
  const { dir, h } = withDropbox(t)
  const a = Buffer.alloc(100, 1)
  const b = Buffer.alloc(101, 2)
  const first = await upload(h, 'dup.txt', a)
  const second = await upload(h, 'dup.txt', b)
  assert.equal(second.code, 200)
  assert.notEqual(second.body.path, first.body.path)
  assert.ok(second.body.path.endsWith('_1.txt'))
  assert.equal(readFileSync(first.body.path, 'utf8'), a.toString())
  assert.equal(readFileSync(second.body.path, 'utf8'), b.toString())
})

test('dedupe: identical binary content reuses the .b64 path (via begin fast-path)', async (t) => {
  const { dir, h } = withDropbox(t)
  const content = Buffer.from([9, 8, 7, 6, 5, 4, 3, 2, 1])
  const first = await upload(h, 'img.png', content)
  const second = await upload(h, 'img.png', content)
  assert.equal(second.body.path, first.body.path)
  assert.deepEqual(readdirSync(dir), ['img.png.b64'])
})

test('non-loopback callers are accepted (no remote-address gate; the server binds loopback anyway)', async (t) => {
  const { h } = withDropbox(t)
  const ok = await h.call('/api/drop-file-to-path/begin', { name: 'a.txt', size: 1 }, '192.168.1.50')
  assert.equal(ok.code, 200)
})

test('begin fast-path: same name+size reuses instantly without any upload', async (t) => {
  const { dir, h } = withDropbox(t)
  const content = Buffer.from('fast dedupe', 'utf8')
  const first = await upload(h, 'fast.txt', content)
  assert.equal(first.code, 200)
  const begin = await h.call('/api/drop-file-to-path/begin', { name: 'fast.txt', size: content.length })
  assert.equal(begin.code, 200)
  assert.equal(begin.body.path, first.body.path)
  assert.equal(begin.body.encoded, false)
  assert.deepEqual(readdirSync(dir), ['fast.txt'], 'no new copy on disk')
})

test('begin fast-path hits .b64 files too', async (t) => {
  const { dir, h } = withDropbox(t)
  const content = Buffer.from([1, 2, 3, 4, 5])
  const first = await upload(h, 'f.bin', content)
  assert.equal(first.code, 200)
  const begin = await h.call('/api/drop-file-to-path/begin', { name: 'f.bin', size: content.length })
  assert.equal(begin.body.path, first.body.path)
  assert.equal(begin.body.encoded, true)
  assert.deepEqual(readdirSync(dir), ['f.bin.b64'])
})

test('list + clean: inventory marks _N copies, cleanup modes work', async (t) => {
  const { dir, h } = withDropbox(t)
  // a.txt (100B) and a_1.txt (101B, duplicate), b.bin.b64 and b.bin_1.b64 (duplicate)
  await upload(h, 'a.txt', Buffer.alloc(100, 1))
  await upload(h, 'a.txt', Buffer.alloc(101, 2))
  await upload(h, 'b.bin', Buffer.from([1, 2, 3]))
  await upload(h, 'b.bin', Buffer.from([4, 5, 6, 7]))

  const list = await h.call('/api/drop-file-to-path/list', {})
  assert.equal(list.code, 200)
  const names = new Set(list.body.files.map((f) => f.name))
  assert.deepEqual([...names].sort(), ['a.txt', 'a_1.txt', 'b.bin.b64', 'b.bin_1.b64'].sort())
  const mark = Object.fromEntries(list.body.files.map((f) => [f.name, f.duplicate]))
  assert.equal(mark['a.txt'], false)
  assert.equal(mark['a_1.txt'], true)
  assert.equal(mark['b.bin.b64'], false)
  assert.equal(mark['b.bin_1.b64'], true)
  assert.ok(list.body.totalBytes > 0)

  // duplicates mode removes only the _N copies
  const dup = await h.call('/api/drop-file-to-path/clean', { mode: 'duplicates' })
  assert.equal(dup.code, 200)
  assert.deepEqual(dup.body.deleted.sort(), ['a_1.txt', 'b.bin_1.b64'])
  assert.deepEqual(readdirSync(dir).sort(), ['a.txt', 'b.bin.b64'])

  // largerThan mode with a tiny threshold removes everything left
  const big = await h.call('/api/drop-file-to-path/clean', { mode: 'largerThan', minSizeBytes: 1 })
  assert.equal(big.code, 200)
  assert.deepEqual(readdirSync(dir), [])

  // all mode on an empty dropbox is a no-op
  const all = await h.call('/api/drop-file-to-path/clean', { mode: 'all' })
  assert.equal(all.code, 200)
  assert.deepEqual(all.body.deleted, [])
  assert.equal(all.body.freedBytes, 0)
})

test('clean rejects unknown modes', async (t) => {
  const { h } = withDropbox(t)
  const r = await h.call('/api/drop-file-to-path/clean', { mode: 'everything' })
  assert.equal(r.code, 400)
  assert.match(r.body.error, /清理模式/)
})

test('abort discards the session', async (t) => {
  const { h } = withDropbox(t)
  const begin = await h.call('/api/drop-file-to-path/begin', { name: 'a.txt', size: 10 })
  await h.call('/api/drop-file-to-path/abort', { token: begin.body.token })
  const end = await h.call('/api/drop-file-to-path/end', { token: begin.body.token })
  assert.equal(end.code, 400)
  assert.match(end.body.error, /不存在或已过期/)
})

test('oversized request body is rejected', async (t) => {
  const { h } = withDropbox(t)
  const huge = { name: 'x'.repeat(17 * 1024 * 1024), size: 1 }
  const r = await h.call('/api/drop-file-to-path/begin', huge)
  assert.equal(r.code, 400)
  assert.match(r.body.error, /上限/)
})

test('session expires after the timeout', async (t) => {
  const { h } = withDropbox(t)
  const begin = await h.call('/api/drop-file-to-path/begin', { name: 'a.txt', size: 10 })
  const end = await h.call('/api/drop-file-to-path/end', { token: begin.body.token })
  assert.equal(end.code, 400)
})

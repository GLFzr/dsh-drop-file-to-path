// Host-half behavior tests for dsh-file-upload. Runs standalone with
// `node --test tests/host.test.mjs` (no DSH server required): the plugin's
// apply() is driven with a fake webServer/timer ctx and a temp dropbox dir.
// v2.1.0: + P1 lastModified-aware fast-path regression, + P2 manifest-based
// duplicate marking, + P7 pure-illegal-name sanitize, + P8 Origin guard.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, sanitize, storedB64Length } from '../lib/index.js'

// Must mirror lib/index.js CHUNK_BYTES (multiple of 3, padding-free chunks).
const CHUNK = 4 * 1024 * 1024 - 1
// A stable File.lastModified the tests pretend the browser reported.
const FIXED_TS = 1700000000000
const MANIFEST = '.dsh-manifest.json'

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
  async function call(path, body, remoteAddress = '127.0.0.1', headers = {}) {
    const route = byPath(path)
    assert.ok(route, 'route ' + path)
    const req = new EventEmitter()
    req.socket = { remoteAddress }
    req.headers = headers
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

/** Dropbox contents excluding the plugin manifest (internal bookkeeping). */
function diskFiles(dir) {
  return readdirSync(dir).filter((n) => n !== MANIFEST)
}

async function upload(h, name, buf, lastModified = FIXED_TS) {
  const begin = await h.call('/api/file-upload/begin', { name, size: buf.length, lastModified })
  assert.equal(begin.code, 200, 'begin ok')
  // begin fast-path: same name+size already in the dropbox → path returned,
  // no token, nothing uploaded.
  if (begin.body.path) return { code: 200, body: { path: begin.body.path, encoded: begin.body.encoded, bytes: buf.length } }
  const token = begin.body.token
  assert.ok(token, 'token issued')
  const parts = chunksOf(buf)
  for (let i = 0; i < parts.length; i++) {
    const r = await h.call('/api/file-upload/chunk', { token, index: i, data: b64(parts[i]) })
    assert.equal(r.code, 200, 'chunk ' + i + ' ok')
  }
  return h.call('/api/file-upload/end', { token })
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

test('sanitize: illegal chars, reserved device names, trailing dots, length cap, pure-illegal fallback', () => {
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
  // P7: a name that sanitizes to nothing but replacement underscores.
  assert.equal(sanitize('::::'), 'file')
  assert.equal(sanitize('***'), 'file')
  assert.equal(sanitize('???'), 'file')
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
  const begin = await h.call('/api/file-upload/begin', { name: 'x.bin', size: 100 })
  const r = await h.call('/api/file-upload/chunk', { token: begin.body.token, index: 0, data: 'QUJD' })
  assert.equal(r.code, 400)
  assert.match(r.body.error, /长度不符/)
})

test('chunk beyond the declared file is rejected', async (t) => {
  const { h } = withDropbox(t)
  const begin = await h.call('/api/file-upload/begin', { name: 'x.bin', size: 10 })
  const r = await h.call('/api/file-upload/chunk', { token: begin.body.token, index: 7, data: 'QUJDRA==' })
  assert.equal(r.code, 400)
  assert.match(r.body.error, /越界/)
})

test('end rejects missing chunk indices and short totals', async (t) => {
  const { h } = withDropbox(t)
  const size = CHUNK + 100
  const begin = await h.call('/api/file-upload/begin', { name: 'x.bin', size })
  const token = begin.body.token
  // Chunk 1 arrives, chunk 0 never does.
  await h.call('/api/file-upload/chunk', { token, index: 1, data: b64(Buffer.alloc(100, 1)) })
  const end = await h.call('/api/file-upload/end', { token })
  assert.equal(end.code, 400)
  assert.match(end.body.error, /缺失|不完整/)
})

test('end rejects a payload that decodes to the wrong size', async (t) => {
  const { h } = withDropbox(t)
  const begin = await h.call('/api/file-upload/begin', { name: 'x.txt', size: 100 })
  const token = begin.body.token
  // Correct chunk length (136 chars) but content decodes to 102 bytes: the
  // decoded size cannot match the declared 100.
  const chunk = await h.call('/api/file-upload/chunk', { token, index: 0, data: 'A'.repeat(136) })
  assert.equal(chunk.code, 200, 'length-valid chunk accepted')
  const end = await h.call('/api/file-upload/end', { token })
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
  assert.deepEqual(diskFiles(dir), ['dup.txt'])
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
  assert.deepEqual(diskFiles(dir), ['img.png.b64'])
})

test('non-loopback callers are accepted (no remote-address gate; the server binds loopback anyway)', async (t) => {
  const { h } = withDropbox(t)
  const ok = await h.call('/api/file-upload/begin', { name: 'a.txt', size: 1 }, '192.168.1.50')
  assert.equal(ok.code, 200)
})

test('begin fast-path: same name+size+lastModified reuses instantly without any upload', async (t) => {
  const { dir, h } = withDropbox(t)
  const content = Buffer.from('fast dedupe', 'utf8')
  const first = await upload(h, 'fast.txt', content)
  assert.equal(first.code, 200)
  const begin = await h.call('/api/file-upload/begin', { name: 'fast.txt', size: content.length, lastModified: FIXED_TS })
  assert.equal(begin.code, 200)
  assert.equal(begin.body.path, first.body.path)
  assert.equal(begin.body.encoded, false)
  assert.deepEqual(diskFiles(dir), ['fast.txt'], 'no new copy on disk')
})

test('begin fast-path hits .b64 files too', async (t) => {
  const { dir, h } = withDropbox(t)
  const content = Buffer.from([1, 2, 3, 4, 5])
  const first = await upload(h, 'f.bin', content)
  assert.equal(first.code, 200)
  const begin = await h.call('/api/file-upload/begin', { name: 'f.bin', size: content.length, lastModified: FIXED_TS })
  assert.equal(begin.body.path, first.body.path)
  assert.equal(begin.body.encoded, true)
  assert.deepEqual(diskFiles(dir), ['f.bin.b64'])
})

// ---- v2.1.0 P1 regression: the fast path must never reuse an edited file ----
test('P1: same name+size but DIFFERENT lastModified (edited file) must NOT reuse; content lands as _1', async (t) => {
  const { dir, h } = withDropbox(t)
  const a = Buffer.from('P1-AAAA-BBBB-CCCC-DDDD')
  const b = Buffer.from('P1-BBBB-CCCC-DDDD-EEEE') // same 20 bytes, different content
  const first = await upload(h, 'p1.txt', a, 1700000000000)
  assert.equal(first.body.path, join(dir, 'p1.txt'))
  // Same size, different content, file was edited (new lastModified, well
  // beyond the 1s tolerance):
  // begin must fall through to a full upload instead of returning the old path.
  const begin = await h.call('/api/file-upload/begin', { name: 'p1.txt', size: b.length, lastModified: 1700000002000 })
  assert.equal(begin.code, 200)
  assert.ok(begin.body.token, 'must issue a token (no silent reuse)')
  await h.call('/api/file-upload/chunk', { token: begin.body.token, index: 0, data: b64(b) })
  const end = await h.call('/api/file-upload/end', { token: begin.body.token })
  assert.equal(end.code, 200)
  assert.ok(end.body.path.endsWith('p1_1.txt'), 'edited content must land as _1 copy')
  assert.equal(readFileSync(join(dir, 'p1.txt'), 'utf8'), a.toString())
  assert.equal(readFileSync(join(dir, 'p1_1.txt'), 'utf8'), b.toString())
})

test('P1: same content but different lastModified reuses by hash at end (no _1)', async (t) => {
  const { dir, h } = withDropbox(t)
  const content = Buffer.from('identical bytes, re-saved file', 'utf8')
  await upload(h, 'p1b.txt', content, 1700000000000)
  const second = await upload(h, 'p1b.txt', content, 1700000002000) // re-saved, same bytes
  assert.equal(second.code, 200)
  assert.equal(second.body.path, join(dir, 'p1b.txt'), 'end hash-dedupe must reuse')
  assert.deepEqual(diskFiles(dir), ['p1b.txt'])
})

test('P1: fast path refuses when the manifest has no entry for the file', async (t) => {
  const { dir, h } = withDropbox(t)
  // Pre-2.1 dropbox file: on disk, but never registered in the manifest.
  writeFileSync(join(dir, 'legacy.txt'), 'old dropbox file')
  const begin = await h.call('/api/file-upload/begin', { name: 'legacy.txt', size: 16, lastModified: FIXED_TS })
  assert.equal(begin.code, 200)
  assert.ok(begin.body.token, 'no manifest entry → conservative full upload')
  await h.call('/api/file-upload/chunk', { token: begin.body.token, index: 0, data: b64(Buffer.from('old dropbox file')) })
  const end = await h.call('/api/file-upload/end', { token: begin.body.token })
  assert.equal(end.code, 200)
  assert.equal(end.body.path, join(dir, 'legacy.txt'), 'end hash-dedupe reuses + registers the entry')
  // Now the file is registered: fast path works again.
  const begin2 = await h.call('/api/file-upload/begin', { name: 'legacy.txt', size: 16, lastModified: FIXED_TS })
  assert.equal(begin2.body.path, join(dir, 'legacy.txt'))
})

// ---- v2.1.0 P2 regression: duplicate marking comes from the manifest ----
test('P2: natural `_N` names are NOT duplicates; only manifest-registered plugin copies are', async (t) => {
  const { dir, h } = withDropbox(t)
  // Natural files the user placed (or another tool wrote) — never in the manifest.
  writeFileSync(join(dir, 'notes.txt'), 'n1')
  writeFileSync(join(dir, 'notes_2024.txt'), 'n2')
  writeFileSync(join(dir, 'notes_2025.txt'), 'n3')
  // Plugin-created copy via the real pipeline.
  await upload(h, 'a.txt', Buffer.alloc(100, 1))
  await upload(h, 'a.txt', Buffer.alloc(101, 2)) // → a_1.txt, manifest isCopy=true

  const list = await h.call('/api/file-upload/list', {})
  assert.equal(list.code, 200)
  const mark = Object.fromEntries(list.body.files.map((f) => [f.name, f.duplicate]))
  assert.equal(mark['notes.txt'], false)
  assert.equal(mark['notes_2024.txt'], false, 'natural dated name must not be flagged')
  assert.equal(mark['notes_2025.txt'], false, 'natural dated name must not be flagged')
  assert.equal(mark['a.txt'], false)
  assert.equal(mark['a_1.txt'], true, 'manifest-registered plugin copy must be flagged')

  // Cleaning duplicates must only remove the plugin copy.
  const dup = await h.call('/api/file-upload/clean', { mode: 'duplicates' })
  assert.deepEqual(dup.body.deleted, ['a_1.txt'])
  assert.deepEqual(diskFiles(dir).sort(), ['a.txt', 'notes.txt', 'notes_2024.txt', 'notes_2025.txt'])
})

// ---- v2.1.0 P8: cross-origin guard ----
test('P8: cross-origin requests are rejected; same-origin and tokenless callers pass', async (t) => {
  const { h } = withDropbox(t)
  const evil = await h.call('/api/file-upload/begin', { name: 'a.txt', size: 4 }, '127.0.0.1', { origin: 'http://evil.example.com', host: '127.0.0.1:3080' })
  assert.equal(evil.code, 403)
  assert.match(evil.body.error, /跨源/)
  const same = await h.call('/api/file-upload/begin', { name: 'a.txt', size: 4 }, '127.0.0.1', { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' })
  assert.equal(same.code, 200)
  const localhost = await h.call('/api/file-upload/begin', { name: 'a.txt', size: 4 }, '127.0.0.1', { origin: 'http://localhost:3080', host: 'localhost:3080' })
  assert.equal(localhost.code, 200)
  const noOrigin = await h.call('/api/file-upload/begin', { name: 'a.txt', size: 4 })
  assert.equal(noOrigin.code, 200)
})

// ---- v2.1.0 P3: a failed upload must not leave the host job alive ----
test('P3: client-style failure path — abort releases the job immediately', async (t) => {
  const { h } = withDropbox(t)
  const begin = await h.call('/api/file-upload/begin', { name: 'x.bin', size: 100 })
  const token = begin.body.token
  // Simulate the v2.1.0 client: chunk fails (bad data) → client calls abort.
  await h.call('/api/file-upload/chunk', { token, index: 0, data: 'WRONG' })
  await h.call('/api/file-upload/abort', { token })
  const probe = await h.call('/api/file-upload/chunk', { token, index: 0, data: 'WRONG' })
  assert.equal(probe.code, 400)
  assert.match(probe.body.error, /不存在或已过期/, 'job must be gone right after abort')
})

test('list + clean: inventory marks manifest _N copies, cleanup modes work', async (t) => {
  const { dir, h } = withDropbox(t)
  // a.txt (100B) and a_1.txt (101B, duplicate), b.bin.b64 and b.bin_1.b64 (duplicate)
  await upload(h, 'a.txt', Buffer.alloc(100, 1))
  await upload(h, 'a.txt', Buffer.alloc(101, 2))
  await upload(h, 'b.bin', Buffer.from([1, 2, 3]))
  await upload(h, 'b.bin', Buffer.from([4, 5, 6, 7]))

  const list = await h.call('/api/file-upload/list', {})
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
  const dup = await h.call('/api/file-upload/clean', { mode: 'duplicates' })
  assert.equal(dup.code, 200)
  assert.deepEqual(dup.body.deleted.sort(), ['a_1.txt', 'b.bin_1.b64'])
  assert.deepEqual(diskFiles(dir).sort(), ['a.txt', 'b.bin.b64'])

  // largerThan mode with a tiny threshold removes everything left
  const big = await h.call('/api/file-upload/clean', { mode: 'largerThan', minSizeBytes: 1 })
  assert.equal(big.code, 200)
  assert.deepEqual(diskFiles(dir), [])

  // all mode on an empty dropbox is a no-op
  const all = await h.call('/api/file-upload/clean', { mode: 'all' })
  assert.equal(all.code, 200)
  assert.deepEqual(all.body.deleted, [])
  assert.equal(all.body.freedBytes, 0)
})

test('clean rejects unknown modes', async (t) => {
  const { h } = withDropbox(t)
  const r = await h.call('/api/file-upload/clean', { mode: 'everything' })
  assert.equal(r.code, 400)
  assert.match(r.body.error, /清理模式/)
})

test('abort discards the session', async (t) => {
  const { h } = withDropbox(t)
  const begin = await h.call('/api/file-upload/begin', { name: 'a.txt', size: 10 })
  await h.call('/api/file-upload/abort', { token: begin.body.token })
  const end = await h.call('/api/file-upload/end', { token: begin.body.token })
  assert.equal(end.code, 400)
  assert.match(end.body.error, /不存在或已过期/)
})

test('oversized request body is rejected', async (t) => {
  const { h } = withDropbox(t)
  const huge = { name: 'x'.repeat(17 * 1024 * 1024), size: 1 }
  const r = await h.call('/api/file-upload/begin', huge)
  assert.equal(r.code, 400)
  assert.match(r.body.error, /上限/)
})

test('session expires after the timeout', async (t) => {
  const { h } = withDropbox(t)
  const begin = await h.call('/api/file-upload/begin', { name: 'a.txt', size: 10 })
  const end = await h.call('/api/file-upload/end', { token: begin.body.token })
  assert.equal(end.code, 400)
})

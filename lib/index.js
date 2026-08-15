// dsh-file-upload — Host half (persistent profile plugin).
// Runs in the DSH host process: HTTP upload routes under
// /api/file-upload/* receive chunked base64, files land in
// ~/.dsh-dropbox, and the absolute path comes back for the composer.
// Text-class files are decoded and written verbatim; binary files stay
// base64 with a .b64 suffix (agent decodes with Python).
import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, writeFileSync, existsSync, statSync, readdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Transform } from 'node:stream'

export const name = 'dsh-file-upload'
export const inject = ['webServer']

const TEXT_RE = /\.(txt|md|csv|yml|yaml|json|xml|log|ini|cnf|prm|pri|a2l|s19|bat|sh|py|js|ts|html|css|cfg)$/i
const MAX_BYTES = 512 * 1024 * 1024
// Multiple of 3 on purpose: every full chunk then encodes to padding-free
// base64, so the concatenated stream decodes to the exact original bytes.
// (A 4MiB chunk would embed '==' mid-stream and truncate any decoder.)
const CHUNK_BYTES = 4 * 1024 * 1024 - 1
const MAX_BODY = 16 * 1024 * 1024
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** Length of the base64 text a file of `size` bytes stores as (valid because CHUNK_BYTES % 3 === 0). */
export function storedB64Length(size) {
  return Math.ceil(size / 3) * 4
}

/** Windows-safe dropbox file name: illegal chars become `_`, reserved device
 * names and trailing dots/spaces are neutralized, and the name is capped at
 * 120 chars (keeps the full path well under MAX_PATH). */
export function sanitize(name) {
  let base = String(name || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim()
  base = base.replace(/[. ]+$/, '')
  if (!base) return 'file'
  if (RESERVED_NAME.test(base)) base = '_' + base
  if (base.length > 120) {
    const dot = base.lastIndexOf('.')
    const stem = dot > 0 ? base.slice(0, dot) : base
    const ext = dot > 0 ? base.slice(dot) : ''
    base = stem.slice(0, 120 - ext.length) + ext
  }
  return base
}

/** Streaming base64 → bytes transform; quad-aligned so pipe-chunk splits never corrupt the decode. */
function b64DecodeTransform() {
  let carry = ''
  return new Transform({
    transform(chunk, _enc, cb) {
      carry += chunk.toString('utf8')
      const n = carry.length - (carry.length % 4)
      if (n > 0) {
        const out = Buffer.from(carry.slice(0, n), 'base64')
        carry = carry.slice(n)
        cb(null, out)
      } else {
        cb()
      }
    },
    flush(cb) {
      cb(null, carry ? Buffer.from(carry, 'base64') : undefined)
    },
  })
}

/** sha256 of a dropbox file's ORIGINAL bytes (`encoded` = .b64 text, decoded first). */
export async function hashFile(path, encoded) {
  const hash = createHash('sha256')
  const src = createReadStream(path)
  const stream = encoded ? src.pipe(b64DecodeTransform()) : src
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * Fast-path dedupe lookup: same name + same byte size already in the dropbox?
 * Pure stat check (no content read) — used at begin() so a repeated drop of
 * the same file never uploads it again. The content-hash check at end() is
 * the authoritative guard for fresh uploads.
 * @returns the existing on-disk path + encoded flag, or null when absent.
 */
export function findReusableBySize(dir, name, size) {
  for (const fileName of [name, name + '.b64']) {
    const path = join(dir, fileName)
    let info
    try {
      info = statSync(path)
    } catch {
      continue
    }
    if (!info.isFile()) continue
    const expected = fileName.endsWith('.b64') ? storedB64Length(size) : size
    if (info.size !== expected) continue
    return { path, encoded: fileName.endsWith('.b64') }
  }
  return null
}

/**
 * Dedupe lookup: is a byte-identical file (same name, same content) already in
 * the dropbox? The candidate must match the content hash — name + size alone
 * could silently reuse a different file of the same length.
 * @returns the existing on-disk path + encoded flag, or null when absent.
 */
export async function findReusable(dir, name, size, originalHash) {
  for (const fileName of [name, name + '.b64']) {
    const path = join(dir, fileName)
    let info
    try {
      info = statSync(path)
    } catch {
      continue
    }
    if (!info.isFile()) continue
    const expected = fileName.endsWith('.b64') ? storedB64Length(size) : size
    if (info.size !== expected) continue
    if ((await hashFile(path, fileName.endsWith('.b64'))) !== originalHash) continue
    return { path, encoded: fileName.endsWith('.b64') }
  }
  return null
}

/**
 * Dropbox inventory for the settings cleanup panel. A file is a "duplicate"
 * when its name carries a `_<n>` counter (e.g. `a.txt_1.b64`) AND the
 * corresponding base file (`a.txt` / `a.txt.b64`) exists — the residue of
 * pre-v1.2.3 dedupe failures; v1.2.3+ never creates them except for genuinely
 * different content. Directories are ignored.
 * @returns { files: {name,size,mtime,encoded,duplicate}[], totalBytes }
 */
export function listDropbox(dir) {
  const files = []
  let totalBytes = 0
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return { files, totalBytes }
  }
  const isDuplicate = (name) => {
    const base = name.endsWith('.b64') ? name.slice(0, -4) : name
    const m = base.match(/^(.*)_(\d+)(\.[^.]+)?$/)
    if (!m) return false
    const stem = m[1] + (m[3] || '')
    return existsSync(join(dir, stem)) || existsSync(join(dir, stem + '.b64'))
  }
  for (const name of names) {
    let info
    try {
      info = statSync(join(dir, name))
    } catch {
      continue
    }
    if (!info.isFile()) continue
    totalBytes += info.size
    files.push({
      name,
      size: info.size,
      mtime: info.mtimeMs,
      encoded: name.endsWith('.b64'),
      duplicate: isDuplicate(name),
    })
  }
  files.sort((a, b) => a.name.localeCompare(b.name))
  return { files, totalBytes }
}

/**
 * Delete dropbox files by mode ('duplicates' | 'largerThan' | 'all').
 * @returns { deleted: string[], freedBytes: number }
 */
export function cleanDropbox(dir, mode, minSizeBytes) {
  const { files } = listDropbox(dir)
  const target = files.filter((f) => {
    if (mode === 'duplicates') return f.duplicate
    if (mode === 'largerThan') return f.size >= minSizeBytes
    return true // 'all'
  })
  const deleted = []
  let freedBytes = 0
  for (const f of target) {
    try {
      unlinkSync(join(dir, f.name))
      deleted.push(f.name)
      freedBytes += f.size
    } catch {
      // file vanished between list and unlink — skip it
    }
  }
  return { deleted, freedBytes }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (c) => {
      total += c.length
      if (total > MAX_BODY) {
        reject(new Error('请求体超过 16MB 上限'))
        if (typeof req.destroy === 'function') req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (err) {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return
  const timer = ctx.get('timer')
  const jobs = new Map()
  // DSH_DROPBOX_DIR is a test seam; the default is the user dropbox.
  const dropboxDir = process.env.DSH_DROPBOX_DIR || join(homedir(), '.dsh-dropbox')
  try {
    mkdirSync(dropboxDir, { recursive: true })
  } catch (err) {
    console.error('[dsh-file-upload] cannot create dropbox dir:', err.message)
  }

  const handle = async (req, res, action) => {
    try {
      const args = await readBody(req)
      const result = await action(args)
      json(res, 200, result)
    } catch (err) {
      json(res, 400, { error: err && err.message ? err.message : String(err) })
    }
  }

  const routes = [
    {
      kind: 'exact',
      path: '/api/file-upload/begin',
      handler: (req, res) => handle(req, res, (args) => {
        const name = sanitize(args && args.name)
        const size = Number((args && args.size) || 0)
        if (size <= 0) throw new Error('空文件无法接收')
        if (size > MAX_BYTES) throw new Error('文件超过 512MB 上限，请改用路径方式')
        // Fast-path reuse (v1.1.0 behavior, restored in v1.2.3): a dropbox
        // file with the same name AND byte size is returned immediately —
        // no upload at all, so re-dropping a large file is instant. The
        // content-hash check at end() remains as the safety net for fresh
        // uploads (same name+size but different content lands as _1).
        const existing = findReusableBySize(dropboxDir, name, size)
        if (existing !== null) return { path: existing.path, encoded: existing.encoded }
        const token = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
        jobs.set(token, { name, size, chunks: new Map(), total: 0 })
        if (timer) {
          timer.timeout(() => { if (jobs.has(token)) jobs.delete(token) }, 10 * 60 * 1000)
        }
        return { token }
      }),
    },
    {
      kind: 'exact',
      path: '/api/file-upload/chunk',
      handler: (req, res) => handle(req, res, (args) => {
        const state = jobs.get(args && args.token)
        if (!state) throw new Error('上传会话不存在或已过期')
        const index = Number(args.index)
        const data = String(args.data || '')
        const chunkCount = Math.ceil(state.size / CHUNK_BYTES)
        if (!Number.isInteger(index) || index < 0 || index >= chunkCount) throw new Error('分块序号越界')
        // Exact per-chunk length: 4 chars per 3 bytes (CHUNK_BYTES % 3 === 0
        // keeps full chunks padding-free). Catches truncated or padded chunks
        // at receipt instead of silently writing a corrupt file.
        const bytesInChunk = Math.min(CHUNK_BYTES, state.size - index * CHUNK_BYTES)
        const expectLen = Math.ceil(bytesInChunk / 3) * 4
        if (data.length !== expectLen) throw new Error('分块数据长度不符')
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('分块数据不是 base64')
        if (!state.chunks.has(index)) {
          state.chunks.set(index, data)
          state.total += data.length
        }
        return { received: state.chunks.size }
      }),
    },
    {
      kind: 'exact',
      path: '/api/file-upload/end',
      handler: (req, res) => handle(req, res, async (args) => {
        const token = args && args.token
        const state = jobs.get(token)
        if (!state) throw new Error('上传会话不存在或已过期')
        const chunkCount = Math.ceil(state.size / CHUNK_BYTES)
        if (state.chunks.size !== chunkCount) throw new Error('分块不完整，请重试')
        const parts = []
        for (let i = 0; i < chunkCount; i++) {
          const data = state.chunks.get(i)
          if (data === undefined) throw new Error('分块缺失: ' + i)
          parts.push(data)
        }
        const base64 = parts.join('')
        if (state.total !== base64.length) throw new Error('数据长度与分块不符')
        const isText = TEXT_RE.test(state.name)
        // Integrity: the payload must decode to exactly the declared size.
        // The text path materializes the decoded buffer anyway; the binary
        // path validates by formula and hashes the decoded stream so a
        // 512MB file never needs a second full buffer.
        let originalHash
        if (isText) {
          const decoded = Buffer.from(base64, 'base64')
          if (decoded.length !== state.size) throw new Error('解码后字节数与声明不符')
          originalHash = createHash('sha256').update(decoded).digest('hex')
          const existing = await findReusable(dropboxDir, state.name, state.size, originalHash)
          if (existing !== null) {
            jobs.delete(token)
            return { path: existing.path, bytes: state.size, encoded: existing.encoded }
          }
          let finalPath = join(dropboxDir, state.name)
          let counter = 1
          while (existsSync(finalPath)) {
            const dot = state.name.lastIndexOf('.')
            const stem = dot > 0 ? state.name.slice(0, dot) : state.name
            const ext = dot > 0 ? state.name.slice(dot) : ''
            finalPath = join(dropboxDir, stem + '_' + (counter++) + ext)
          }
          writeFileSync(finalPath, decoded)
          jobs.delete(token)
          return { path: finalPath, bytes: state.size, encoded: false }
        }
        const chars = base64.replace(/=+$/, '').length
        const decodedLen = 3 * Math.floor(chars / 4) + (chars % 4 === 2 ? 1 : chars % 4 === 3 ? 2 : 0)
        if (decodedLen !== state.size) throw new Error('解码后字节数与声明不符')
        const hash = createHash('sha256')
        let rem = ''
        for (let i = 0; i < base64.length; i += 65536) {
          const piece = base64.slice(i, i + 65536)
          const t = rem + piece
          const n = t.length - (t.length % 4)
          hash.update(Buffer.from(t.slice(0, n), 'base64'))
          rem = t.slice(n)
        }
        if (rem) hash.update(Buffer.from(rem, 'base64'))
        originalHash = hash.digest('hex')
        const existing = await findReusable(dropboxDir, state.name, state.size, originalHash)
        if (existing !== null) {
          jobs.delete(token)
          return { path: existing.path, bytes: state.size, encoded: existing.encoded }
        }
        let finalPath = join(dropboxDir, state.name + '.b64')
        let counter = 1
        while (existsSync(finalPath)) {
          finalPath = join(dropboxDir, state.name + '_' + (counter++) + '.b64')
        }
        writeFileSync(finalPath, base64, 'utf8')
        jobs.delete(token)
        return { path: finalPath, bytes: state.size, encoded: true }
      }),
    },
    {
      kind: 'exact',
      path: '/api/file-upload/abort',
      handler: (req, res) => handle(req, res, (args) => {
        if (args && args.token) jobs.delete(args.token)
        return null
      }),
    },
    {
      kind: 'exact',
      path: '/api/file-upload/list',
      handler: (req, res) => handle(req, res, () => listDropbox(dropboxDir)),
    },
    {
      kind: 'exact',
      path: '/api/file-upload/clean',
      handler: (req, res) => handle(req, res, (args) => {
        const mode = args && args.mode
        if (mode !== 'duplicates' && mode !== 'largerThan' && mode !== 'all') {
          throw new Error('清理模式必须是 duplicates / largerThan / all')
        }
        const minSizeBytes = Number((args && args.minSizeBytes) || 0)
        if (mode === 'largerThan' && !(minSizeBytes > 0)) throw new Error('缺少大小阈值')
        return cleanDropbox(dropboxDir, mode, minSizeBytes)
      }),
    },
  ]

  const disposers = routes.map((route) => webServer.register(route))
  ctx.effect(() => () => { for (const dispose of disposers) dispose() }, 'dsh-file-upload: routes')
}

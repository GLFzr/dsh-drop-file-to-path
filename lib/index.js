// dsh-file-upload — Host half (persistent profile plugin). v2.1.0
// Runs in the DSH host process: HTTP upload routes under
// /api/file-upload/* receive chunked base64, files land in
// ~/.dsh-dropbox, and the absolute path comes back for the composer.
// Text-class files are decoded and written verbatim; binary files stay
// base64 with a .b64 suffix (agent decodes with Python).
//
// v2.1.0 changes:
//  - P1 fix: the begin fast-path (same name + same size) only reuses an
//    existing dropbox file when the manifest records the same source
//    lastModified as the incoming drop — an edited file that kept its byte
//    count is NEVER silently reused; it falls through to the full upload
//    where end() hash-dedupes authoritatively.
//  - P2 fix: `.dsh-manifest.json` registers every file this plugin writes;
//    cleanup-panel "duplicate" marking comes from the manifest's isCopy flag
//    instead of guessing from `_<N>` name patterns (natural names like
//    `notes_2024.txt` are no longer mis-flagged).
//  - P8 hardening: HTTP routes reject cross-origin requests (Origin header
//    must match the Host); token-free localhost callers without Origin are
//    unaffected.
//  - P7 fix: sanitize() falls back to 'file' when the name sanitizes to only
//    replacement underscores (e.g. '::::').
import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, writeFileSync, existsSync, statSync, readdirSync, unlinkSync, readFileSync } from 'node:fs'
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
// Dropbox inventory file that records what this plugin wrote (see v2.1.0 notes).
const MANIFEST_NAME = '.dsh-manifest.json'
// lastModified tolerance: the browser reports ms precision, filesystems may
// round; anything within 1s is the same source file.
const MTIME_TOLERANCE_MS = 1000

/** Length of the base64 text a file of `size` bytes stores as (valid because CHUNK_BYTES % 3 === 0). */
export function storedB64Length(size) {
  return Math.ceil(size / 3) * 4
}

/** Windows-safe dropbox file name: illegal chars become `_`, reserved device
 * names and trailing dots/spaces are neutralized, and the name is capped at
 * 120 chars (keeps the full path well under MAX_PATH). Names that sanitize
 * down to nothing but replacement underscores fall back to 'file'. */
export function sanitize(name) {
  let base = String(name || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim()
  base = base.replace(/[. ]+$/, '')
  if (!base || /^_+$/.test(base)) return 'file'
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

/** Fast-path dedupe lookup: same name + same byte size already in the dropbox?
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

/** Read the dropbox manifest (empty when absent/corrupt). */
export function readManifest(dir) {
  try {
    const j = JSON.parse(readFileSync(join(dir, MANIFEST_NAME), 'utf8'))
    if (j && typeof j === 'object' && j.files && typeof j.files === 'object') return j
  } catch { /* absent or corrupt — start fresh */ }
  return { version: 1, files: {} }
}

/** Persist the manifest (synchronous; call directly after mutating it). */
export function writeManifest(dir, manifest) {
  try {
    writeFileSync(join(dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2), 'utf8')
  } catch (err) {
    console.error('[dsh-file-upload] cannot write manifest:', err.message)
  }
}

const basename = (p) => String(p).split(/[\\/]/).pop()

/**
 * Dropbox inventory for the settings cleanup panel. A file is a "duplicate"
 * only when the MANIFEST records it as an auto-numbered `_N` copy this plugin
 * created — name patterns are no longer guessed (v2.1.0: natural names like
 * `notes_2024.txt` are never mis-flagged). Directories and the manifest
 * itself are ignored.
 * @returns { files: {name,size,mtime,encoded,duplicate}[], totalBytes }
 */
export function listDropbox(dir, manifest) {
  const m = manifest || readManifest(dir)
  const files = []
  let totalBytes = 0
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return { files, totalBytes }
  }
  for (const name of names) {
    if (name === MANIFEST_NAME) continue
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
      duplicate: !!(m.files && m.files[name] && m.files[name].isCopy === true),
    })
  }
  files.sort((a, b) => a.name.localeCompare(b.name))
  return { files, totalBytes }
}

/**
 * Delete dropbox files by mode ('duplicates' | 'largerThan' | 'all').
 * Deleted files are un-registered from the manifest.
 * @returns { deleted: string[], freedBytes: number }
 */
export function cleanDropbox(dir, mode, minSizeBytes, manifest) {
  const m = manifest || readManifest(dir)
  const { files } = listDropbox(dir, m)
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
      if (m.files) delete m.files[f.name]
    } catch {
      // file vanished between list and unlink — skip it
    }
  }
  if (deleted.length > 0) writeManifest(dir, m)
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
  // In-memory manifest: the single source of truth for fast-path reuse (P1)
  // and duplicate marking (P2). Mutations are followed synchronously by
  // writeManifest, so concurrent async handlers cannot interleave between
  // mutation and persist.
  let manifest = readManifest(dropboxDir)

  /** Register (or refresh) the manifest entry for a just-written file. */
  const registerEntry = (fileName, entry) => {
    manifest.files[fileName] = entry
    writeManifest(dropboxDir, manifest)
  }

  const handle = async (req, res, action) => {
    // P8: reject cross-origin browser requests. Token-free local callers
    // (curl, agents, tests) send no Origin header and are unaffected.
    const origin = req.headers && req.headers.origin
    const host = req.headers && req.headers.host
    if (origin && host) {
      const allowed = new Set(['http://' + host, 'https://' + host])
      if (!allowed.has(origin)) {
        // Drain the request body before responding: replying without
        // consuming the payload would leave the keep-alive connection
        // desynced for the NEXT (possibly legitimate) request on it.
        if (typeof req.resume === 'function') req.resume()
        json(res, 403, { error: '跨源请求被拒绝' })
        return
      }
    }
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
        const lastModified = Number((args && args.lastModified) || 0)
        // Fast-path reuse (P1-safe since v2.1.0): a dropbox file with the same
        // name AND byte size is returned immediately — zero upload — but ONLY
        // when the manifest records the same source lastModified as this drop.
        // Same-size edits (content changed, byte count unchanged) never hit
        // this path: they fall through to the full upload, and end() decides
        // by content hash (reuse vs `_1` copy).
        const existing = findReusableBySize(dropboxDir, name, size)
        if (existing !== null && lastModified > 0) {
          const entry = manifest.files && manifest.files[basename(existing.path)]
          if (entry && Math.abs(Number(entry.sourceLastModified || 0) - lastModified) <= MTIME_TOLERANCE_MS) {
            return { path: existing.path, encoded: existing.encoded }
          }
        }
        const token = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
        jobs.set(token, { name, size, chunks: new Map(), total: 0, lastModified })
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
            if (!manifest.files[basename(existing.path)]) {
              registerEntry(basename(existing.path), {
                origin: state.name, sourceLastModified: state.lastModified,
                size: state.size, sha256: originalHash, encoded: existing.encoded,
                isCopy: false, createdAt: Date.now(),
              })
            }
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
          registerEntry(basename(finalPath), {
            origin: state.name, sourceLastModified: state.lastModified,
            size: state.size, sha256: originalHash, encoded: false,
            isCopy: finalPath !== join(dropboxDir, state.name), createdAt: Date.now(),
          })
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
          if (!manifest.files[basename(existing.path)]) {
            registerEntry(basename(existing.path), {
              origin: state.name, sourceLastModified: state.lastModified,
              size: state.size, sha256: originalHash, encoded: existing.encoded,
              isCopy: false, createdAt: Date.now(),
            })
          }
          jobs.delete(token)
          return { path: existing.path, bytes: state.size, encoded: existing.encoded }
        }
        let finalPath = join(dropboxDir, state.name + '.b64')
        let counter = 1
        while (existsSync(finalPath)) {
          finalPath = join(dropboxDir, state.name + '_' + (counter++) + '.b64')
        }
        writeFileSync(finalPath, base64, 'utf8')
        registerEntry(basename(finalPath), {
          origin: state.name, sourceLastModified: state.lastModified,
          size: state.size, sha256: originalHash, encoded: true,
          isCopy: finalPath !== join(dropboxDir, state.name + '.b64'), createdAt: Date.now(),
        })
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
      handler: (req, res) => handle(req, res, () => listDropbox(dropboxDir, manifest)),
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
        const result = cleanDropbox(dropboxDir, mode, minSizeBytes, manifest)
        return result
      }),
    },
  ]

  const disposers = routes.map((route) => webServer.register(route))
  ctx.effect(() => () => { for (const dispose of disposers) dispose() }, 'dsh-file-upload: routes')
}

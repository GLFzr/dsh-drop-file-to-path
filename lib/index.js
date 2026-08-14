// dsh-drop-file-to-path — Host half (persistent profile plugin).
// Runs in the DSH host process: HTTP upload routes under
// /api/drop-file-to-path/* receive chunked base64, files land in
// ~/.dsh-dropbox, and the absolute path comes back for the composer.
// Text-class files are decoded and written verbatim; binary files stay
// base64 with a .b64 suffix (agent decodes with Python).
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-drop-file-to-path'
export const inject = ['webServer']

const TEXT_RE = /\.(txt|md|csv|yml|yaml|json|xml|log|ini|cnf|prm|pri|a2l|s19|bat|sh|py|js|ts|html|css|cfg)$/i
const MAX_BYTES = 512 * 1024 * 1024
const CHUNK_BYTES = 4 * 1024 * 1024

function sanitize(name) {
  const base = String(name || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim()
  return base || 'file'
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
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
  const timer = ctx.get('timer')
  const jobs = new Map()
  const dropboxDir = join(homedir(), '.dsh-dropbox')
  try {
    mkdirSync(dropboxDir, { recursive: true })
  } catch (err) {
    console.error('[dsh-drop-file-to-path] cannot create dropbox dir:', err.message)
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
      path: '/api/drop-file-to-path/begin',
      handler: (req, res) => handle(req, res, (args) => {
        const name = sanitize(args && args.name)
        const size = Number((args && args.size) || 0)
        if (size <= 0) throw new Error('空文件无法接收')
        if (size > MAX_BYTES) throw new Error('文件超过 512MB 上限，请改用路径方式')
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
      path: '/api/drop-file-to-path/chunk',
      handler: (req, res) => handle(req, res, (args) => {
        const state = jobs.get(args && args.token)
        if (!state) throw new Error('上传会话不存在或已过期')
        const index = Number(args.index)
        const data = String(args.data || '')
        if (!Number.isFinite(index) || index < 0 || index > state.chunks.size + 8) throw new Error('分块序号异常')
        if (!state.chunks.has(index)) {
          state.chunks.set(index, data)
          state.total += data.length
        }
        if (state.total > state.size * 1.4 + 8192) throw new Error('数据大小超过预期')
        return { received: state.chunks.size }
      }),
    },
    {
      kind: 'exact',
      path: '/api/drop-file-to-path/end',
      handler: (req, res) => handle(req, res, async (args) => {
        const token = args && args.token
        const state = jobs.get(token)
        if (!state) throw new Error('上传会话不存在或已过期')
        const expected = Math.ceil(state.size / CHUNK_BYTES)
        if (state.chunks.size < expected) throw new Error('分块不完整，请重试')
        const base64 = Array.from({ length: expected }, (_, i) => state.chunks.get(i) || '').join('')
        const isText = TEXT_RE.test(state.name)
        let fileName = state.name
        if (!isText) fileName += '.b64'
        let finalPath = join(dropboxDir, fileName)
        let counter = 1
        while (existsSync(finalPath)) {
          const dot = fileName.lastIndexOf('.')
          const stem = dot > 0 ? fileName.slice(0, dot) : fileName
          const ext = dot > 0 ? fileName.slice(dot) : ''
          finalPath = join(dropboxDir, stem + '_' + (counter++) + ext)
        }
        if (isText) {
          writeFileSync(finalPath, Buffer.from(base64, 'base64'))
        } else {
          writeFileSync(finalPath, base64, 'utf8')
        }
        jobs.delete(token)
        return { path: finalPath, bytes: state.size, encoded: !isText }
      }),
    },
    {
      kind: 'exact',
      path: '/api/drop-file-to-path/abort',
      handler: (req, res) => handle(req, res, (args) => {
        if (args && args.token) jobs.delete(args.token)
        return null
      }),
    },
  ]

  const disposers = routes.map((route) => ctx.webServer.register(route))
  ctx.effect(() => () => { for (const dispose of disposers) dispose() }, 'dsh-drop-file-to-path: routes')
}

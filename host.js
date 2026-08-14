return {
  name: 'drop-file-to-path-host',
  inject: ['fs'],
  apply(ctx) {
    const sandboxPolicy = ctx.get('sandboxPolicy')
    const timer = ctx.get('timer')
    const jobs = new Map()
    const MAX_BYTES = 512 * 1024 * 1024
    const CHUNK_BYTES = 4 * 1024 * 1024
    const TEXT_RE = /\.(txt|md|csv|yml|yaml|json|xml|log|ini|cnf|prm|pri|a2l|s19|bat|sh|py|js|ts|html|css|cfg)$/i

    function sanitize(name) {
      const base = String(name || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim()
      return base || 'file'
    }

    async function targetOf(fsSvc, path) {
      return await fsSvc.resolve(path)
    }

    harness.handle('drop-upload/begin', async (args) => {
      const name = sanitize(args && args.name)
      const size = Number((args && args.size) || 0)
      if (size <= 0) throw new Error('空文件无法接收')
      if (size > MAX_BYTES) throw new Error('文件超过 512MB 上限，请改用路径方式')
      const token = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
      const state = { name, size, chunks: new Map(), total: 0 }
      jobs.set(token, state)
      if (timer) {
        timer.timeout(() => { if (jobs.has(token)) jobs.delete(token) }, 10 * 60 * 1000)
      }
      return { token }
    })

    harness.handle('drop-upload/chunk', async (args) => {
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
    })

    harness.handle('drop-upload/end', async (args) => {
      const token = args && args.token
      const state = jobs.get(token)
      if (!state) throw new Error('上传会话不存在或已过期')
      const expected = Math.ceil(state.size / CHUNK_BYTES)
      if (state.chunks.size < expected) throw new Error('分块不完整，请重试')
      const base64 = Array.from({ length: expected }, (_, i) => state.chunks.get(i) || '').join('')
      const workspaceRoot = sandboxPolicy ? sandboxPolicy.workspaceRoot : undefined
      if (!workspaceRoot) throw new Error('无法确定工作区根目录')
      const dir = workspaceRoot.replace(/[\\/]$/, '') + '/.dsh-dropbox'
      const isText = TEXT_RE.test(state.name)
      let fileName = state.name
      if (!isText) fileName += '.b64'
      const fsSvc = ctx.fs
      let finalPath = dir + '/' + fileName
      let counter = 1
      while (true) {
        let exists = false
        try {
          const info = await fsSvc.stat(await targetOf(fsSvc, finalPath))
          exists = !!info
        } catch (e) {
          exists = false
        }
        if (!exists) break
        const dot = fileName.lastIndexOf('.')
        const stem = dot > 0 ? fileName.slice(0, dot) : fileName
        const ext = dot > 0 ? fileName.slice(dot) : ''
        finalPath = dir + '/' + stem + '_' + (counter++) + ext
      }
      await fsSvc.writeText(await targetOf(fsSvc, finalPath), base64)
      jobs.delete(token)
      return { path: finalPath, bytes: state.size, encoded: !isText }
    })

    harness.handle('drop-upload/abort', async (args) => {
      if (args && args.token) jobs.delete(args.token)
      return null
    })
  },
}

return {
  apply(ctx) {
    const timer = ctx.get('timer')
    const store = { paths: [], pending: false, listeners: new Set() }
    function subscribe(fn) {
      store.listeners.add(fn)
      return () => { store.listeners.delete(fn) }
    }
    function emit() {
      store.listeners.forEach((fn) => { fn() })
    }

    function readAsDataURL(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => { resolve(reader.result) }
        reader.onerror = () => { reject(reader.error || new Error('读取文件失败')) }
        reader.readAsDataURL(blob)
      })
    }

    async function upload(file) {
      const begin = await host.call('drop-upload/begin', { name: file.name, size: file.size })
      const token = begin.token
      const CHUNK = 4 * 1024 * 1024
      const count = Math.max(1, Math.ceil(file.size / CHUNK))
      for (let i = 0; i < count; i++) {
        const blob = file.slice(i * CHUNK, Math.min((i + 1) * CHUNK, file.size))
        const dataUrl = await readAsDataURL(blob)
        const base64 = String(dataUrl).split(',')[1] || ''
        await host.call('drop-upload/chunk', { token, index: i, data: base64 })
      }
      const done = await host.call('drop-upload/end', { token })
      return done.path
    }

    function ShellDrop() {
      const [dragging, setDragging] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [pendingItems, setPendingItems] = React.useState([])
      React.useEffect(() => subscribe(() => { setPendingItems(store.paths.slice()) }), [])
      React.useEffect(() => {
        styles.insert('\n.dsh-dropbox-hint{position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);color:#fff;font-size:18px;font-weight:600;pointer-events:none;backdrop-filter:blur(2px)}\n.dsh-dropbox-err{position:fixed;right:16px;bottom:96px;z-index:9999;background:rgba(120,30,30,.95);color:#fff;font-size:12px;border-radius:8px;padding:8px 12px;max-width:420px;pointer-events:none;box-shadow:0 4px 14px rgba(0,0,0,.35)}\n.dsh-dropbox-ready{position:fixed;right:16px;bottom:16px;z-index:9999;display:flex;flex-direction:column;gap:6px;max-width:460px;background:rgba(25,45,80,.95);color:#eee;border:1px solid rgba(255,255,255,.18);border-radius:10px;padding:10px 12px;font-size:12px;box-shadow:0 4px 14px rgba(0,0,0,.4);pointer-events:auto}\n.dsh-dropbox-ready-title{font-weight:600;color:#fff}\n.dsh-dropbox-ready-note{color:#9ca3af}\n.dsh-dropbox-ready-path{color:#93c5fd;font-family:monospace;font-size:11px;word-break:break-all}\n.dsh-dropbox-ready button{background:#2563eb;border:none;color:#fff;border-radius:5px;padding:3px 8px;font-size:11px;cursor:pointer}\n.dsh-dropbox-ready button:hover{background:#1d4ed8}\n.dsh-dropbox-ready-close{background:transparent !important;color:#9ca3af !important;margin-left:auto}\n')
        const hasFiles = (e) => {
          const types = e.dataTransfer && e.dataTransfer.types
          return !!(types && Array.from(types).includes('Files'))
        }
        const onDragOver = (e) => {
          if (hasFiles(e)) {
            e.preventDefault()
            e.stopPropagation()
            setDragging(true)
          }
        }
        const onDragLeave = (e) => {
          if (hasFiles(e)) {
            e.preventDefault()
            e.stopPropagation()
          }
          if (!e.relatedTarget) setDragging(false)
        }
        const onDrop = (e) => {
          setDragging(false)
          if (!hasFiles(e)) return
          e.preventDefault()
          e.stopPropagation()
          const files = Array.from((e.dataTransfer && e.dataTransfer.files) || [])
          if (files.length === 0) return
          files.forEach((file) => {
            upload(file).then((path) => {
              store.paths = store.paths.concat(path).slice(-16)
              store.pending = true
              emit()
            }).catch((err) => {
              setError(file.name + ': ' + (err && err.message ? err.message : String(err)))
              if (timer) timer.timeout(() => { setError(null) }, 4000)
            })
          })
        }
        document.addEventListener('dragenter', onDragOver, true)
        document.addEventListener('dragover', onDragOver, true)
        document.addEventListener('dragleave', onDragLeave, true)
        document.addEventListener('drop', onDrop, true)
        return () => {
          document.removeEventListener('dragenter', onDragOver, true)
          document.removeEventListener('dragover', onDragOver, true)
          document.removeEventListener('dragleave', onDragLeave, true)
          document.removeEventListener('drop', onDrop, true)
        }
      }, [])

      const children = []
      if (dragging) {
        children.push(React.createElement('div', { key: 'hint', className: 'dsh-dropbox-hint' }, '松开以接收文件，路径将插入输入框'))
      }
      if (error) {
        children.push(React.createElement('div', { key: 'err', className: 'dsh-dropbox-err' }, error))
      }
      if (pendingItems.length > 0) {
        const rows = pendingItems.map((p, i) => {
          const cells = []
          cells.push(React.createElement('div', { key: 'p', className: 'dsh-dropbox-ready-path' }, p))
          cells.push(React.createElement('button', { key: 'c', onClick: () => {
            try { navigator.clipboard.writeText(p) } catch (e2) {}
          } }, '复制'))
          return React.createElement('div', { key: i, className: 'dsh-dropbox-ready-row', style: { display: 'flex', gap: '8px', alignItems: 'center' } }, cells)
        })
        const card = [
          React.createElement('div', { key: 't', className: 'dsh-dropbox-ready-title' }, '文件已就绪（' + pendingItems.length + ' 个）'),
          React.createElement('div', { key: 'n', className: 'dsh-dropbox-ready-note' }, '创建会话后路径将自动插入输入框；也可点复制手动使用'),
          rows,
          React.createElement('button', { key: 'x', className: 'dsh-dropbox-ready-close', onClick: () => { store.paths = []; store.pending = false; emit() } }, '关闭'),
        ]
        children.push(React.createElement('div', { key: 'ready', className: 'dsh-dropbox-ready' }, card))
      }
      return React.createElement('div', { className: 'dsh-dropbox-root' }, children)
    }

    function DockInserter(props) {
      const input = props.useInput ? props.useInput((s) => s) : null
      const ref = React.useRef({ actions: props.inputActions, draft: '', rev: 0 })
      if (input) {
        ref.current.draft = input.draft
        ref.current.rev = input.draftRev
      }
      ref.current.actions = props.inputActions
      React.useEffect(() => {
        function tryInsert() {
          if (!store.pending || store.paths.length === 0) return
          const actions = ref.current.actions
          if (!actions || !actions.setDraft) return
          const text = store.paths.join('\n')
          const draft = ref.current.draft
          const ta = document.activeElement && document.activeElement.tagName === 'TEXTAREA' ? document.activeElement : null
          const pos = ta ? ta.selectionStart : draft.length
          const newDraft = draft.slice(0, pos) + text + draft.slice(pos)
          actions.setDraft(newDraft)
          store.paths = []
          store.pending = false
          emit()
          requestAnimationFrame(() => {
            const el = document.activeElement
            if (el && el.tagName === 'TEXTAREA') {
              try { el.setSelectionRange(pos + text.length, pos + text.length) } catch (e) {}
            }
          })
        }
        // 挂载时立即尝试（覆盖 hero 拖入后创建会话的场景），并订阅后续事件
        tryInsert()
        return subscribe(tryInsert)
      }, [])
      return null
    }

    const slots = ctx.get('slots')
    if (slots === undefined) return
    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'drop-file-to-path-shell' },
      () => React.createElement(ShellDrop, null),
    ))
    slots.inject('conversation.composer.dock', () => slots.register(
      { name: 'conversation.composer.dock', id: 'drop-file-to-path-insert' },
      (props) => React.createElement(DockInserter, props),
    ))
  },
}

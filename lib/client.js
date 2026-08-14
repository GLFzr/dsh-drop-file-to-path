// dsh-drop-file-to-path — Client half (web2 bundle), v2 chip edition.
// Registered via window.__ModuleLoader__.load; the factory materializes the
// cordis plugin object { apply, inject }. Uploads go over fetch to the host
// routes under /api/drop-file-to-path/*.
//
// v2: dropped files land in the composer as ONE reference chip (U+FFFC
// occurrence) instead of raw path text: the chip renders as a whole blue
// unit, the mandatory `.b64` suffix is display-hidden (the real path — suffix
// included — is what gets serialized on submit, copied, and persisted), and
// over-long paths collapse to "…/filename". The chip cell is widened from
// the composer's default 4em to 24em by re-declaring the DshChipCell font
// face (patched advance) AFTER the app's stylesheet, so textarea, caret
// mirror, and backdrop chip all share the same wide advance by construction.
window.__ModuleLoader__.load({
  id: 'dsh-drop-file-to-path',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')

    /** Reference-source name this plugin owns in the trigger pipeline. */
    const SOURCE = 'drop-file-to-path'
    /** Display width up to which the full path shows as-is (CJK counts double); longer ones collapse to …/name. */
    const LABEL_MAX = 44

    const store = {
      items: [], // [{ real, label }] — real carries the on-disk path (with .b64 when encoded)
      pending: false,
      listeners: new Set(),
      services: null, // { conversation, sessions } resolved lazily at apply time
    }
    function subscribe(fn) {
      store.listeners.add(fn)
      return () => { store.listeners.delete(fn) }
    }
    function emit() {
      store.listeners.forEach((fn) => { fn() })
    }

    function api(path, body) {
      return fetch('/api/drop-file-to-path/' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then((r) => r.json().then((j) => {
        if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status))
        return j
      }))
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
      const begin = await api('begin', { name: file.name, size: file.size })
      // Dedupe reuse: the host found an identical dropbox file and returned
      // its path — no chunked upload needed.
      if (begin.path) return { path: begin.path, encoded: begin.encoded === true }
      const token = begin.token
      const CHUNK = 4 * 1024 * 1024
      const count = Math.max(1, Math.ceil(file.size / CHUNK))
      for (let i = 0; i < count; i++) {
        const blob = file.slice(i * CHUNK, Math.min((i + 1) * CHUNK, file.size))
        const dataUrl = await readAsDataURL(blob)
        const base64 = String(dataUrl).split(',')[1] || ''
        await api('chunk', { token, index: i, data: base64 })
      }
      const done = await api('end', { token })
      return done // { path, bytes, encoded }
    }

    /**
     * Approximate display width of one label in half-width units (CJK glyphs
     * count double — they render ~2x wide, so char count alone would let the
     * tail clip past the chip cell).
     */
    function labelWidth(s) {
      let n = 0
      for (const ch of s) n += ch.codePointAt(0) > 0x2e7f ? 2 : 1
      return n
    }

    /**
     * Chip display label: the FILE NAME only (no directory, no `.b64`, no
     * `_1/_2` dedupe numbers). The full on-disk path stays in the occurrence's
     * clipboardText — clicking the chip reveals it (and copies it). Very long
     * names keep their tail with a leading ellipsis.
     * @param path - absolute on-disk path returned by the host.
     * @param encoded - whether the host appended `.b64` (binary file).
     * @param originalName - the dragged file's original name, when the path
     * went through the dropbox (null for direct native-path references).
     */
    function displayLabel(path, encoded, originalName) {
      let base
      if (originalName) {
        base = String(originalName)
      } else {
        base = encoded ? String(path).replace(/\.b64$/i, '') : String(path)
        const i = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'))
        if (i >= 0) base = base.slice(i + 1)
      }
      if (labelWidth(base) <= LABEL_MAX) return base
      return '…' + base.slice(Math.max(0, base.length - (LABEL_MAX - 1)))
    }

    /**
     * Expand every occurrence placeholder (and its NBSP spacers) to its
     * real-path projection — the same walk the composer performs for
     * copy/persistence. Used as the beforeunload safety net so a reloaded
     * draft never restores raw U+FFFC.
     * @param draft - draft text (may hold placeholders).
     * @param occurrences - the machine's occurrence table.
     */
    function projectToRealPath(draft, occurrences) {
      if (occurrences.length === 0) return draft
      let out = ''
      let cursor = 0
      for (const o of occurrences) {
        out += draft.slice(cursor, o.offset) + o.clipboardText
        cursor = o.offset + 1 + o.pad
      }
      return out + draft.slice(cursor)
    }

    /**
     * Measure the label and one NBSP in the composer's font, then compute the
     * NBSP spacer count (`pad`) that widens the chip cell to wrap the label:
     * cell = base (1em) + pad × space width ≈ label width. The pill therefore
     * follows the file name — name first, cell second — instead of the fixed
     * advance.
     * @param label - the chip's display label.
     * @returns the pad count for the reference insertion.
     */
    function padForLabel(label) {
      try {
        const ta = document.querySelector('textarea')
        const cs = ta ? window.getComputedStyle(ta) : null
        const probe = document.createElement('span')
        probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;pointer-events:none;' +
          'font-family:' + (cs ? cs.fontFamily : 'sans-serif') + ';font-size:' + (cs ? cs.fontSize : '14px')
        document.body.appendChild(probe)
        probe.textContent = label
        const labelPx = probe.getBoundingClientRect().width
        probe.textContent = '\u00A0'
        const nbspPx = probe.getBoundingClientRect().width
        document.body.removeChild(probe)
        const basePx = parseFloat(cs ? cs.fontSize : '14') || 14
        if (!(labelPx > 0) || !(nbspPx > 0)) return 0
        return labelPx > basePx ? Math.ceil((labelPx - basePx) / nbspPx) + 1 : 0
      } catch (e) {
        return 0
      }
    }

    const STYLE_ID = 'dsh-drop-file-to-path-style'
    // The patched DshChipCell face: same family as the composer's, declared
    // after it in document order, so every U+FFFC (textarea, mirror, backdrop)
    // resolves the 1em base advance (the NBSP spacers inserted with each chip
    // widen the cell to the label). Regenerate via tools/patch-chip-font.mjs.
    const CHIP_FONT_B64 = 'AAEAAAAKAIAAAwAgT1MvMkT8SmIAAAEoAAAAYGNtYXAADQBPAAABkAAAADRnbHlmAAAAAAAAAcwAAAABaGVhZCwtPGoAAACsAAAANmhoZWEDIg7bAAAA5AAAACRobXR4BdwAAAAAAYgAAAAIbG9jYQAAAAAAAAHEAAAABm1heHAAAwACAAABCAAAACBuYW1lvljk2gAAAdAAAABscG9zdNNweNQAAAI8AAAALQABAAAAAQAAjaS2VV8PPPUAAwPoAAAAAOaLfcUAAAAA5ot9xQAAAAAAAAAAAAAAAwACAAAAAAAAAAEAAAMg/zgAAA+gAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAACAAEAAAACAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAwjKAZAABQAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAPz8/PwAA//z//AMg/zgAAAMgAMgAAAAAAAAAAAAAAAAAAAAgAAAB9AAAA+gAAAAAAAIAAAADAAAAFAADAAEAAAAUAAQAIAAAAAQABAABAAD//P//AAD//P//AAUAAQAAAAAAAAAAAAAAAAAAAAAAAAAEADYAAQAAAAAAAQALAAAAAQAAAAAAAgAHAAsAAwABBAkAAQAWABIAAwABBAkAAgAOAChEc2hDaGlwQ2VsbFJlZ3VsYXIARABzAGgAQwBoAGkAcABDAGUAbABsAFIAZQBnAHUAbABhAHIAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAABAgZvYmpyZXAAAAA='
    const CSS = '\n@font-face{font-family:\'DshChipCell\';src:url(\'data:font/ttf;base64,' + CHIP_FONT_B64 + '\') format(\'truetype\')}\n.dsh-dropbox-hint{position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);color:#fff;font-size:18px;font-weight:600;pointer-events:none;backdrop-filter:blur(2px)}\n.dsh-dropbox-err{position:fixed;right:16px;bottom:96px;z-index:9999;background:rgba(120,30,30,.95);color:#fff;font-size:12px;border-radius:8px;padding:8px 12px;max-width:420px;pointer-events:none;box-shadow:0 4px 14px rgba(0,0,0,.35)}\n.dsh-dropbox-ready{position:fixed;right:16px;bottom:16px;z-index:9999;display:flex;flex-direction:column;gap:6px;max-width:460px;background:rgba(25,45,80,.95);color:#eee;border:1px solid rgba(255,255,255,.18);border-radius:10px;padding:10px 12px;font-size:12px;box-shadow:0 4px 14px rgba(0,0,0,.4);pointer-events:auto}\n.dsh-dropbox-ready-title{font-weight:600;color:#fff}\n.dsh-dropbox-ready-note{color:#9ca3af}\n.dsh-dropbox-ready-path{color:#93c5fd;font-family:monospace;font-size:11px;word-break:break-all}\n.dsh-dropbox-ready button{background:#2563eb;border:none;color:#fff;border-radius:5px;padding:3px 8px;font-size:11px;cursor:pointer}\n.dsh-dropbox-ready button:hover{background:#1d4ed8}\n.dsh-dropbox-ready-close{background:transparent !important;color:#9ca3af !important;margin-left:auto}\n[data-decoration="chip"][data-occurrence]{background:transparent;border-radius:0}\n[data-decoration="chip"] span{color:#93c5fd;width:auto;transform:translate(-50%,-50%);display:block;text-align:center;text-overflow:ellipsis}\n'
    /**
     * Inject (or refresh) the plugin stylesheet. Content-aware: a stale
     * element — e.g. one carrying an older font face after a hot swap, which
     * the id check alone would keep — is replaced in place so the current
     * chip cell always lands. `data-plugin` lets the client HMR driver
     * own the element on entry reloads.
     */
    function ensureStyle() {
      let el = document.getElementById(STYLE_ID)
      if (el) {
        if (el.textContent === CSS) return
        el.textContent = CSS
        return
      }
      el = document.createElement('style')
      el.id = STYLE_ID
      el.setAttribute('data-plugin', 'dsh-drop-file-to-path')
      el.textContent = CSS
      document.head.appendChild(el)
    }

    function ShellDrop() {
      const [dragging, setDragging] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [pendingItems, setPendingItems] = React.useState([])
      React.useEffect(() => subscribe(() => { setPendingItems(store.items.slice()) }), [])
      React.useEffect(() => {
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
          // OS file drags in Chromium expose the source path via the entry
          // API — reference it directly instead of copying the file into the
          // dropbox (no duplicate storage, no _1/_2 name collisions). Items
          // of kind 'file' line up with files[] in drag order.
          const fileItems = Array.from((e.dataTransfer && e.dataTransfer.items) || [])
            .filter((it) => it.kind === 'file')
          const nativePathAt = (i) => {
            try {
              const item = fileItems[i]
              if (!item || typeof item.webkitGetAsEntry !== 'function') return null
              const entry = item.webkitGetAsEntry()
              if (!entry || entry.isDirectory) return null
              let p = String(entry.fullPath || '')
              // Chromium on Windows reports "/C:/Users/..." — drop the leading slash.
              if (p.startsWith('/')) p = p.slice(1)
              return /^[A-Za-z]:[\\/]/.test(p) ? p : null
            } catch (e2) {
              return null
            }
          }
          files.forEach((file, i) => {
            const native = nativePathAt(i)
            if (native !== null) {
              store.items = store.items.concat({
                real: native,
                label: displayLabel(native, false, null),
              }).slice(-16)
              store.pending = true
              emit()
              return
            }
            upload(file).then((done) => {
              store.items = store.items.concat({
                real: done.path,
                label: displayLabel(done.path, done.encoded, file.name),
              }).slice(-16)
              store.pending = true
              emit()
            }).catch((err) => {
              setError(file.name + ': ' + (err && err.message ? err.message : String(err)))
              setTimeout(() => { setError(null) }, 4000)
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
          cells.push(React.createElement('div', { key: 'p', className: 'dsh-dropbox-ready-path' }, p.label))
          cells.push(React.createElement('button', { key: 'c', onClick: () => {
            try { navigator.clipboard.writeText(p.real) } catch (e2) {}
          } }, '复制'))
          return React.createElement('div', { key: i, className: 'dsh-dropbox-ready-row', style: { display: 'flex', gap: '8px', alignItems: 'center' } }, cells)
        })
        const card = [
          React.createElement('div', { key: 't', className: 'dsh-dropbox-ready-title' }, '文件已就绪（' + pendingItems.length + ' 个）'),
          React.createElement('div', { key: 'n', className: 'dsh-dropbox-ready-note' }, '将作为蓝色整体路径插入输入框（.b64 不显示）；也可点复制手动使用'),
          rows,
          React.createElement('button', { key: 'x', className: 'dsh-dropbox-ready-close', onClick: () => { store.items = []; store.pending = false; emit() } }, '关闭'),
        ]
        children.push(React.createElement('div', { key: 'ready', className: 'dsh-dropbox-ready' }, card))
      }
      return React.createElement('div', { className: 'dsh-dropbox-root' }, children)
    }

    /**
     * Insert one dropped file as a reference chip at `pos` (whole-unit
     * placeholder + NBSP spacers + occurrence; the real path serializes on
     * submit). The spacer count is measured against the composer font so the
     * pill width follows the label width.
     * @param input - the live per-session input facade (SessionInput).
     * @param item - { real, label } of the dropped file.
     * @param pos - draft offset for the chip.
     * @returns the inserted length (0 = not applied).
     */
    function insertChip(input, item, pos) {
      const st = input.state.getSnapshot()
      if (st.phase !== 'plain' && st.phase !== 'claimed') return 0
      const before = st.draft.length
      const ok = input.insertReference(
        { source: SOURCE, ref: item.real, label: item.label, clipboardText: item.real, pad: padForLabel(item.label) },
        { start: pos, end: pos, draftRev: st.draftRev },
      )
      return ok ? input.state.getSnapshot().draft.length - before : 0
    }

    function DockInserter(props) {
      const input = props.useInput ? props.useInput((s) => s) : null
      const sessionId = props.sessionId
      const ref = React.useRef({ actions: props.inputActions, draft: '', rev: 0, occurrences: [] })
      if (input) {
        ref.current.draft = input.draft
        ref.current.rev = input.draftRev
        ref.current.occurrences = input.occurrences
      }
      ref.current.actions = props.inputActions
      React.useEffect(() => {
        function caretPos() {
          const ta = document.activeElement && document.activeElement.tagName === 'TEXTAREA' ? document.activeElement : null
          return ta ? ta.selectionStart : ref.current.draft.length
        }
        function insertPlainText() {
          const actions = ref.current.actions
          if (!actions || !actions.setDraft) return
          const text = store.items.map(item => item.real).join('\n')
          const draft = ref.current.draft
          const pos = caretPos()
          actions.setDraft(draft.slice(0, pos) + text + draft.slice(pos))
          store.items = []
          store.pending = false
          emit()
          requestAnimationFrame(() => {
            const el = document.activeElement
            if (el && el.tagName === 'TEXTAREA') {
              try { el.setSelectionRange(pos + text.length, pos + text.length) } catch (e) {}
            }
          })
        }
        function tryInsert() {
          if (!store.pending || store.items.length === 0) return
          if (!store.resolveServices || !sessionId) { insertPlainText(); return }
          const services = store.resolveServices()
          if (!services.conversation || !services.sessions || !services.conversation.input) { insertPlainText(); return }
          const actx = services.sessions.scope(sessionId)
          if (!actx) return // scope not materialized yet; retry on next emit
          const input = services.conversation.input.for(actx)
          if (!input || !input.insertReference) { insertPlainText(); return }
          let pos = caretPos()
          let insertedAny = false
          let i = 0
          for (; i < store.items.length; i++) {
            const inserted = insertChip(input, store.items[i], pos)
            if (inserted === 0) break
            insertedAny = true
            pos += inserted
          }
          // Busy phase / stale span: keep everything pending and wait for the
          // next emit — emitting here would loop forever without progress.
          if (!insertedAny) return
          store.items = store.items.slice(i)
          if (store.items.length === 0) store.pending = false
          emit()
          requestAnimationFrame(() => {
            const el = document.activeElement
            if (el && el.tagName === 'TEXTAREA') {
              try { el.setSelectionRange(pos, pos) } catch (e) {}
            }
          })
        }
        // Mount-time attempt (hero drop → session created → composer mounts)
        // plus every subsequent emit.
        tryInsert()
        return subscribe(tryInsert)
      }, [])
      // Reload safety net: chips live in the machine's occurrence table, which
      // is not persisted — flatten any pending chips to real path text so a
      // restored draft never carries raw U+FFFC placeholders.
      React.useEffect(() => {
        const onUnload = () => {
          if (ref.current.occurrences.length === 0) return
          const actions = ref.current.actions
          if (!actions || !actions.setDraft) return
          actions.setDraft(projectToRealPath(ref.current.draft, ref.current.occurrences))
        }
        window.addEventListener('beforeunload', onUnload)
        return () => { window.removeEventListener('beforeunload', onUnload) }
      }, [])
      return null
    }

    exports.apply = function apply(ctx) {
      // Chip serialization rides the trigger pipeline: the submit path expands
      // each occurrence via the owning source's codec, so the source MUST be
      // registered under the same name the chips carry. The empty candidate
      // roll keeps it invisible in the '/' and '@' menus.
      const inputTriggers = ctx.get('inputTriggers')
      ctx.effect(() => inputTriggers.registerSource({
        trigger: '@',
        name: SOURCE,
        candidates: () => Promise.resolve([]),
        onPick: () => undefined,
        codec: {
          clipboardText: (ref) => ref,
          serialize: (ref) => Promise.resolve(ref),
        },
      }), 'dsh-drop-file-to-path: chip source')
      // conversation/sessions resolve lazily per insert: the dock only exists
      // once the session composer is up, so both are present by then even if
      // they registered after this fiber applied.
      store.resolveServices = () => ({
        conversation: ctx.get('conversation'),
        sessions: ctx.get('sessions'),
      })
      const slots = ctx.get('slots')
      ensureStyle()
      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'drop-file-to-path-shell' },
        () => React.createElement(ShellDrop, null),
      ))
      slots.inject('conversation.composer.dock', () => slots.register(
        { name: 'conversation.composer.dock', id: 'drop-file-to-path-insert' },
        (props) => React.createElement(DockInserter, props),
      ))
    }
    // Wait for the trigger pipeline and the slot system before activating: the
    // chip source registration must land before any submit can serialize, and
    // the slots are where the drop UI mounts. Both are core web-bundle services.
    exports.inject = ['inputTriggers', 'slots']

    return module.exports
  },
})

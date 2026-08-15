// dsh-file-upload — Client half (web2 bundle), v2.1.0 chip edition.
// Registered via window.__ModuleLoader__.load; the factory materializes the
// cordis plugin object { apply, inject }. Uploads go over fetch to the host
// routes under /api/file-upload/*.
//
// v2.1.0 changes:
//  - begin() sends File.lastModified so the host fast-path never reuses a
//    same-size file that was edited (P1).
//  - a failed upload aborts the host job immediately instead of leaving it
//    to the 10-minute timeout (P3).
//  - dropped files carry a drop-order counter and are inserted in DRAG order,
//    not completion order (P5); the 16-item cap that silently dropped early
//    files is gone (P4).
//  - a chip insert that fails because the composer is busy retries on a
//    timer instead of waiting for an emit that may never come (P6).
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
  id: 'dsh-file-upload',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')

    /** Reference-source name this plugin owns in the trigger pipeline. */
    const SOURCE = 'file-upload'
    /** Display width up to which the full path shows as-is (CJK counts double); longer ones collapse to …/name. */
    const LABEL_MAX = 44

    const store = {
      items: [], // [{ real, label, order }] — real carries the on-disk path (with .b64 when encoded)
      pending: false,
      uploading: 0, // in-flight drops; > 0 keeps the ring alive
      spinnerShownAt: 0, // last showSpinner() timestamp (minimum display time)
      listeners: new Set(),
      services: null, // { conversation, sessions } resolved lazily at apply time
    }
    // Drop-order counter: chips are inserted in drag order (P5).
    let orderSeq = 0
    function subscribe(fn) {
      store.listeners.add(fn)
      return () => { store.listeners.delete(fn) }
    }
    function emit() {
      store.listeners.forEach((fn) => { fn() })
    }

    function api(path, body) {
      return fetch('/api/file-upload/' + path, {
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
      const begin = await api('begin', { name: file.name, size: file.size, lastModified: file.lastModified || 0 })
      // Fast-path reuse: the host only reuses when the manifest records the
      // same source lastModified — an edited same-size file falls through here
      // and end() decides by content hash (P1).
      if (begin.path) return { path: begin.path, encoded: begin.encoded === true }
      const token = begin.token
      try {
        // 4194303 is a multiple of 3: every full chunk encodes to padding-free
        // base64, so the concatenated stream decodes to the exact original bytes
        // (a 4MiB chunk would embed '==' mid-stream and truncate the decode).
        const CHUNK = 4 * 1024 * 1024 - 1
        const count = Math.max(1, Math.ceil(file.size / CHUNK))
        for (let i = 0; i < count; i++) {
          const blob = file.slice(i * CHUNK, Math.min((i + 1) * CHUNK, file.size))
          const dataUrl = await readAsDataURL(blob)
          const base64 = String(dataUrl).split(',')[1] || ''
          await api('chunk', { token, index: i, data: base64 })
        }
        // The host verifies chunk integrity and byte-for-byte dedupes against the
        // dropbox at end; a reused file returns its existing path (no new copy).
        const done = await api('end', { token })
        return done // { path, bytes, encoded }
      } catch (err) {
        // Never leave the host job holding uploaded chunks until the 10-minute
        // timeout: release it right away (P3).
        api('abort', { token }).catch(() => {})
        throw err
      }
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
        // `pad` is a composer extension: on a stock DSH without it the
        // occurrence has no spacers and the range is exactly [offset, offset+1).
        cursor = o.offset + 1 + (Number.isFinite(o.pad) ? o.pad : 0)
      }
      return out + draft.slice(cursor)
    }

    // Imperative ring element, fixed to the document body at the measured
    // insertion point (or the input box's left edge when measurement fails).
    // No React, no slot, no subscription.
    let ringEl = null
    function ensureRingEl() {
      if (ringEl && ringEl.isConnected) return ringEl
      ringEl = document.createElement('div')
      ringEl.className = 'dsh-dropbox-spinner-wrap'
      const ring = document.createElement('div')
      ring.className = 'dsh-dropbox-spinner'
      ringEl.appendChild(ring)
      return ringEl
    }

    /**
     * Viewport point where the next chip will land: the active textarea's
     * caret when focused, else the draft end — i.e. right after the last
     * paragraph the user typed. Measured on the composer's OWN mirror layer
     * (`[data-input-mirror]`): it shares the textarea's font, width, padding
     * and scroll container by construction, so a Range on its text node lands
     * exactly where the textarea caret would be. Falls back to the input
     * box's content left edge when no mirror/textarea exists.
     * @returns { x, y } viewport px, never null.
     */
    function measureInsertPoint() {
      const ta = document.activeElement && document.activeElement.tagName === 'TEXTAREA'
        ? document.activeElement
        : (document.querySelector('textarea[data-phase]') || document.querySelector('textarea'))
      const fallback = () => {
        if (ta) {
          const r = ta.getBoundingClientRect()
          const cs = window.getComputedStyle(ta)
          return {
            x: r.left + parseFloat(cs.paddingLeft || 0),
            y: r.top + parseFloat(cs.paddingTop || 0) + 10,
          }
        }
        return { x: window.innerWidth / 2, y: window.innerHeight / 2 }
      }
      if (!ta) return fallback()
      const offset = document.activeElement && document.activeElement.tagName === 'TEXTAREA'
        ? (document.activeElement.selectionStart || 0)
        : ta.value.length
      const mirror = document.querySelector('[data-input-mirror]')
      if (mirror && mirror.firstChild) {
        try {
          const node = mirror.firstChild
          const at = Math.min(offset, node.length)
          const range = document.createRange()
          range.setStart(node, at)
          range.setEnd(node, at)
          const rect = range.getBoundingClientRect()
          if (rect && (rect.width > 0 || rect.height > 0)) {
            return { x: rect.left, y: rect.top + rect.height / 2 }
          }
        } catch (e) {
          // fall through to the input-box-left fallback
        }
      }
      return fallback()
    }

    /** Delay before the ring appears: uploads finishing within this window
     * (tiny files, begin fast-path reuse) never show a ring at all. */
    const SPINNER_DELAY_MS = 150
    let spinnerTimer = null

    /**
     * Arm the waiting ring for a drop that is about to upload. The ring only
     * materializes after SPINNER_DELAY_MS — if the upload (or the fast-path
     * reuse) settles first, hideSpinner() cancels it and nothing ever shows,
     * so instant paths stay silent while real waits get the animation at the
     * measured insertion point (right after the caret / last paragraph).
     */
    function scheduleSpinner(fileName) {
      store.uploading += 1
      const el = ensureRingEl()
      let pt = null
      try {
        pt = measureInsertPoint()
      } catch (e) {
        pt = null
      }
      if (!pt) {
        pt = { x: window.innerWidth / 2, y: window.innerHeight / 2 }
      }
      clearTimeout(spinnerTimer)
      spinnerTimer = setTimeout(() => {
        if (store.uploading <= 0) return // settled before the delay — never show
        // Center the ring one character PAST the insertion point (the "second
        // character" slot): centered on the caret itself, half the ring would
        // cover the last typed character.
        const ta = document.activeElement && document.activeElement.tagName === 'TEXTAREA'
          ? document.activeElement
          : (document.querySelector('textarea[data-phase]') || document.querySelector('textarea'))
        const fs = ta ? (parseFloat(window.getComputedStyle(ta).fontSize) || 14) : 14
        el.classList.remove('in-box')
        el.style.left = (pt.x + fs - 8) + 'px'
        el.style.top = (pt.y - 8) + 'px'
        if (!el.isConnected) document.body.appendChild(el)
      }, SPINNER_DELAY_MS)
    }

    /** Release one drop's hold: the ring vanishes the instant the upload
     * settles — by then the chip has been inserted (or the error shown), so
     * the ring never outlives the file it was waiting for. */
    function hideSpinner() {
      store.uploading -= 1
      if (store.uploading <= 0) {
        store.uploading = 0
        clearTimeout(spinnerTimer)
        if (ringEl && ringEl.isConnected) ringEl.remove()
      }
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

    const STYLE_ID = 'dsh-file-upload-style'
    // The patched DshChipCell face: same family as the composer's, declared
    // after it in document order, so every U+FFFC (textarea, mirror, backdrop)
    // resolves the 1em base advance (the NBSP spacers inserted with each chip
    // widen the cell to the label). Regenerate via tools/patch-chip-font.mjs.
    const CHIP_FONT_B64 = 'AAEAAAAKAIAAAwAgT1MvMkT8SmIAAAEoAAAAYGNtYXAADQBPAAABkAAAADRnbHlmAAAAAAAAAcwAAAABaGVhZCwtPGoAAACsAAAANmhoZWEDIg7bAAAA5AAAACRobXR4BdwAAAAAAYgAAAAIbG9jYQAAAAAAAAHEAAAABm1heHAAAwACAAABCAAAACBuYW1lvljk2gAAAdAAAABscG9zdNNweNQAAAI8AAAALQABAAAAAQAAjaS2VV8PPPUAAwPoAAAAAOaLfcUAAAAA5ot9xQAAAAAAAAAAAAAAAwACAAAAAAAAAAEAAAMg/zgAAA+gAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAACAAEAAAACAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAwjKAZAABQAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAPz8/PwAA//z//AMg/zgAAAMgAMgAAAAAAAAAAAAAAAAAAAAgAAAB9AAAA+gAAAAAAAIAAAADAAAAFAADAAEAAAAUAAQAIAAAAAQABAABAAD//P//AAD//P//AAUAAQAAAAAAAAAAAAAAAAAAAAAAAAAEADYAAQAAAAAAAQALAAAAAQAAAAAAAgAHAAsAAwABBAkAAQAWABIAAwABBAkAAgAOAChEc2hDaGlwQ2VsbFJlZ3VsYXIARABzAGgAQwBoAGkAcABDAGUAbABsAFIAZQBnAHUAbABhAHIAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAABAgZvYmpyZXAAAAA='
    const CSS = '\n@font-face{font-family:\'DshChipCell\';src:url(\'data:font/ttf;base64,' + CHIP_FONT_B64 + '\') format(\'truetype\')}\n.dsh-dropbox-hint{position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);color:#fff;font-size:18px;font-weight:600;pointer-events:none;backdrop-filter:blur(2px)}\n.dsh-dropbox-err{position:fixed;right:16px;bottom:96px;z-index:9999;background:rgba(120,30,30,.95);color:#fff;font-size:12px;border-radius:8px;padding:8px 12px;max-width:420px;pointer-events:none;box-shadow:0 4px 14px rgba(0,0,0,.35)}\n.dsh-dropbox-spinner-wrap{position:fixed;z-index:9998;pointer-events:none}\n.dsh-dropbox-spinner{width:16px;height:16px;border-radius:50%;background:conic-gradient(from 0deg,rgba(77,107,254,0) 0deg,rgba(77,107,254,0) 70deg,#4d6bfe 250deg,rgba(77,107,254,0) 360deg);-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 2px),#000 calc(100% - 2px));mask:radial-gradient(farthest-side,transparent calc(100% - 2px),#000 calc(100% - 2px));filter:drop-shadow(0 0 3px rgba(77,107,254,.7));animation:dsh-dropbox-spin .85s linear infinite}\n@keyframes dsh-dropbox-spin{to{transform:rotate(360deg)}}\n.dsh-dropbox-ready{position:fixed;right:16px;bottom:16px;z-index:9999;display:flex;flex-direction:column;gap:6px;max-width:460px;background:rgba(25,45,80,.95);color:#eee;border:1px solid rgba(255,255,255,.18);border-radius:10px;padding:10px 12px;font-size:12px;box-shadow:0 4px 14px rgba(0,0,0,.4);pointer-events:auto}\n.dsh-dropbox-ready-title{font-weight:600;color:#fff}\n.dsh-dropbox-ready-note{color:#9ca3af}\n.dsh-dropbox-ready-path{color:#93c5fd;font-family:monospace;font-size:11px;word-break:break-all}\n.dsh-dropbox-ready button{background:#2563eb;border:none;color:#fff;border-radius:5px;padding:3px 8px;font-size:11px;cursor:pointer}\n.dsh-dropbox-ready button:hover{background:#1d4ed8}\n.dsh-dropbox-ready-close{background:transparent !important;color:#9ca3af !important;margin-left:auto}\n[data-decoration="chip"][data-occurrence]{background:transparent;border-radius:0}\n[data-decoration="chip"] span{color:#93c5fd;width:auto;transform:translate(-50%,-50%);display:block;text-align:center;text-overflow:ellipsis}\n.dsh-dropbox-clean{display:flex;flex-direction:column;gap:12px;max-width:680px}\n.dsh-dropbox-clean-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}\n.dsh-dropbox-clean-total{font-weight:600;color:var(--dsw-alias-label-primary,#e5e7eb)}\n.dsh-dropbox-clean-err{color:#f87171;font-size:12px}\n.dsh-dropbox-clean-list{display:flex;flex-direction:column;gap:4px;max-height:360px;overflow:auto;border:1px solid var(--dsw-alias-border-default,rgba(255,255,255,.14));border-radius:8px;padding:8px;background:var(--dsw-alias-surface-2,rgba(255,255,255,.03))}\n.dsh-dropbox-clean-row{display:flex;align-items:center;gap:8px;font-size:12px}\n.dsh-dropbox-clean-name{font-family:monospace;word-break:break-all;flex:1;color:var(--dsw-alias-label-primary,#e5e7eb)}\n.dsh-dropbox-clean-size{color:var(--dsw-alias-label-secondary,#9ca3af);white-space:nowrap}\n.dsh-dropbox-clean-time{color:var(--dsw-alias-label-tertiary,#6b7280);white-space:nowrap;font-size:11px}\n.dsh-dropbox-clean-tag{font-size:10px;padding:1px 6px;border-radius:4px;white-space:nowrap}\n.dsh-dropbox-clean-tag-dup{background:rgba(216,97,97,.25);color:#fca5a5}\n.dsh-dropbox-clean-tag-b64{background:rgba(97,135,216,.25);color:#93c5fd}\n.dsh-dropbox-clean-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}\n.dsh-dropbox-clean button{background:#2563eb;border:none;color:#fff;border-radius:5px;padding:5px 12px;font-size:12px;cursor:pointer}\n.dsh-dropbox-clean button:hover{background:#1d4ed8}\n.dsh-dropbox-clean button:disabled{opacity:.5;cursor:default}\n.dsh-dropbox-clean button.danger{background:rgba(180,40,40,.9)}\n.dsh-dropbox-clean button.danger:hover{background:rgba(160,30,30,.95)}\n.dsh-dropbox-clean button.ghost{background:transparent;border:1px solid var(--dsw-alias-border-default,rgba(255,255,255,.25));color:var(--dsw-alias-label-secondary,#d1d5db)}\n.dsh-dropbox-clean button.ghost:hover{background:rgba(255,255,255,.06)}\n.dsh-dropbox-clean input{background:var(--dsw-alias-surface-1,#111827);border:1px solid var(--dsw-alias-border-default,rgba(255,255,255,.2));color:var(--dsw-alias-label-primary,#e5e7eb);border-radius:5px;padding:4px 8px;font-size:12px;width:90px}\n.dsh-dropbox-clean-confirm{background:rgba(120,30,30,.35);border:1px solid rgba(248,113,113,.4);border-radius:8px;padding:10px 12px;font-size:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}\n.dsh-dropbox-clean-empty{color:var(--dsw-alias-label-tertiary,#6b7280);font-size:12px}\n.dsh-dropbox-sidebar-action{position:relative;display:flex;align-items:center;justify-content:center;width:28px;height:28px;margin:2px auto;background:transparent;border:none;border-radius:6px;color:var(--dsw-alias-label-secondary,#9ca3af);cursor:pointer}\n.dsh-dropbox-sidebar-action:hover{background:rgba(255,255,255,.1);color:var(--dsw-alias-label-primary,#e5e7eb)}\n.dsh-dropbox-sidebar-action:hover::after{content:"清理 Dropbox";position:absolute;left:calc(100% + 10px);top:50%;transform:translateY(-50%);background:rgba(17,24,39,.95);color:#e5e7eb;font-size:12px;padding:4px 9px;border-radius:6px;white-space:nowrap;z-index:10001;pointer-events:none;box-shadow:0 2px 10px rgba(0,0,0,.4)}\n.dsh-dropbox-clean-pop{position:fixed;right:16px;bottom:16px;z-index:10000;width:580px;max-width:calc(100vw - 32px);max-height:75vh;overflow:auto;background:var(--dsw-alias-surface-2,#1f2937);border:1px solid var(--dsw-alias-border-default,rgba(255,255,255,.18));border-radius:12px;padding:14px;box-shadow:0 8px 30px rgba(0,0,0,.5);display:flex;flex-direction:column;gap:12px}\n.dsh-dropbox-clean-pop-foot{display:flex;justify-content:flex-end}\n'
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
      el.setAttribute('data-plugin', 'dsh-file-upload')
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
            const order = orderSeq++ // drag order (P5)
            const native = nativePathAt(i)
            if (native !== null) {
              // Native path: nothing to wait for — insert immediately, no
              // ring (instant paths stay silent; the chip IS the feedback).
              store.items = store.items.concat({
                real: native,
                label: displayLabel(native, false, null),
                order,
              })
              store.pending = true
              emit()
              return
            }
            // Fallback upload: arm the ring (delayed 150ms — tiny files and
            // begin fast-path reuse settle before it ever shows; real
            // uploads get the ring for the whole begin→chunk→end span).
            scheduleSpinner(file.name)
            upload(file).then((done) => {
              store.items = store.items.concat({
                real: done.path,
                label: displayLabel(done.path, done.encoded, file.name),
                order,
              })
              store.pending = true
              emit()
            }).catch((err) => {
              setError(file.name + ': ' + (err && err.message ? err.message : String(err)))
              setTimeout(() => { setError(null) }, 4000)
            }).finally(() => {
              hideSpinner()
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
        children.push(React.createElement('div', { key: 'hint', className: 'dsh-dropbox-hint' }, '松开以接收文件'))
      }
      if (error) {
        children.push(React.createElement('div', { key: 'err', className: 'dsh-dropbox-err' }, error))
      }
      if (pendingItems.length > 0) {
        const rows = pendingItems.map((p, i) => {
          return React.createElement('div', { key: i, className: 'dsh-dropbox-ready-row', style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            React.createElement('div', { key: 'p', className: 'dsh-dropbox-ready-path' }, p.label))
        })
        const card = [
          React.createElement('div', { key: 't', className: 'dsh-dropbox-ready-title' }, '文件已就绪（' + pendingItems.length + ' 个）· v2.1.0'),
          React.createElement('div', { key: 'n', className: 'dsh-dropbox-ready-note' }, '将作为文件引用插入输入框（agent 可直接读取）'),
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
          // Fallback path (no conversation services): insert in drag order too.
          const text = store.items.slice().sort((x, y) => (x.order || 0) - (y.order || 0)).map(item => item.real).join('\n')
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
        let retryTimer = null
        function tryInsert() {
          if (!store.pending || store.items.length === 0) return
          if (!store.resolveServices || !sessionId) { insertPlainText(); return }
          const services = store.resolveServices()
          if (!services.conversation || !services.sessions || !services.conversation.input) { insertPlainText(); return }
          const actx = services.sessions.scope(sessionId)
          if (!actx) return // scope not materialized yet; retry on next emit
          const input = services.conversation.input.for(actx)
          if (!input || !input.insertReference) { insertPlainText(); return }
          // Insert in DRAG order: parallel uploads complete out of order, the
          // order counter restores the user's sequence (P5).
          const ordered = store.items.slice().sort((x, y) => (x.order || 0) - (y.order || 0))
          let pos = caretPos()
          let insertedAny = false
          let i = 0
          for (; i < ordered.length; i++) {
            const inserted = insertChip(input, ordered[i], pos)
            if (inserted === 0) break
            insertedAny = true
            pos += inserted
          }
          // Busy phase / stale span: keep everything pending and retry on a
          // timer — the next emit may never come for a single-file drop (P6).
          if (!insertedAny) {
            clearTimeout(retryTimer)
            retryTimer = setTimeout(() => {
              if (store.pending && store.items.length > 0) tryInsert()
            }, 400)
            return
          }
          const insertedSet = new Set(ordered.slice(0, i))
          store.items = store.items.filter((it) => !insertedSet.has(it))
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
        const unsubscribe = subscribe(tryInsert)
        return () => { clearTimeout(retryTimer); unsubscribe() }
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

    /**
     * Settings page ("Dropbox 清理"): inventory the dropbox and offer three
     * cleanup modes — redundant `_N` copies, files above a size threshold, or
     * everything. Every destructive action goes through an inline confirm that
     * states the exact file count and freed space, and warns that paths
     * referenced by past chats go stale. Data comes straight from the host
     * routes (/api/file-upload/list|clean), no composer involvement.
     */
    function fmtBytes(n) {
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
      if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
      return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
    }
    function fmtTime(ms) {
      const d = new Date(ms)
      const p = (x) => String(x).padStart(2, '0')
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    }

    function DropboxCleanupSection() {
      const [data, setData] = React.useState({ loading: true, files: [], totalBytes: 0, error: null })
      const [confirm, setConfirm] = React.useState(null) // { mode, minSizeBytes, label, count, bytes, pending }
      const [threshold, setThreshold] = React.useState('100')
      const load = () => {
        setData((s) => ({ ...s, loading: true, error: null }))
        fetch('/api/file-upload/list', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }).then((r) => r.json()).then((j) => {
          if (j.error) throw new Error(j.error)
          setData({ loading: false, files: j.files || [], totalBytes: j.totalBytes || 0, error: null })
        }).catch((e) => {
          setData({ loading: false, files: [], totalBytes: 0, error: e && e.message ? e.message : String(e) })
        })
      }
      React.useEffect(load, [])
      const duplicates = data.files.filter((f) => f.duplicate)
      const dupeBytes = duplicates.reduce((n, f) => n + f.size, 0)
      const runClean = () => {
        if (!confirm || confirm.pending) return
        setConfirm({ ...confirm, pending: true })
        fetch('/api/file-upload/clean', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: confirm.mode, minSizeBytes: confirm.minSizeBytes }),
        }).then((r) => r.json()).then((j) => {
          if (j.error) throw new Error(j.error)
          setConfirm(null)
          load()
        }).catch((e) => {
          setConfirm(null)
          setData((s) => ({ ...s, error: e && e.message ? e.message : String(e) }))
        })
      }
      const children = []
      children.push(React.createElement('div', { key: 'head', className: 'dsh-dropbox-clean-head' },
        React.createElement('span', { key: 't', className: 'dsh-dropbox-clean-total' },
          'Dropbox 文件共 ' + data.files.length + ' 个，占用 ' + fmtBytes(data.totalBytes)),
        React.createElement('button', { key: 'r', className: 'ghost', onClick: load, disabled: data.loading }, '刷新'),
      ))
      if (data.error) {
        children.push(React.createElement('div', { key: 'err', className: 'dsh-dropbox-clean-err' }, data.error))
      }
      if (!data.loading && data.files.length > 0) {
        const rows = data.files.map((f) => {
          const tags = []
          if (f.duplicate) tags.push(React.createElement('span', { key: 'd', className: 'dsh-dropbox-clean-tag dsh-dropbox-clean-tag-dup' }, '冗余副本'))
          if (f.encoded) tags.push(React.createElement('span', { key: 'b', className: 'dsh-dropbox-clean-tag dsh-dropbox-clean-tag-b64' }, 'b64'))
          return React.createElement('div', { key: f.name, className: 'dsh-dropbox-clean-row' },
            React.createElement('span', { key: 'n', className: 'dsh-dropbox-clean-name' }, f.name),
            React.createElement('span', { key: 's', className: 'dsh-dropbox-clean-size' }, fmtBytes(f.size)),
            React.createElement('span', { key: 'm', className: 'dsh-dropbox-clean-time' }, fmtTime(f.mtime)),
            tags,
          )
        })
        children.push(React.createElement('div', { key: 'list', className: 'dsh-dropbox-clean-list' }, rows))
      } else if (!data.loading) {
        children.push(React.createElement('div', { key: 'empty', className: 'dsh-dropbox-clean-empty' }, 'Dropbox 是空的'))
      }
      const actions = []
      if (duplicates.length > 0) {
        actions.push(React.createElement('button', {
          key: 'dup',
          onClick: () => setConfirm({ mode: 'duplicates', minSizeBytes: 0, label: '冗余副本', count: duplicates.length, bytes: dupeBytes, pending: false }),
        }, '清理冗余副本（' + duplicates.length + ' 个，' + fmtBytes(dupeBytes) + '）'))
      }
      actions.push(React.createElement('button', {
        key: 'size',
        className: 'ghost',
        onClick: () => {
          const mb = parseFloat(threshold)
          if (!(mb > 0)) return
          const hit = data.files.filter((f) => f.size >= mb * 1024 * 1024)
          setConfirm({ mode: 'largerThan', minSizeBytes: mb * 1024 * 1024, label: '大于 ' + mb + ' MB', count: hit.length, bytes: hit.reduce((n, f) => n + f.size, 0), pending: false })
        },
      }, '清理大于'))
      actions.push(React.createElement('input', {
        key: 'mb',
        value: threshold,
        onChange: (e) => setThreshold(e.target.value),
        placeholder: 'MB',
      }))
      if (data.files.length > 0) {
        actions.push(React.createElement('button', {
          key: 'all',
          className: 'danger',
          onClick: () => setConfirm({ mode: 'all', minSizeBytes: 0, label: '全部文件', count: data.files.length, bytes: data.totalBytes, pending: false }),
        }, '清空全部'))
      }
      children.push(React.createElement('div', { key: 'actions', className: 'dsh-dropbox-clean-actions' }, actions))
      if (confirm) {
        children.push(React.createElement('div', { key: 'confirm', className: 'dsh-dropbox-clean-confirm' },
          React.createElement('span', { key: 'msg' }, '将删除 ' + confirm.label + '：' + confirm.count + ' 个文件，释放 ' + fmtBytes(confirm.bytes) + '。清理后历史会话引用的路径会失效。'),
          React.createElement('button', { key: 'ok', onClick: runClean, disabled: confirm.pending }, confirm.pending ? '删除中…' : '确认删除'),
          React.createElement('button', { key: 'no', className: 'ghost', onClick: () => setConfirm(null), disabled: confirm.pending }, '取消'),
        ))
      }
      return React.createElement('div', { className: 'dsh-dropbox-clean' }, children)
    }

    /**
     * Sidebar foot action: a single line-art trash icon above the Settings
     * icon; hovering shows the "清理 Dropbox" tooltip. Click opens the cleanup
     * panel as an overlay pop (reuses DropboxCleanupSection wholesale).
     */
    function SidebarCleanupAction() {
      const [open, setOpen] = React.useState(false)
      const trashSvg = React.createElement('svg', {
        key: 'i',
        width: 16,
        height: 16,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      },
        React.createElement('path', { key: 'a', d: 'M3 6h18' }),
        React.createElement('path', { key: 'b', d: 'M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2' }),
        React.createElement('path', { key: 'c', d: 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6' }),
        React.createElement('path', { key: 'd', d: 'M10 11v6' }),
        React.createElement('path', { key: 'e', d: 'M14 11v6' }),
      )
      const btn = React.createElement('button', {
        key: 'b',
        className: 'dsh-dropbox-sidebar-action',
        'aria-label': '清理 Dropbox',
        onClick: () => setOpen(!open),
      }, trashSvg)
      if (!open) return btn
      return React.createElement(React.Fragment, null,
        btn,
        React.createElement('div', { key: 'p', className: 'dsh-dropbox-clean-pop' },
          React.createElement(DropboxCleanupSection, null),
          React.createElement('div', { key: 'f', className: 'dsh-dropbox-clean-pop-foot' },
            React.createElement('button', { key: 'x', className: 'ghost', onClick: () => setOpen(false) }, '关闭'),
          ),
        ),
      )
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
      }), 'dsh-file-upload: chip source')
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
        { name: 'shell.overlay', id: 'file-upload-shell' },
        () => React.createElement(ShellDrop, null),
      ))
      slots.inject('conversation.composer.dock', () => slots.register(
        { name: 'conversation.composer.dock', id: 'file-upload-insert' },
        (props) => React.createElement(DockInserter, props),
      ))
      // Sidebar foot: "清理 Dropbox" stacked above the Settings icon (the
      // shell renders sidebar.footer.action above sidebar.settings). The pop
      // reuses DropboxCleanupSection; the settings nav page is gone — the
      // foot action is the one entry point now.
      slots.inject('sidebar.footer.action', () => slots.register(
        { name: 'sidebar.footer.action', id: 'dropbox-cleanup', order: 0 },
        (props) => React.createElement(SidebarCleanupAction, props),
      ))
    }
    // Wait for the trigger pipeline and the slot system before activating: the
    // chip source registration must land before any submit can serialize, and
    // the slots are where the drop UI mounts. Both are core web-bundle services.
    exports.inject = ['inputTriggers', 'slots']

    return module.exports
  },
})

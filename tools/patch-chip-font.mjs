#!/usr/bin/env node
/**
 * Widen the composer's DshChipCell font for the drop-file-to-path chip.
 *
 * The web composer renders every reference chip inside a one-glyph cell whose
 * advance comes from a tiny embedded font: `DshChipCell` maps U+FFFC to a
 * blank 4em-advance glyph (InputBar.module.css in @deepseek-ai/dsh-client-ui-conversation).
 * 4em fits ~6 label characters — useless for a file path. This tool patches
 * that font's U+FFFC advance to CHIP_EMS em and prints the new base64.
 *
 * The plugin injects the patched face under the SAME family name after the
 * app's stylesheet, so the textarea, the caret mirror, and the backdrop chip
 * all resolve the same wide advance — the alignment contract the original
 * face guarantees ("same char, same stack") survives by construction.
 *
 * Usage: node tools/patch-chip-font.mjs   (prints the patched base64)
 *
 * If the upstream composer font ever changes (different advance or glyph id),
 * re-extract `ORIGINAL_B64` from InputBar.module.css and re-run.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * Chip cell base advance in em. The pill width is NOT this constant: the
 * plugin inserts `pad` NBSP spacers after the placeholder, so the cell =
 * BASE_EMS + pad × space width ≈ the label width. A small base (1em) keeps
 * short labels from wearing a wide empty pill; the spacer fill does the rest.
 */
const CHIP_EMS = 1

// The original face, extracted from
// packages/client/ui-conversation/src/client/skeleton/InputBar.module.css
// (@deepseek-ai/dsh-client-ui-conversation), @font-face DshChipCell.
const ORIGINAL_B64 = 'AAEAAAAKAIAAAwAgT1MvMkT8SmIAAAEoAAAAYGNtYXAADQBPAAABkAAAADRnbHlmAAAAAAAAAcwAAAABaGVhZCwtPGoAAACsAAAANmhoZWEDIg7bAAAA5AAAACRobXR4EZQAAAAAAYgAAAAIbG9jYQAAAAAAAAHEAAAABm1heHAAAwACAAABCAAAACBuYW1lvljk2gAAAdAAAABscG9zdNNweNQAAAI8AAAALQABAAAAAQAAdia1tV8PPPUAAwPoAAAAAOaLfcUAAAAA5ot9xQAAAAAAAAAAAAAAAwACAAAAAAAAAAEAAAMg/zgAAA+gAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAACAAEAAAACAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAwjKAZAABQAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAPz8/PwAA//z//AMg/zgAAAMgAMgAAAAAAAAAAAAAAAAAAAAgAAAB9AAAD6AAAAAAAAIAAAADAAAAFAADAAEAAAAUAAQAIAAAAAQABAABAAD//P//AAD//P//AAUAAQAAAAAAAAAAAAAAAAAAAAAAAAAEADYAAQAAAAAAAQALAAAAAQAAAAAAAgAHAAsAAwABBAkAAQAWABIAAwABBAkAAgAOAChEc2hDaGlwQ2VsbFJlZ3VsYXIARABzAGgAQwBoAGkAcABDAGUAbABsAFIAZQBnAHUAbABhAHIAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAABAgZvYmpyZXAAAAA='

const u16 = (buf, off) => buf.readUInt16BE(off)
const u32 = (buf, off) => buf.readUInt32BE(off)

/** Sum of big-endian u32 words over [start, end), zero-padded to a word boundary. */
function checksum(buf, start, end) {
  let sum = 0
  const len = end - start
  const padded = Math.ceil(len / 4) * 4
  const view = Buffer.alloc(padded)
  buf.copy(view, 0, start, end)
  for (let i = 0; i < padded; i += 4) sum = (sum + u32(view, i)) >>> 0
  return sum >>> 0
}

function patch() {
  const buf = Buffer.from(ORIGINAL_B64, 'base64')
  const numTables = u16(buf, 4)
  const tables = {}
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16
    tables[buf.toString('ascii', rec, rec + 4)] = {
      offset: u32(buf, rec + 8),
      length: u32(buf, rec + 12),
    }
  }
  const head = tables.head
  const maxp = tables.maxp
  const hhea = tables.hhea
  const cmap = tables.cmap
  const hmtx = tables.hmtx
  if (!head || !maxp || !hhea || !cmap || !hmtx) throw new Error('missing required sfnt tables')

  const unitsPerEm = u16(buf, head.offset + 18)
  const numGlyphs = u16(buf, maxp.offset + 4)
  // numberOfHMetrics lives in hhea (offset 34), not maxp.
  const numHMetrics = u16(buf, hhea.offset + 34)
  if (numHMetrics === 0 || numHMetrics > numGlyphs) throw new Error('unexpected hmtx metric count')

  // cmap: glyph id for U+FFFC via the first usable subtable.
  const cmapOff = cmap.offset
  const nSubtables = u16(buf, cmapOff + 2)
  let glyphId = -1
  for (let i = 0; i < nSubtables && glyphId < 0; i++) {
    const rec = cmapOff + 4 + i * 8
    const platform = u16(buf, rec)
    const encoding = u16(buf, rec + 2)
    const sub = cmapOff + u32(buf, rec + 4)
    const format = u16(buf, sub)
    if (format === 4 && (platform === 3 || platform === 0)) {
      const segX2 = u16(buf, sub + 6)
      for (let seg = 0; seg < segX2; seg += 2) {
        const end = u16(buf, sub + 14 + seg)
        if (0xfffc > end) break
        const start = u16(buf, sub + 16 + segX2 + seg)
        if (0xfffc < start) continue
        const idDelta = u16(buf, sub + 16 + segX2 * 2 + seg)
        const idRangeOff = u16(buf, sub + 16 + segX2 * 3 + seg)
        if (idRangeOff === 0) {
          glyphId = (0xfffc + idDelta) & 0xffff
        } else {
          const g = u16(buf, sub + idRangeOff + (0xfffc - start) * 2 + (seg / 2) * 2)
          glyphId = g === 0 ? 0 : (g + idDelta) & 0xffff
        }
      }
    } else if (format === 12 && (platform === 3 || platform === 0)) {
      const nGroups = u32(buf, sub + 12)
      for (let g = 0; g < nGroups; g++) {
        const gOff = sub + 16 + g * 12
        const start = u32(buf, gOff)
        const end = u32(buf, gOff + 4)
        const startGlyph = u32(buf, gOff + 8)
        if (0xfffc >= start && 0xfffc <= end) {
          glyphId = startGlyph + (0xfffc - start)
          break
        }
      }
    }
  }
  if (glyphId < 0) throw new Error('U+FFFC not found in cmap')

  const advanceOff = hmtx.offset + glyphId * 4 // one metric = advance u16 + lsb u16
  if (glyphId >= numHMetrics) throw new Error('glyph outside hmtx metric range')
  const oldAdvance = u16(buf, advanceOff)
  const newAdvance = CHIP_EMS * unitsPerEm
  buf.writeUInt16BE(newAdvance, advanceOff)
  console.error(`patched U+FFFC glyph ${glyphId}: advance ${oldAdvance} (${oldAdvance / unitsPerEm}em) -> ${newAdvance} (${CHIP_EMS}em), unitsPerEm=${unitsPerEm}`)

  // Refresh the hmtx table checksum and the font-wide head.checkSumAdjustment.
  const patchHeadCheck = (value) => buf.writeUInt32BE(value, head.offset + 8)
  patchHeadCheck(0)
  const recOf = (tag) => {
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16
      if (buf.toString('ascii', rec, rec + 4) === tag) return rec
    }
    return -1
  }
  buf.writeUInt32BE(checksum(buf, hmtx.offset, hmtx.offset + hmtx.length), recOf('hmtx') + 4)
  let total = 0
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16
    total = (total + checksum(buf, rec, rec + 16)) >>> 0
    total = (total + checksum(buf, u32(buf, rec + 8), u32(buf, rec + 8) + u32(buf, rec + 12))) >>> 0
  }
  patchHeadCheck((0xb1b0afba - total) >>> 0)

  const out = buf.toString('base64')
  const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'chip-cell-font.b64')
  writeFileSync(target, out)
  console.error(`wrote ${target} (${out.length} chars)`)
  console.log(out)
}

patch()

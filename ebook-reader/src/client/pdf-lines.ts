/** Grouping of PDF.js text items into visual lines and a page's reading text. */

import type { TextSpan } from './reading-text.ts'

/** The fields of a PDF.js `TextItem` this module reads. */
export interface PdfTextItem {
  readonly str: string
  /** Text matrix `[a, b, c, d, e, f]` in PDF user space; `e`/`f` are the baseline origin. */
  readonly transform: readonly number[]
  /** Advance width in PDF user space. */
  readonly width: number
  readonly hasEOL: boolean
}

/** A rectangle in page CSS pixels at scale 1, origin top-left. */
export interface PageBox {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** One run of characters PDF.js reported together: its span of the page's reading text and its box. */
export interface PdfRun extends TextSpan {
  readonly box: PageBox
}

/** One visual line: its span of the page's reading text, its box, and the runs it is built from. */
export interface PdfLine extends TextSpan {
  readonly box: PageBox
  readonly runs: readonly PdfRun[]
}

/** A page's reading text (its lines joined by `\n`) and the lines within it. */
export interface PdfPageText {
  readonly text: string
  readonly lines: readonly PdfLine[]
  /** Spans read-aloud skips: the running head and foot, and numbered code listings. */
  readonly skip: readonly TextSpan[]
}

/** Converts a PDF user-space rectangle `[x1, y1, x2, y2]` to page pixels at scale 1. */
export type ToPagePixels = (rect: [number, number, number, number]) => readonly number[]

const CJK = /[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/u
/** Share of the font size above the baseline and below it that a line box covers. */
const ASCENT = 0.88
const DESCENT = 0.24

interface OpenRun {
  offset: number
  length: number
  left: number
  right: number
  top: number
  bottom: number
}

interface OpenLine {
  text: string
  baseline: number
  size: number
  left: number
  right: number
  top: number
  bottom: number
  pendingSpace: boolean
  runs: OpenRun[]
}

/** A running head or foot carries the page number at one end of an otherwise short line. */
const PAGE_NUMBERED = /^\d{1,4}\s|\s\d{1,4}$/
/** A head or foot is a label, so a line closing a sentence is body prose wherever it sits. */
const ENDS_SENTENCE = /[。．.！!？?；;：:]["'」』）)\]】》〉]*$/
/** The leading line number of a printed code listing: an integer no punctuation follows. */
const LISTING_NUMBER = /^(\d{1,4})(?:\s|$)/
/** A gap this many times the page's usual line spacing separates the text block from its margin. */
const MARGIN_GAP = 1.8
/** Consecutive numbered lines below this are an ordinary passage, not a listing. */
const LISTING_MIN_LINES = 3
/** Page pixels within which two lines sit on one printed row. */
const SAME_ROW = 2

/**
 * The lines of a page that are not body prose.
 *
 *
 * Two kinds are recognised, both from the page alone. The outermost line is the running head or
 * foot when a gap wider than the page's usual line spacing separates it from the text block, or
 * when it carries the page number at one end. A run of `LISTING_MIN_LINES` or more lines whose
 * leading integers step by one is a printed code listing, and the wrapped lines inside that run
 * belong to it.
 *
 * Both are heuristics over what a page draws, because a PDF marks neither. A listing printed
 * without line numbers is read as prose, and a running head that neither stands apart nor carries
 * the page number is read as prose. A page of one line has no spacing to compare against, so only
 * the page number identifies its head.
 * @param lines - the page's lines in reading order.
 * @returns the indexes of the lines to skip.
 */
function nonBodyLines(lines: readonly { readonly text: string; readonly top: number }[]): Set<number> {
  const skip = new Set<number>()
  const first = lines[0]
  const last = lines.at(-1)
  if (first === undefined || last === undefined) return skip

  const gaps: number[] = []
  let previous: number | undefined
  for (const line of lines) {
    if (previous !== undefined) gaps.push(line.top - previous)
    previous = line.top
  }
  const ordered = gaps.filter(gap => gap > 0).sort((a, b) => a - b)
  const spacing = ordered[ordered.length >> 1] ?? 0

  // A head or foot printed as a title at one side and the page number at the other lands in
  // several lines of one printed row, which is judged together.
  const head: { index: number; text: string }[] = []
  for (const [index, line] of lines.entries()) {
    if (Math.abs(line.top - first.top) > SAME_ROW) break
    head.push({ index, text: line.text.trim() })
  }
  const foot: { index: number; text: string }[] = []
  for (const [offset, line] of [...lines].reverse().entries()) {
    if (Math.abs(line.top - last.top) > SAME_ROW) break
    foot.unshift({ index: lines.length - 1 - offset, text: line.text.trim() })
  }
  const furniture = (row: readonly { index: number; text: string }[], gap: number | undefined): boolean => {
    if (row.length === lines.length) return false
    const text = row.map(member => member.text).join(' ').trim()
    if (ENDS_SENTENCE.test(text)) return false
    return (spacing > 0 && gap !== undefined && gap > MARGIN_GAP * spacing) || PAGE_NUMBERED.test(text)
  }
  const afterHead = lines[head.length]
  if (furniture(head, afterHead === undefined ? undefined : afterHead.top - first.top)) {
    for (const member of head) skip.add(member.index)
  }
  const beforeFoot = lines[lines.length - foot.length - 1]
  if (furniture(foot, beforeFoot === undefined ? undefined : last.top - beforeFoot.top)) {
    for (const member of foot) skip.add(member.index)
  }

  // A listing is a run of lines whose leading integers step by one; what wraps inside it belongs to it.
  let run: { from: number; to: number; number: number; lines: number } | undefined
  const close = (): void => {
    if (run !== undefined && run.lines >= LISTING_MIN_LINES) for (let at = run.from; at <= run.to; at += 1) skip.add(at)
    run = undefined
  }
  for (const [index, line] of lines.entries()) {
    if (skip.has(index)) continue
    const [, digits] = LISTING_NUMBER.exec(line.text.trim()) ?? []
    if (digits === undefined) continue
    const number = Number(digits)
    if (run !== undefined && number !== run.number + 1) close()
    run = run === undefined
      ? { from: index, to: index, number, lines: 1 }
      : { from: run.from, to: index, number, lines: run.lines + 1 }
  }
  close()
  return skip
}

/** Whether an item at baseline origin (x, y) of font size `size` cannot continue `line`. */
function startsNewLine(line: OpenLine, x: number, y: number, size: number): boolean {
  return Math.abs(y - line.baseline) > 0.5 * Math.max(size, line.size)
    || x < line.left - 0.5 * size
    || x - line.right > 2.5 * size
}

function joins(previous: string, next: string): boolean {
  const last = previous.at(-1)
  const first = next[0]
  return last !== undefined && first !== undefined && CJK.test(last) && CJK.test(first)
}

/**
 * Group a page's text items into lines in content-stream order.
 *
 * An item starts a new line after an end-of-line mark, when its baseline moves by more than half
 * the font size, when it jumps back left of the line, or when a gap wider than 2.5 font sizes
 * separates it from the line (a column gutter). Items within a line are joined with one space,
 * except between CJK characters and where the gap is narrower than a fifth of the font size.
 * @param items - the page's `getTextContent()` items, marked-content entries excluded.
 * @param toPagePixels - the page viewport's rectangle conversion at scale 1.
 * @returns the page's reading text and lines.
 */
export function groupPdfLines(items: readonly PdfTextItem[], toPagePixels: ToPagePixels): PdfPageText {
  const open: OpenLine[] = []
  let current: OpenLine | undefined
  for (const item of items) {
    const [, , c = 0, d = 0, x = 0, y = 0] = item.transform
    const size = Math.hypot(c, d) || 1
    if (item.str.trim() === '') {
      if (current !== undefined && item.str.length > 0) current.pendingSpace = true
      if (item.hasEOL) current = undefined
      continue
    }
    if (current === undefined || startsNewLine(current, x, y, size)) {
      current = {
        text: item.str,
        baseline: y,
        size,
        left: x,
        right: x + item.width,
        top: y + ASCENT * size,
        bottom: y - DESCENT * size,
        pendingSpace: false,
        runs: [{
          offset: 0,
          length: item.str.length,
          left: x,
          right: x + item.width,
          top: y + ASCENT * size,
          bottom: y - DESCENT * size,
        }],
      }
      open.push(current)
    } else {
      const line = current
      const gap = x - line.right
      const spaced = (line.pendingSpace || gap > 0.2 * size) && !joins(line.text, item.str)
        && !line.text.endsWith(' ') && !item.str.startsWith(' ')
      const offset = line.text.length + (spaced ? 1 : 0)
      line.runs.push({
        offset,
        length: item.str.length,
        left: x,
        right: x + item.width,
        top: y + ASCENT * size,
        bottom: y - DESCENT * size,
      })
      line.text += spaced ? ` ${item.str}` : item.str
      line.right = Math.max(line.right, x + item.width)
      line.top = Math.max(line.top, y + ASCENT * size)
      line.bottom = Math.min(line.bottom, y - DESCENT * size)
      line.size = Math.max(line.size, size)
      line.pendingSpace = false
    }
    if (item.hasEOL) current = undefined
  }
  const lines: PdfLine[] = []
  let text = ''
  // A line opens only on an item with visible text, so no line trims to nothing.
  for (const line of open) {
    const content = line.text.trim()
    if (text !== '') text += '\n'
    const lead = line.text.length - line.text.trimStart().length
    const start = text.length
    const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = toPagePixels([line.left, line.bottom, line.right, line.top])
    lines.push({
      start,
      end: start + content.length,
      box: { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) },
      runs: line.runs.map((run): PdfRun => {
        const [rx1 = 0, ry1 = 0, rx2 = 0, ry2 = 0] = toPagePixels([run.left, run.bottom, run.right, run.top])
        return {
          start: start + Math.max(0, Math.min(run.offset - lead, content.length)),
          end: start + Math.max(0, Math.min(run.offset + run.length - lead, content.length)),
          box: { left: Math.min(rx1, rx2), top: Math.min(ry1, ry2), width: Math.abs(rx2 - rx1), height: Math.abs(ry2 - ry1) },
        }
      }),
    })
    text += content
  }
  const skipped = nonBodyLines(lines.map(line => ({ text: text.slice(line.start, line.end), top: line.box.top })))
  return { text, lines, skip: lines.filter((_, index) => skipped.has(index)).map(line => ({ start: line.start, end: line.end })) }
}

/**
 * Box the part of each line a span covers, clipped to the runs the span holds.
 * @param lines - the page's lines.
 * @param span - the span, typically the sentence being read aloud.
 * @returns one box per line the span reaches, in reading order.
 */
export function spanBoxes(lines: readonly PdfLine[], span: TextSpan): PageBox[] {
  return lines.flatMap((line): PageBox[] => {
    const covered = line.runs.filter(run => run.start < span.end && run.end > span.start)
    const [first] = covered
    if (first === undefined) return []
    const left = Math.min(...covered.map(run => run.box.left))
    const right = Math.max(...covered.map(run => run.box.left + run.box.width))
    return [{ left, top: line.box.top, width: right - left, height: line.box.height }]
  })
}

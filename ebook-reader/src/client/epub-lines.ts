/** Visual lines of rendered EPUB chapter text, measured from the browser's layout. */

import type { TextSpan } from './reading-text.ts'

/** A box relative to the chapter root, in pixels. */
export interface LineBox {
  readonly top: number
  readonly bottom: number
  readonly left: number
  readonly right: number
}

/** One visual line: its span of the chapter's reading text and its box relative to the chapter root. */
export interface VisualLine extends TextSpan, LineBox {}

/**
 * Client rectangles of a text-node range, one per line fragment, empty rectangles excluded.
 * Injected so the grouping can be exercised without a layout engine.
 */
export type MeasureRange = (node: Text, start: number, end: number) => readonly DOMRectReadOnly[]

/**
 * Measure with a DOM Range.
 * @param node - the text node.
 * @param start - first UTF-16 offset within the node.
 * @param end - offset one past the last character.
 * @returns the range's non-empty client rectangles.
 */
export const measureWithRange: MeasureRange = (node, start, end) => {
  const range = node.ownerDocument.createRange()
  range.setStart(node, start)
  range.setEnd(node, end)
  return [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0)
}

function sameLine(a: DOMRectReadOnly, b: DOMRectReadOnly): boolean {
  return Math.abs(a.top - b.top) < Math.min(a.height, b.height) / 2
}

/** Whether every fragment of a range sits on the line of `first`. */
function onOneLine(rects: readonly DOMRectReadOnly[], first: DOMRectReadOnly): boolean {
  return rects.every(rect => sameLine(rect, first))
}

/**
 * Measure the visual lines of a rendered chapter.
 *
 * Offsets count every text node under `root` in document order, matching the reading text of the
 * chapter markup. Within a text node the last character on the current line is found by binary
 * search over the range's line fragments; consecutive runs on one line, across inline elements,
 * merge into one visual line.
 * @param root - element whose content is the rendered chapter markup.
 * @param measure - range measurement.
 * @returns the lines in reading order, in pixels relative to `root`'s border box.
 */
export function measureLines(root: HTMLElement, measure: MeasureRange = measureWithRange): VisualLine[] {
  const origin = root.getBoundingClientRect()
  const lines: { start: number; end: number; top: number; bottom: number; left: number; right: number; height: number }[] = []
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let base = 0
  for (let node = walker.nextNode() as Text | null; node !== null; node = walker.nextNode() as Text | null) {
    const length = node.data.length
    let index = 0
    while (index < length) {
      const first = measure(node, index, index + 1)[0]
      if (first === undefined) {
        index += 1
        continue
      }
      let low = index
      let high = length - 1
      if (!onOneLine(measure(node, index, length), first)) {
        // Largest `last` whose range [index, last] stays on the first character's line.
        while (low < high) {
          const middle = (low + high + 1) >> 1
          if (onOneLine(measure(node, index, middle + 1), first)) low = middle
          else high = middle - 1
        }
      } else {
        low = high
      }
      const run = measure(node, index, low + 1).filter(rect => sameLine(rect, first))
      const left = Math.min(...run.map(rect => rect.left)) - origin.left
      const right = Math.max(...run.map(rect => rect.right)) - origin.left
      const top = first.top - origin.top
      const bottom = first.bottom - origin.top
      const open = lines.at(-1)
      if (open !== undefined && Math.abs(open.top - top) < Math.min(open.height, first.height) / 2) {
        open.end = base + low + 1
        open.left = Math.min(open.left, left)
        open.right = Math.max(open.right, right)
        open.bottom = Math.max(open.bottom, bottom)
      } else {
        lines.push({ start: base + index, end: base + low + 1, top, bottom, left, right, height: first.height })
      }
      index = low + 1
    }
    base += length
  }
  return lines.map(({ start, end, top, bottom, left, right }) => ({ start, end, top, bottom, left, right }))
}

/**
 * Measure the rows a span of the chapter's reading text occupies, as a text selection would show it.
 * @param root - element whose content is the rendered chapter markup.
 * @param span - the span, in reading-text offsets.
 * @param measure - range measurement.
 * @returns one box per row the span covers, in reading order, relative to `root`'s border box.
 */
export function measureSpan(root: HTMLElement, span: TextSpan, measure: MeasureRange = measureWithRange): LineBox[] {
  const origin = root.getBoundingClientRect()
  const rows: { top: number; bottom: number; left: number; right: number; height: number }[] = []
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let base = 0
  for (let node = walker.nextNode() as Text | null; node !== null && base < span.end; node = walker.nextNode() as Text | null) {
    const length = node.data.length
    const from = Math.max(span.start - base, 0)
    const to = Math.min(span.end - base, length)
    base += length
    if (from >= to) continue
    for (const rect of measure(node, from, to)) {
      const top = rect.top - origin.top
      const open = rows.at(-1)
      if (open !== undefined && Math.abs(open.top - top) < Math.min(open.height, rect.height) / 2) {
        open.left = Math.min(open.left, rect.left - origin.left)
        open.right = Math.max(open.right, rect.right - origin.left)
        open.bottom = Math.max(open.bottom, rect.bottom - origin.top)
      } else {
        rows.push({
          top,
          bottom: rect.bottom - origin.top,
          left: rect.left - origin.left,
          right: rect.right - origin.left,
          height: rect.height,
        })
      }
    }
  }
  return rows.map(({ top, bottom, left, right }) => ({ top, bottom, left, right }))
}

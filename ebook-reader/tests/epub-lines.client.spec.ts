// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { measureLines, measureSpan, measureWithRange, type MeasureRange } from '../src/client/epub-lines.ts'

/** Character cell size and characters per line of the simulated layout. */
const CELL = 10
const HEIGHT = 20
const PER_LINE = 5

function rect(left: number, top: number, width: number, height: number): DOMRectReadOnly {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }
}

/**
 * A layout that flows every non-whitespace character of `root` into lines of PER_LINE cells, in
 * text-node order. Whitespace collapses to nothing, and a whitespace-only node (the gap between two
 * blocks) ends the current line, as the next block starts on a new one.
 */
function layout(root: HTMLElement): MeasureRange {
  const cells = new Map<Text, number[]>()
  let cell = 0
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode() as Text | null; node !== null; node = walker.nextNode() as Text | null) {
    if (node.data.trim() === '') cell = Math.ceil(cell / PER_LINE) * PER_LINE
    cells.set(node, Array.from(node.data).map(char => (/\s/.test(char) ? -1 : cell++)))
  }
  return (node, start, end) => {
    const fragments = new Map<number, number[]>()
    for (const index of cells.get(node)!.slice(start, end)) {
      if (index < 0) continue
      const line = Math.floor(index / PER_LINE)
      fragments.set(line, [...fragments.get(line) ?? [], index % PER_LINE])
    }
    return [...fragments].map(([line, columns]) =>
      rect(100 + Math.min(...columns) * CELL, 50 + line * HEIGHT, (Math.max(...columns) - Math.min(...columns) + 1) * CELL, HEIGHT))
  }
}

afterEach(() => { document.body.innerHTML = '' })

describe('EPUB visual lines', () => {
  it('finds line breaks inside a text node and merges runs across inline elements', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>一二三<em>四五六</em>七八九十甲乙</p>\n  <p>丙丁</p>'
    root.getBoundingClientRect = () => rect(100, 50, 50, 200)
    const lines = measureLines(root, layout(root))
    const text = root.textContent
    expect(lines.map(line => text.slice(line.start, line.end))).toEqual(['一二三四五', '六七八九十', '甲乙', '丙丁'])
    expect(lines[0]).toMatchObject({ top: 0, bottom: 20, left: 0, right: 50 })
    expect(lines[2]).toMatchObject({ top: 40, left: 0, right: 20 })
  })

  it('boxes a sentence row by row, clipped to where it starts and ends', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>一二三<em>四五六</em>七八九十甲乙</p>\n  <p>丙丁</p>'
    root.getBoundingClientRect = () => rect(100, 50, 50, 200)
    const measure = layout(root)
    // Rows hold five characters: a sentence from the third character to the eighth covers two rows.
    expect(measureSpan(root, { start: 2, end: 8 }, measure)).toEqual([
      { top: 0, bottom: 20, left: 20, right: 50 },
      { top: 20, bottom: 40, left: 0, right: 30 },
    ])
    // The whitespace between the blocks lays out to nothing; the next block starts a row of its own.
    expect(measureSpan(root, { start: 12, end: 14 }, measure)).toEqual([])
    expect(measureSpan(root, { start: 15, end: 17 }, measure)).toEqual([{ top: 60, bottom: 80, left: 0, right: 20 }])
    expect(measureSpan(root, { start: 40, end: 44 }, measure)).toEqual([])
  })

  it('returns no lines for text that lays out to nothing', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>  </p>'
    root.getBoundingClientRect = () => rect(0, 0, 0, 0)
    expect(measureLines(root, () => [])).toEqual([])
  })

  // jsdom has no layout, so its Range carries no getClientRects; each test installs one.
  const installRects = (rects: readonly DOMRectReadOnly[]) => {
    const getClientRects = vi.fn(() => rects as unknown as DOMRectList)
    Object.defineProperty(Range.prototype, 'getClientRects', { value: getClientRects, configurable: true })
    return getClientRects
  }
  afterEach(() => { Reflect.deleteProperty(Range.prototype, 'getClientRects') })

  it('measures with a DOM range and drops empty rectangles', () => {
    const node = document.createTextNode('abc')
    document.body.append(node)
    const getClientRects = installRects([rect(0, 0, 10, 20), rect(0, 0, 0, 20), rect(0, 0, 10, 0)])
    expect(measureWithRange(node, 0, 2).map(kept => [kept.width, kept.height])).toEqual([[10, 20]])
    expect(getClientRects).toHaveBeenCalledOnce()
  })

  it('uses the DOM range measurement by default', () => {
    const root = document.createElement('div')
    root.textContent = 'ab'
    document.body.append(root)
    installRects([rect(0, 0, 10, 20)])
    expect(measureLines(root).map(line => [line.start, line.end])).toEqual([[0, 2]])
    expect(measureSpan(root, { start: 0, end: 2 })).toEqual([{ top: 0, bottom: 20, left: 0, right: 10 }])
  })
})

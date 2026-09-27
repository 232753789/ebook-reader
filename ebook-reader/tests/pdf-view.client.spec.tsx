// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BookSection, PageRender, PdfSection } from '../src/client/book.ts'
import type { PdfLine } from '../src/client/pdf-lines.ts'
import { PdfView, type PdfViewProps } from '../src/client/PdfView.tsx'
import type { ReadingPosition } from '../src/types.ts'
import { t } from './reader-fixtures.client.ts'
import { installLayout, intersect, removeLayout, resize, scrolls, viewport } from './layout-stubs.client.ts'

/** A line of two runs, each four characters wide, so a span clips to half the line. */
function line(start: number, top: number, left = 50, width = 400): PdfLine {
  const box = { left, top, width, height: 20 }
  return {
    start,
    end: start + 8,
    box,
    runs: [
      { start, end: start + 4, box: { left, top, width: width / 2, height: 20 } },
      { start: start + 4, end: start + 8, box: { left: left + width / 2, top, width: width / 2, height: 20 } },
    ],
  }
}

/** Page 1 has three lines, page 2 none, page 3 two lines side by side and one below. */
const PAGES: PdfSection[] = [
  { kind: 'pdf', width: 600, height: 800, text: 'x'.repeat(30), lines: [line(0, 100), line(10, 200), line(20, 700)], skip: [] },
  { kind: 'pdf', width: 600, height: 800, text: '', lines: [], skip: [] },
  { kind: 'pdf', width: 600, height: 780, text: 'y'.repeat(30), lines: [line(0, 50, 50, 200), line(10, 50, 300, 200), line(20, 100)], skip: [] },
]

const settle = (ms = 300) => act(() => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))

function mount(overrides: Partial<PdfViewProps> = {}) {
  const renders: { index: number; scale: number; cancel: ReturnType<typeof vi.fn> }[] = []
  const props: PdfViewProps = {
    sectionCount: 3,
    position: { section: 0, offset: 0 },
    reveal: 1,
    zoom: 1,
    speaking: false,
    sentence: undefined,
    section: vi.fn((index: number) => Promise.resolve(PAGES[index]! as BookSection)),
    renderPage: vi.fn((index: number, _canvas: HTMLCanvasElement, scale: number): PageRender => {
      const cancel = vi.fn()
      renders.push({ index, scale, cancel })
      return { done: index === 1 ? Promise.reject(new Error('corrupt')) : Promise.resolve(), cancel }
    }),
    pageSize: vi.fn((index: number) => index < 2 ? { width: 600, height: 800 } : undefined),
    goTo: vi.fn(),
    settle: vi.fn(),
    t,
    ...overrides,
  }
  const view = render(<PdfView {...props} />)
  const update = (next: Partial<PdfViewProps>) => { Object.assign(props, next); view.rerender(<PdfView {...props} />) }
  const scroller = screen.getByTestId('pdf-view')
  return { props, renders, update, scroller, view }
}

const page = (index: number) => document.querySelector<HTMLElement>(`[data-page="${String(index)}"]`)!

beforeEach(() => {
  installLayout()
  viewport.width = 648
  viewport.height = 600
})
afterEach(() => {
  cleanup()
  removeLayout()
})

describe('PDF view', () => {
  it('lays pages out at fit-to-width scale and renders only the pages near the viewport', async () => {
    const { renders } = mount()
    expect(page(0).style.height).toBe('800px')
    expect(page(2).style.height).toBe('780px')
    expect(page(2).textContent).toBe('3')
    act(() => { intersect(element => element.dataset.page !== '2') })
    await waitFor(() => { expect(renders.map(entry => [entry.index, entry.scale])).toEqual([[0, 1], [1, 1]]) })
    expect(page(2).querySelector('canvas')).toBeNull()
    await waitFor(() => { expect(screen.getByText('此页没有可识别的文字，可能是扫描版。')).toBeTruthy() })
    act(() => { intersect(element => element.dataset.page === '2') })
    await waitFor(() => { expect(page(0).querySelector('canvas')).toBeNull() })
    expect(renders[0]!.cancel).toHaveBeenCalled()
  })

  it('falls back to a letter-size page before the first page size is known, and follows resizes', async () => {
    const { renders } = mount({ pageSize: () => undefined })
    expect(page(0).style.width).toBe('600px')
    viewport.width = 1260
    act(() => { resize() })
    expect(page(0).style.width).toBe(`${String((1260 - 48) / 612 * 612)}px`)
    act(() => { intersect(() => true) })
    await waitFor(() => { expect(renders.length).toBeGreaterThan(0) })
  })

  it('boxes the spoken sentence row by row, clipped to the runs it covers', async () => {
    const { update } = mount({ position: { section: 0, offset: 0 }, speaking: true, sentence: { start: 4, end: 22 } })
    act(() => { intersect(() => true) })
    await waitFor(() => { expect(screen.getAllByTestId('pdf-active-line')).toHaveLength(3) })
    const boxes = () => screen.getAllByTestId('pdf-active-line').map(box => `${box.style.top}/${box.style.left}/${box.style.width}`)
    // The sentence starts in the first line's second run and ends in the third line's first run.
    expect(boxes()).toEqual(['98px/247px/206px', '198px/47px/406px', '698px/47px/206px'])
    update({ sentence: { start: 10, end: 18 } })
    expect(boxes()).toEqual(['198px/47px/406px'])
    update({ speaking: false, sentence: undefined })
    expect(boxes()).toEqual(['98px/47px/406px'])
  })

  it('highlights the line holding the reading offset and scrolls it into view only when hidden', async () => {
    const { update } = mount({ position: { section: 0, offset: 25 } })
    act(() => { intersect(() => true) })
    const highlight = await screen.findByTestId('pdf-active-line')
    expect(highlight.style.top).toBe('698px')
    await waitFor(() => { expect(scrolls.at(-1)).toMatchObject({ top: 700 - 180, behavior: 'smooth' }) })
    const count = scrolls.length
    update({ position: { section: 0, offset: 22 }, reveal: 2 })
    await settle(20)
    expect(scrolls).toHaveLength(count)
    update({ position: { section: 2, offset: 0 }, reveal: 3 })
    await waitFor(() => { expect(scrolls.at(-1)?.top).toBe(1632 + 50 - 180) })
    update({ position: { section: 2, offset: 0 }, reveal: 4, zoom: 4 })
    await waitFor(() => { expect(scrolls.at(-1)?.behavior).toBe('auto') })
  })

  it('reveals the page top when a page has no text or fails to load', async () => {
    const section = vi.fn((index: number) => index === 2 ? Promise.reject(new Error('bad page')) : Promise.resolve(PAGES[index]! as BookSection))
    const { update } = mount({ section })
    update({ position: { section: 1, offset: 0 }, reveal: 2 })
    await waitFor(() => { expect(scrolls.at(-1)?.top).toBe(816 - 180) })
    update({ position: { section: 2, offset: 0 }, reveal: 3 })
    await waitFor(() => { expect(scrolls.at(-1)?.top).toBe(1632 - 180) })
  })

  it('moves the reading position to a clicked line', async () => {
    const { props } = mount()
    fireEvent.click(page(2), { clientX: 100, clientY: 55 })
    expect(props.goTo).not.toHaveBeenCalled()
    act(() => { intersect(() => true) })
    await waitFor(() => { expect(page(2).querySelector('canvas')).not.toBeNull() })
    await settle(10)
    fireEvent.click(page(2), { clientX: 400, clientY: 55 })
    expect(props.goTo).toHaveBeenLastCalledWith({ section: 2, offset: 10 })
    fireEvent.click(page(2), { clientX: 580, clientY: 55 })
    expect(props.goTo).toHaveBeenLastCalledWith({ section: 2, offset: 0 })
    fireEvent.click(page(0), { clientX: 100, clientY: 400 })
    expect(props.goTo).toHaveBeenCalledTimes(2)
  })

  it('steps line by line with the arrow keys, skipping pages without text', async () => {
    const { props, scroller, update } = mount({ position: { section: 0, offset: 10 } })
    const press = async (key: string) => {
      fireEvent.keyDown(scroller, { key })
      await settle(10)
    }
    await press('ArrowDown')
    expect(props.goTo).toHaveBeenLastCalledWith({ section: 0, offset: 20 })
    update({ position: { section: 0, offset: 20 } })
    await press('j')
    expect(props.goTo).toHaveBeenLastCalledWith({ section: 2, offset: 0 })
    update({ position: { section: 2, offset: 0 } })
    await press('k')
    expect(props.goTo).toHaveBeenLastCalledWith({ section: 0, offset: 20 })
    update({ position: { section: 0, offset: 0 } })
    await press('ArrowUp')
    update({ position: { section: 2, offset: 20 } })
    await press('ArrowDown')
    await press('Enter')
    expect(props.goTo).toHaveBeenCalledTimes(3)
  })

  it('treats a section of another format as a page without text', async () => {
    const section = vi.fn((index: number) => Promise.resolve<BookSection>(index === 1
      ? { kind: 'epub', html: '', text: '', breaks: [], anchors: {}, skip: [] }
      : PAGES[index]!))
    const { props, scroller, update } = mount({ section, position: { section: 0, offset: 20 } })
    fireEvent.keyDown(scroller, { key: 'ArrowDown' })
    await waitFor(() => { expect(props.goTo).toHaveBeenLastCalledWith({ section: 2, offset: 0 }) })
    update({ position: { section: 2, offset: 0 } })
    fireEvent.keyDown(scroller, { key: 'ArrowUp' })
    await waitFor(() => { expect(props.goTo).toHaveBeenLastCalledWith({ section: 0, offset: 20 }) })
    update({ position: { section: 1, offset: 0 } })
    fireEvent.keyDown(scroller, { key: 'ArrowDown' })
    await waitFor(() => { expect(props.goTo).toHaveBeenCalledTimes(3) })
    expect(props.goTo).toHaveBeenLastCalledWith({ section: 2, offset: 0 })
  })

  it('keeps the position when a page fails to load during a step', async () => {
    const section = vi.fn(() => Promise.reject(new Error('unreadable')))
    const { props, scroller } = mount({ section })
    fireEvent.keyDown(scroller, { key: 'j' })
    fireEvent.keyDown(scroller, { key: 'k' })
    await settle(20)
    expect(props.goTo).not.toHaveBeenCalled()
  })

  it('follows a manual scroll with the reading position unless read-aloud drives it', async () => {
    const { props, scroller, update } = mount()
    act(() => { intersect(() => true) })
    await screen.findByTestId('pdf-active-line')
    scroller.scrollTop = 1700
    fireEvent.scroll(scroller)
    await settle()
    expect(props.settle).toHaveBeenLastCalledWith({ section: 2, offset: 20 })

    scroller.scrollTop = 1640
    fireEvent.scroll(scroller)
    fireEvent.scroll(scroller)
    await settle()
    expect(props.settle).toHaveBeenLastCalledWith({ section: 2, offset: 0 })

    scroller.scrollTop = 0
    fireEvent.scroll(scroller)
    await settle()
    expect(props.settle).toHaveBeenCalledTimes(2)

    update({ speaking: true })
    scroller.scrollTop = 1700
    fireEvent.scroll(scroller)
    await settle()
    expect(props.settle).toHaveBeenCalledTimes(2)
  })

  it('settles on a page start when the page past the viewport top has no loaded lines', async () => {
    const section = vi.fn((index: number) => index === 2 ? Promise.reject(new Error('bad')) : Promise.resolve(PAGES[index]! as BookSection))
    const { props, scroller } = mount({ section, position: { section: 1, offset: 0 } })
    await waitFor(() => { expect(scrolls).toHaveLength(1) })
    scroller.scrollTop = 1700
    fireEvent.scroll(scroller)
    await settle()
    expect(props.settle).toHaveBeenLastCalledWith({ section: 2, offset: 0 })
    scroller.scrollTop = 900
    fireEvent.scroll(scroller)
    await settle()
    expect(props.settle).toHaveBeenLastCalledWith({ section: 1, offset: 0 })
  })

  it('stops observing and clears a pending settle on unmount', async () => {
    const { props, scroller, view } = mount()
    fireEvent.scroll(scroller)
    view.unmount()
    await settle()
    expect(props.settle).not.toHaveBeenCalled()
  })
})

describe('PDF view before layout', () => {
  it('renders no pages until the scroller has a width', () => {
    viewport.width = 0
    mount()
    expect(document.querySelector('[data-page]')).toBeNull()
    const position: ReadingPosition = { section: 0, offset: 0 }
    expect(position.section).toBe(0)
  })
})

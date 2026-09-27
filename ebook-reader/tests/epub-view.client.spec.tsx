// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BookSection, EpubSection } from '../src/client/book.ts'
import type { LineBox, VisualLine } from '../src/client/epub-lines.ts'
import type { TextSpan } from '../src/client/reading-text.ts'
import { EpubView, type EpubViewProps } from '../src/client/EpubView.tsx'
import { t } from './reader-fixtures.client.ts'
import { installLayout, removeLayout, resize, scrolls, viewport } from './layout-stubs.client.ts'

const measured = vi.hoisted(() => ({ lines: [] as VisualLine[], calls: 0, spans: [] as { span: TextSpan; boxes: LineBox[] }[] }))
vi.mock('../src/client/epub-lines.ts', () => ({
  measureLines: () => {
    measured.calls += 1
    return measured.lines
  },
  // Rows of the sentence: the covered lines, the first clipped where the sentence starts.
  measureSpan: (_root: HTMLElement, span: TextSpan) => {
    const boxes = measured.lines
      .filter(line => line.start < span.end && line.end > span.start)
      .map((line, index) => ({ ...line, left: index === 0 ? line.left + 120 : line.left }))
    measured.spans.push({ span, boxes })
    return boxes
  },
}))

/** Lines 40px apart: the fifth sits below a 600px viewport. */
const LINES: VisualLine[] = [0, 1, 2, 3, 20].map((row, index) => ({
  start: index * 10, end: index * 10 + 9, top: row * 40, bottom: row * 40 + 30, left: 0, right: 500,
}))

const CHAPTER: EpubSection = {
  kind: 'epub',
  html: '<p>第一行</p><a href="#note">注释</a><a href="https://example.com">外链</a><img src="blob:x">',
  text: 'x'.repeat(50),
  breaks: [],
  anchors: {},
  skip: [],
}

const wait = (ms = 300) => act(() => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))

function mount(overrides: Partial<EpubViewProps> = {}) {
  const props: EpubViewProps = {
    sectionCount: 3,
    position: { section: 1, offset: 0 },
    reveal: 1,
    fontScale: 1,
    speaking: false,
    sentence: undefined,
    section: vi.fn(() => Promise.resolve(CHAPTER as BookSection)),
    goTo: vi.fn(),
    settle: vi.fn(),
    followLink: vi.fn(() => Promise.resolve(true)),
    t,
    ...overrides,
  }
  const view = render(<EpubView {...props} />)
  const update = (next: Partial<EpubViewProps>) => { Object.assign(props, next); view.rerender(<EpubView {...props} />) }
  return { props, update, view, scroller: screen.getByTestId('epub-view') }
}

beforeEach(() => {
  installLayout()
  viewport.height = 600
  measured.lines = LINES
  measured.calls = 0
  measured.spans.length = 0
})
afterEach(() => {
  cleanup()
  removeLayout()
})

describe('EPUB view', () => {
  it('shows the chapter being read, highlights its line, and re-measures on resize, font change, and image load', async () => {
    const { update } = mount({ position: { section: 1, offset: 12 } })
    expect(screen.getByText('正在加载…')).toBeTruthy()
    await screen.findByText('第一行')
    expect(screen.getByTestId('epub-active-line').style.top).toBe('38px')
    const calls = measured.calls
    act(() => { resize() })
    document.querySelector('img')!.dispatchEvent(new Event('load'))
    await wait(20)
    expect(measured.calls).toBe(calls + 1)
    update({ fontScale: 1.3 })
    expect(measured.calls).toBe(calls + 2)
    expect((document.querySelector('[class*="page"]') as HTMLElement).style.fontSize).toBe('23.400000000000002px')
  })

  it('boxes the spoken sentence row by row instead of the reading line', async () => {
    const { update } = mount({ position: { section: 1, offset: 0 }, speaking: true, sentence: { start: 8, end: 25 } })
    await screen.findByText('第一行')
    const boxes = () => screen.getAllByTestId('epub-active-line').map(box => `${box.style.top}/${box.style.left}`)
    expect(boxes()).toEqual(['-2px/116px', '38px/-4px', '78px/-4px'])
    update({ sentence: { start: 20, end: 25 } })
    expect(boxes()).toEqual(['78px/116px'])
    expect(measured.spans.at(-1)?.span).toEqual({ start: 20, end: 25 })
    update({ speaking: false, sentence: undefined })
    expect(boxes()).toEqual(['-2px/-4px'])
  })

  it('reports a chapter that fails to load, and ignores a load that finished after the chapter changed', async () => {
    let finish: ((section: BookSection) => void) | undefined
    const section = vi.fn()
      .mockImplementationOnce(() => new Promise<BookSection>((resolve) => { finish = resolve }))
      .mockImplementationOnce(() => Promise.reject(new Error('章节损坏')))
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the scenario under test.
      .mockImplementationOnce(() => Promise.reject('原始错误'))
    const { update } = mount({ section })
    update({ position: { section: 2, offset: 0 } })
    expect((await screen.findByRole('alert')).textContent).toBe('加载失败：章节损坏')
    finish!(CHAPTER)
    await wait(10)
    expect(screen.queryByText('第一行')).toBeNull()
    update({ position: { section: 0, offset: 0 } })
    expect((await screen.findByRole('alert')).textContent).toBe('加载失败：原始错误')
  })

  it('ignores a failure that arrives after the chapter changed, and a section of another format', async () => {
    let fail: ((error: Error) => void) | undefined
    const section = vi.fn()
      .mockImplementationOnce(() => new Promise<BookSection>((_resolve, reject) => { fail = reject }))
      .mockImplementationOnce(() => Promise.resolve({ kind: 'pdf', width: 1, height: 1, text: '', lines: [] , skip: [] } as BookSection))
    const { update } = mount({ section })
    update({ position: { section: 2, offset: 0 } })
    fail!(new Error('late'))
    await wait(10)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('正在加载…')).toBeTruthy()
  })

  it('scrolls a hidden reading line into view and the chapter top for its first line', async () => {
    const { update } = mount({ position: { section: 1, offset: 45 } })
    await screen.findByText('第一行')
    await waitFor(() => { expect(scrolls.at(-1)).toMatchObject({ top: 800 - 180, behavior: 'smooth' }) })
    const count = scrolls.length
    update({ position: { section: 1, offset: 45 }, reveal: 2 })
    expect(scrolls).toHaveLength(count)
    update({ position: { section: 1, offset: 0 }, reveal: 3 })
    expect(scrolls.at(-1)?.top).toBe(0)
    measured.lines = []
    update({ fontScale: 2, reveal: 4 })
    expect(scrolls.at(-1)?.top).toBe(0)
    viewport.height = 100
    measured.lines = [{ ...LINES[4]!, top: 5000, bottom: 5030 }]
    update({ fontScale: 3, position: { section: 1, offset: 45 }, reveal: 5 })
    expect(scrolls.at(-1)?.behavior).toBe('auto')
  })

  it('follows a manual scroll with the reading position unless read-aloud drives it', async () => {
    const { props, scroller, update } = mount()
    await screen.findByText('第一行')
    scroller.scrollTop = 700
    fireEvent.scroll(scroller)
    fireEvent.scroll(scroller)
    await wait()
    expect(props.settle).toHaveBeenLastCalledWith({ section: 1, offset: 40 })
    scroller.scrollTop = 900
    fireEvent.scroll(scroller)
    await wait()
    expect(props.settle).toHaveBeenLastCalledWith({ section: 1, offset: 40 })
    scroller.scrollTop = 0
    fireEvent.scroll(scroller)
    await wait()
    expect(props.settle).toHaveBeenCalledTimes(2)
    update({ speaking: true })
    scroller.scrollTop = 700
    fireEvent.scroll(scroller)
    await wait()
    expect(props.settle).toHaveBeenCalledTimes(2)
  })

  it('does not settle while the chapter loads, before its lines are measured, after a chapter change, nor after unmount', async () => {
    measured.lines = []
    const { props, scroller, update, view } = mount()
    fireEvent.scroll(scroller)
    await screen.findByText('第一行')
    fireEvent.scroll(scroller)
    await wait()
    measured.lines = LINES
    update({ fontScale: 1.2 })
    scroller.scrollTop = 700
    fireEvent.scroll(scroller)
    update({ position: { section: 2, offset: 0 } })
    await screen.findByText('第一行')
    await wait()
    fireEvent.scroll(scroller)
    view.unmount()
    await wait()
    expect(props.settle).not.toHaveBeenCalled()
  })

  it('steps line by line and across chapter edges with the arrow keys', async () => {
    const section = vi.fn((index: number) => index === 0
      ? Promise.reject(new Error('missing'))
      : Promise.resolve({ ...CHAPTER, text: 'z'.repeat(index * 7) } as BookSection))
    const { props, scroller, update } = mount({ section, position: { section: 1, offset: 12 } })
    await screen.findByText('第一行')
    fireEvent.keyDown(scroller, { key: 'ArrowDown' })
    expect(props.goTo).toHaveBeenLastCalledWith({ section: 1, offset: 20 })
    fireEvent.keyDown(scroller, { key: 'k' })
    expect(props.goTo).toHaveBeenLastCalledWith({ section: 1, offset: 0 })
    update({ position: { section: 1, offset: 45 } })
    fireEvent.keyDown(scroller, { key: 'j' })
    expect(props.goTo).toHaveBeenLastCalledWith({ section: 2, offset: 0 })
    update({ position: { section: 2, offset: 0 } })
    await screen.findByText('第一行')
    fireEvent.keyDown(scroller, { key: 'ArrowUp' })
    await waitFor(() => { expect(props.goTo).toHaveBeenLastCalledWith({ section: 1, offset: 6 }) })
    update({ position: { section: 2, offset: 45 } })
    fireEvent.keyDown(scroller, { key: 'ArrowDown' })
    update({ position: { section: 1, offset: 0 } })
    await screen.findByText('第一行')
    fireEvent.keyDown(scroller, { key: 'ArrowUp' })
    await wait(20)
    fireEvent.keyDown(scroller, { key: 'PageDown' })
    expect(props.goTo).toHaveBeenCalledTimes(4)
  })

  it('stops at the first chapter start', async () => {
    const { props, scroller } = mount({ position: { section: 0, offset: 0 } })
    await screen.findByText('第一行')
    fireEvent.keyDown(scroller, { key: 'ArrowUp' })
    expect(props.goTo).not.toHaveBeenCalled()
  })

  it('opens links inside the book in place, leaves external links alone, and selects a clicked line', async () => {
    const { props } = mount()
    await screen.findByText('第一行')
    fireEvent.click(screen.getByText('注释'))
    expect(props.followLink).toHaveBeenCalledWith(1, '#note')
    fireEvent.click(screen.getByText('外链'))
    expect(props.followLink).toHaveBeenCalledOnce()
    const article = screen.getByText('第一行').closest('[class*="article"]')!
    fireEvent.click(article, { clientY: 85 })
    expect(props.goTo).toHaveBeenLastCalledWith({ section: 1, offset: 20 })
    fireEvent.click(article, { clientY: 400 })
    expect(props.goTo).toHaveBeenCalledOnce()
    const selection = vi.spyOn(window, 'getSelection').mockReturnValue({ isCollapsed: false } as Selection)
    fireEvent.click(article, { clientY: 5 })
    expect(props.goTo).toHaveBeenCalledOnce()
    selection.mockReturnValue(null)
    fireEvent.click(article, { clientY: 5 })
    expect(props.goTo).toHaveBeenLastCalledWith({ section: 1, offset: 0 })
  })

  it('moves between chapters with the chapter buttons, disabled at the ends', async () => {
    const { props, update } = mount()
    await screen.findByText('第一行')
    fireEvent.click(screen.getByRole('button', { name: '上一章' }))
    fireEvent.click(screen.getByRole('button', { name: '下一章' }))
    expect(props.goTo).toHaveBeenNthCalledWith(1, { section: 0, offset: 0 })
    expect(props.goTo).toHaveBeenNthCalledWith(2, { section: 2, offset: 0 })
    update({ position: { section: 2, offset: 0 } })
    await screen.findByText('第一行')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '下一章' }).disabled).toBe(true)
    update({ position: { section: 0, offset: 0 } })
    await screen.findByText('第一行')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '上一章' }).disabled).toBe(true)
  })
})

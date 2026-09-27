// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BookSection } from '../src/client/book.ts'
import type { ReaderViewProps } from '../src/client/contract.ts'
import type { LibraryState } from '../src/client/library-controller.ts'
import { Observable } from '../src/client/observable.ts'
import type { ReaderState } from '../src/client/reader-controller.ts'
import { ReaderView } from '../src/client/ReaderView.tsx'
import type { SpeechState } from '../src/client/speech-player.ts'
import { createReaderPrefsStore } from '../src/client/stores.ts'
import type { ReaderCapabilities, ReadingPosition } from '../src/types.ts'
import { EPUB_BOOK, EPUB_ID, hookOf, LIST, PDF_BOOK, t } from './reader-fixtures.client.ts'

const views = vi.hoisted(() => ({ pdf: [] as Record<string, unknown>[], epub: [] as Record<string, unknown>[] }))
vi.mock('../src/client/PdfView.tsx', () => ({
  PdfView: (props: Record<string, unknown>) => {
    views.pdf.push(props)
    return <div data-testid="pdf-view" />
  },
}))
vi.mock('../src/client/EpubView.tsx', () => ({
  EpubView: (props: Record<string, unknown>) => {
    views.epub.push(props)
    return <div data-testid="epub-view" />
  },
}))

const SPEECH: ReaderCapabilities = {
  speech: {
    enabled: true,
    voices: [{ id: 'serena' }, { id: 'vivian' }, { id: 'mystery' }],
    defaultVoice: 'serena',
    styles: [
      { id: 'none', instruct: '' }, { id: 'technical', instruct: '讲解' },
      { id: 'loli', instruct: '萝莉' }, { id: 'unlabelled', instruct: '?' },
    ],
    defaultStyle: 'none',
    maxSegmentChars: 120,
    prefetchParagraphs: 1,
    maxRequestSegments: 24,
    segmentGapMs: 0,
  },
  pdfjsBase: '/p/',
}

function readyPdf(position: ReadingPosition = { section: 0, offset: 0 }): Extract<ReaderState, { kind: 'ready' }> {
  return {
    kind: 'ready',
    book: PDF_BOOK,
    format: 'pdf',
    title: '机器学习',
    sectionCount: 3,
    toc: [
      { label: '引言', depth: 0, section: 0 },
      { label: '方法', depth: 1, section: 1 },
      { label: '结论', depth: 0, section: 2 },
    ],
    position,
    fraction: 0.34,
    reveal: 1,
  }
}

function readyEpub(position: ReadingPosition): Extract<ReaderState, { kind: 'ready' }> {
  return {
    kind: 'ready',
    book: EPUB_BOOK,
    format: 'epub',
    title: '围城',
    sectionCount: 2,
    toc: [
      { label: '第一章', depth: 0, section: 0 },
      { label: '第一节', depth: 1, section: 0, fragment: 'one' },
      { label: '第二节', depth: 1, section: 0, fragment: 'two' },
      { label: '丢失的锚点', depth: 1, section: 0, fragment: 'lost' },
      { label: '第二章', depth: 0, section: 1 },
    ],
    position,
    fraction: 0.1,
    reveal: 3,
  }
}

function mount(options: {
  reader: ReaderState
  speech?: SpeechState
  capabilities?: ReaderCapabilities | undefined
  library?: LibraryState
  section?: (index: number) => Promise<BookSection>
}) {
  const reader = new Observable(options.reader)
  const speech = new Observable<SpeechState>(options.speech ?? { status: 'idle' })
  const capabilities = new Observable<ReaderCapabilities | undefined>('capabilities' in options ? options.capabilities : SPEECH)
  const library = new Observable<LibraryState>(options.library ?? { status: 'ready', list: LIST })
  const prefs = createReaderPrefsStore().create()
  const callbacks = {
    ensureLoaded: vi.fn(),
    open: vi.fn(),
    retry: vi.fn(),
    section: vi.fn(options.section ?? (() => Promise.resolve({ kind: 'pdf', width: 1, height: 1, text: '', lines: [], skip: [] } as BookSection))),
    renderPage: vi.fn(),
    pageSize: vi.fn(),
    goTo: vi.fn(),
    goToTarget: vi.fn(),
    followLink: vi.fn(),
    settle: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    setRate: vi.fn(),
  }
  const props = {
    useReader: hookOf(reader),
    useSpeech: hookOf(speech),
    useCapabilities: hookOf(capabilities),
    useLibrary: hookOf(library),
    useStore: hookOf(prefs.store),
    actions: prefs.actions,
    useSessions: undefined as never,
    useWorkspaces: undefined as never,
    t,
    ...callbacks,
  } as unknown as ReaderViewProps
  render(<ReaderView {...props} />)
  return { reader, speech, capabilities, library, prefs, ...callbacks }
}

beforeEach(() => {
  localStorage.clear()
  views.pdf.length = 0
  views.epub.length = 0
})
afterEach(cleanup)

describe('reader view placeholders', () => {
  it('offers to continue the most recently read book', () => {
    const newer = { ...EPUB_BOOK, progress: { ...EPUB_BOOK.progress!, updatedAt: '2026-09-19T05:00:00.000Z' } }
    const older = { ...PDF_BOOK, progress: { position: { section: 0, offset: 0 }, fraction: 0, updatedAt: '2026-09-19T02:00:00.000Z' } }
    const { open, ensureLoaded } = mount({ reader: { kind: 'empty' }, library: { status: 'ready', list: { ...LIST, books: [older, newer, { ...older, id: 'book-y' as never }, { ...PDF_BOOK, id: 'book-x' as never }] } } })
    expect(ensureLoaded).toHaveBeenCalledOnce()
    expect(screen.getByText('从左侧书库选择一本书开始阅读。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '继续阅读：围城' }))
    expect(open).toHaveBeenCalledWith(EPUB_ID)
  })

  it('shows no continuation before the listing loaded or after it failed', () => {
    const { library } = mount({ reader: { kind: 'empty' }, library: { status: 'idle' } })
    expect(screen.queryByRole('button')).toBeNull()
    act(() => { library.set({ status: 'error', message: '离线' }) })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows opening progress and an open failure with a retry', () => {
    const { reader, retry } = mount({ reader: { kind: 'loading', book: PDF_BOOK } })
    expect(screen.getByRole('status').textContent).toContain('正在打开：机器学习…')
    act(() => { reader.set({ kind: 'error', book: PDF_BOOK, message: '文件损坏' }) })
    expect(screen.getByRole('alert').textContent).toContain('无法打开 机器学习：文件损坏')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(retry).toHaveBeenCalledOnce()
  })
})

describe('reader toolbar', () => {
  it('navigates pages, jumps to a typed page, and ignores an invalid one', () => {
    const { goTo, reader } = mount({ reader: readyPdf() })
    expect(screen.getByLabelText('34%').textContent).toBe('34%')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '上一页' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(goTo).toHaveBeenLastCalledWith({ section: 1, offset: 0 })
    const input = screen.getByRole('textbox', { name: '页码' }) as HTMLInputElement
    expect(input.value).toBe('1')
    fireEvent.change(input, { target: { value: '3' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(goTo).toHaveBeenLastCalledWith({ section: 2, offset: 0 })
    fireEvent.change(input, { target: { value: '99' } })
    fireEvent.keyDown(input, { key: 'Tab' })
    fireEvent.blur(input)
    expect(goTo).toHaveBeenCalledTimes(2)
    act(() => { reader.set(readyPdf({ section: 2, offset: 0 })) })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '下一页' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '上一页' }))
    expect(goTo).toHaveBeenLastCalledWith({ section: 1, offset: 0 })
  })

  it('zooms a PDF within its steps and hands the view its props', () => {
    const { prefs } = mount({ reader: readyPdf() })
    fireEvent.click(screen.getByRole('button', { name: '放大' }))
    expect(prefs.store.getSnapshot().pdfZoom).toBe(1.25)
    for (let step = 0; step < 8; step += 1) fireEvent.click(screen.getByRole('button', { name: '缩小' }))
    expect(prefs.store.getSnapshot().pdfZoom).toBe(0.5)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '缩小' }).disabled).toBe(true)
    act(() => { prefs.actions.setPdfZoom(3) })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '放大' }).disabled).toBe(true)
    act(() => { prefs.actions.setPdfZoom(7) })
    fireEvent.click(screen.getByRole('button', { name: '缩小' }))
    expect(prefs.store.getSnapshot().pdfZoom).toBe(3)
    const last = views.pdf.at(-1)!
    expect(last).toMatchObject({ sectionCount: 3, zoom: 3, speaking: false, reveal: 1 })
    ;(last.goTo as (position: ReadingPosition) => void)({ section: 1, offset: 3 })
  })

  it('shows chapters and font sizes for an EPUB and the contents row being read', async () => {
    const section = vi.fn(() => Promise.resolve({ kind: 'epub', html: '', text: '', breaks: [], anchors: { one: 10, two: 50 }, skip: [] } as BookSection))
    const { prefs, reader, speech } = mount({ reader: readyEpub({ section: 0, offset: 30 }), section })
    expect(screen.getByText('第 1 / 2 章')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '增大字号' }))
    expect(prefs.store.getSnapshot().fontScale).toBe(1.15)
    fireEvent.click(screen.getByRole('button', { name: '减小字号' }))
    expect(prefs.store.getSnapshot().fontScale).toBe(1)
    expect(views.epub.at(-1)).toMatchObject({ fontScale: 1, sectionCount: 2 })
    await waitFor(() => { expect(screen.getByTitle('第一节')).toBeTruthy() })
    act(() => { reader.set({ ...readyEpub({ section: 1, offset: 0 }), sentence: { start: 0, end: 12 } }) })
    await waitFor(() => { expect(screen.getByTitle('第二章')).toBeTruthy() })
    expect(views.epub.at(-1)?.sentence).toBeUndefined()
    act(() => { speech.set({ status: 'playing' }) })
    expect(views.epub.at(-1)).toMatchObject({ speaking: true, sentence: { start: 0, end: 12 } })
  })

  it('keeps the section-level contents row until the section anchors load', () => {
    mount({ reader: readyEpub({ section: 0, offset: 99 }), section: () => new Promise(() => undefined) })
    expect(screen.getByTitle('第一章')).toBeTruthy()
  })

  it('shows no chapter label before the first contents row, and survives a section that fails to load', async () => {
    const section = vi.fn(() => Promise.reject(new Error('坏章节')))
    const state = readyPdf()
    mount({ reader: { ...state, toc: [{ label: '后记', depth: 0, section: 2 }] }, section })
    await waitFor(() => { expect(section).toHaveBeenCalled() })
    expect(screen.queryByTitle('后记')).toBeNull()
  })

  it('opens the contents, marks the current row, and navigates from it', () => {
    const { goToTarget } = mount({ reader: readyPdf({ section: 1, offset: 0 }) })
    fireEvent.click(screen.getByRole('button', { name: '目录' }))
    const nav = screen.getByRole('navigation', { name: '目录' })
    const current = nav.querySelector('[aria-current="location"]')!
    expect(current.textContent).toBe('方法')
    fireEvent.click(screen.getByRole('button', { name: '结论' }))
    expect(goToTarget).toHaveBeenCalledWith(2, undefined)
  })

  it('says when a book has no contents', () => {
    mount({ reader: { ...readyPdf(), toc: [] } })
    fireEvent.click(screen.getByRole('button', { name: '目录' }))
    expect(screen.getByText('这本书没有目录。')).toBeTruthy()
  })
})

describe('read-aloud controls', () => {
  it('disables read-aloud when the Host offers none or has not answered', () => {
    const { capabilities } = mount({ reader: readyPdf(), capabilities: { speech: { enabled: false }, pdfjsBase: '/p/' } })
    const disabled = screen.getByRole('button', { name: '朗读未启用：在插件配置中把 speechMode 设为 local。' }) as HTMLButtonElement
    expect(disabled.disabled).toBe(true)
    act(() => { capabilities.set(undefined) })
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('lists the model voices with their descriptions and reads with the chosen one', () => {
    const { play, prefs, setRate } = mount({ reader: readyPdf() })
    const voice = screen.getByRole('combobox', { name: '音色' }) as HTMLSelectElement
    expect([...voice.options].map(option => option.textContent)).toEqual(['Serena · 温柔女声', 'Vivian · 明亮女声', 'mystery'])
    expect(voice.value).toBe('serena')
    fireEvent.change(voice, { target: { value: 'vivian' } })
    expect(prefs.store.getSnapshot().voice).toBe('vivian')
    // A category chosen while nothing is being read is remembered without starting playback.
    const category = screen.getByRole('combobox', { name: '书籍分类' }) as HTMLSelectElement
    expect([...category.options].map(option => option.textContent))
      .toEqual(['不指定', '技术 / 教程', '萝莉音', 'unlabelled'])
    fireEvent.change(category, { target: { value: 'technical' } })
    expect(prefs.store.getSnapshot().styles).toEqual({ [readyPdf().book.id]: 'technical' })
    expect(play).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '从当前行朗读' }))
    expect(play).toHaveBeenCalledWith('vivian', 'technical')
    fireEvent.change(screen.getByRole('combobox', { name: '语速' }), { target: { value: '1.5' } })
    expect(setRate).toHaveBeenLastCalledWith(1.5)
  })

  it('falls back to the default voice when the saved one is gone', () => {
    localStorage.setItem(
      'dsh.ebook-reader.prefs.v2',
      JSON.stringify({ voice: 'retired', styles: {}, rate: 1, pdfZoom: 1, fontScale: 1, tocOpen: false }),
    )
    mount({ reader: readyPdf() })
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '音色' }).value).toBe('serena')
  })

  it('switches the controls with the playback state and restarts on a voice change while reading', () => {
    const reader = { ...readyPdf(), sentence: { start: 3, end: 9 } }
    const { speech, pause, resume, stop, play } = mount({ reader, speech: { status: 'buffering' } })
    expect(screen.getByRole('status').textContent).toBe('正在合成语音…')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '从当前行朗读' }).disabled).toBe(true)
    // The view highlights the sentence only while read-aloud owns the position.
    expect(views.pdf.at(-1)).toMatchObject({ speaking: true, sentence: { start: 3, end: 9 } })
    act(() => { speech.set({ status: 'playing' }) })
    fireEvent.click(screen.getByRole('button', { name: '暂停朗读' }))
    expect(pause).toHaveBeenCalledOnce()
    fireEvent.change(screen.getByRole('combobox', { name: '音色' }), { target: { value: 'vivian' } })
    expect(play).toHaveBeenCalledWith('vivian', 'none')
    // The category restarts reading the same way, and is remembered for this book alone.
    fireEvent.change(screen.getByRole('combobox', { name: '书籍分类' }), { target: { value: 'loli' } })
    expect(play).toHaveBeenLastCalledWith('vivian', 'loli')
    act(() => { speech.set({ status: 'paused' }) })
    fireEvent.click(screen.getByRole('button', { name: '继续朗读' }))
    expect(resume).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '停止朗读' }))
    expect(stop).toHaveBeenCalledOnce()
    act(() => { speech.set({ status: 'error', message: '模型未加载' }) })
    expect(views.pdf.at(-1)?.sentence).toBeUndefined()
    expect(screen.getByRole('alert').textContent).toBe('朗读失败：模型未加载')
    act(() => { speech.set({ status: 'error' }) })
    expect(screen.getByRole('alert').textContent).toBe('朗读失败：')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '停止朗读' }).disabled).toBe(true)
  })
})

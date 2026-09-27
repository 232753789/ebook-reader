// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { httpReaderApi, type ReaderApi } from '../src/client/api.ts'
import type { EpubBook, EpubSection, PdfBook, PdfSection } from '../src/client/book.ts'
import { LibraryController } from '../src/client/library-controller.ts'
import { Observable } from '../src/client/observable.ts'
import { ReaderController, type DocumentOpeners, type ReaderState } from '../src/client/reader-controller.ts'
import { createReaderPrefsStore } from '../src/client/stores.ts'
import type { BookEntry, BookId, BookList, ReadingProgress } from '../src/types.ts'

const PDF_ID = 'book-00000000000000000000000000000001' as BookId
const EPUB_ID = 'book-00000000000000000000000000000002' as BookId
const PDF_BOOK: BookEntry = { id: PDF_ID, title: '手册', format: 'pdf', path: 'a/手册.pdf', size: 1, modifiedAt: '2026-09-19T00:00:00.000Z' }
const EPUB_BOOK: BookEntry = {
  id: EPUB_ID,
  title: '围城',
  format: 'epub',
  path: '围城.epub',
  size: 1,
  modifiedAt: '2026-09-19T00:00:00.000Z',
  progress: { position: { section: 1, offset: 4 }, fraction: 0.6, updatedAt: '2026-09-19T01:00:00.000Z' },
}
const LIST: BookList = { root: '/books', books: [PDF_BOOK, EPUB_BOOK], truncated: false }

/** A fake API whose methods are mocks, so assertions read them as properties. */
function fakeApi(overrides: { books?: Mock<ReaderApi['books']>; saveProgress?: Mock<ReaderApi['saveProgress']> } = {}) {
  const saved: unknown[] = []
  return {
    saved,
    capabilities: vi.fn<ReaderApi['capabilities']>(),
    books: overrides.books ?? vi.fn<ReaderApi['books']>(() => Promise.resolve(LIST)),
    fileUrl: (id: BookId) => `/file/${id}`,
    fileBytes: vi.fn<ReaderApi['fileBytes']>(() => Promise.resolve(new Uint8Array([1]))),
    saveProgress: overrides.saveProgress ?? vi.fn<ReaderApi['saveProgress']>((id, update, keepalive) => {
      saved.push({ id, update, keepalive })
      return Promise.resolve({ ...update, updatedAt: '2026-09-19T02:00:00.000Z' })
    }),
    speech: vi.fn<ReaderApi['speech']>(),
  } satisfies ReaderApi & { saved: unknown[] }
}

const PDF_SECTION: PdfSection = { kind: 'pdf', width: 600, height: 800, text: '0123456789', lines: [] , skip: [] }
const EPUB_SECTION: EpubSection = { kind: 'epub', html: '<p>x</p>', text: '01234567', breaks: [], anchors: { mid: 4 }, skip: [] }

function pdfBook() {
  const book = {
    format: 'pdf' as const,
    title: '手册（元数据）',
    sectionCount: 4,
    toc: [{ label: '一', depth: 0, section: 0 }],
    disposed: 0,
    section: vi.fn(() => Promise.resolve(PDF_SECTION)),
    pageSize: vi.fn(() => ({ width: 600, height: 800 })),
    renderPage: vi.fn(() => ({ done: Promise.resolve(), cancel: vi.fn() })),
    dispose: () => { book.disposed += 1 },
  }
  return book satisfies PdfBook
}

function epubBook(): EpubBook & { disposed: number } {
  const book = {
    format: 'epub' as const,
    title: '围城',
    sectionCount: 3,
    toc: [],
    disposed: 0,
    section: vi.fn(() => Promise.resolve(EPUB_SECTION)),
    resolveHref: vi.fn((_from: number, href: string) => href === 'out' ? undefined : { section: 2, fragment: 'mid' }),
    dispose: () => { book.disposed += 1 },
  }
  return book
}

describe('observable value', () => {
  it('keeps snapshot identity, skips identical sets, and notifies subscribers of changes', () => {
    const value = new Observable({ n: 1 })
    const first = value.getSnapshot()
    const listener = vi.fn()
    const off = value.subscribe(listener)
    value.set(first)
    expect(listener).not.toHaveBeenCalled()
    value.set({ n: 2 })
    expect(listener).toHaveBeenCalledOnce()
    off()
    value.set({ n: 3 })
    expect(listener).toHaveBeenCalledOnce()
  })
})

describe('reader preferences', () => {
  beforeEach(() => { localStorage.clear() })

  it('starts from the defaults and persists every action', () => {
    const { store, actions } = createReaderPrefsStore().create()
    expect(store.getSnapshot()).toEqual({ voice: null, styles: {}, rate: 1, pdfZoom: 1, fontScale: 1, tocOpen: false })
    actions.setVoice('vivian')
    actions.setStyle('book-1', 'technical')
    actions.setRate(1.5)
    actions.setPdfZoom(2)
    actions.setFontScale(1.3)
    actions.toggleToc()
    expect(store.getSnapshot()).toEqual({
      voice: 'vivian', styles: { 'book-1': 'technical' }, rate: 1.5, pdfZoom: 2, fontScale: 1.3, tocOpen: true,
    })
    expect(createReaderPrefsStore().create().store.getSnapshot())
      .toMatchObject({ voice: 'vivian', styles: { 'book-1': 'technical' }, tocOpen: true })
  })
})

describe('HTTP reader API', () => {
  it('calls the Host routes and surfaces route errors', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const responses: Response[] = [
      new Response(JSON.stringify({ speech: { enabled: false }, pdfjsBase: '/p/' })),
      new Response(JSON.stringify(LIST)),
      new Response(new Uint8Array([7, 8])),
      new Response(JSON.stringify({ position: { section: 0, offset: 0 }, fraction: 0, updatedAt: 'now' })),
      new Response(JSON.stringify({ segments: [{ key: 'a'.repeat(64) }] })),
      new Response('flac'),
      new Response(JSON.stringify({ segments: [{ key: 'b'.repeat(64) }] })),
      new Response('', { status: 404 }),
      new Response(JSON.stringify({ error: 'unknown voice: x' }), { status: 400 }),
      new Response('not json', { status: 502 }),
      new Response('', { status: 404 }),
      new Response('{"error":42}', { status: 500 }),
    ]
    const api = httpReaderApi((input, init) => {
      calls.push({ url: input instanceof Request ? input.url : String(input), ...init === undefined ? {} : { init } })
      return Promise.resolve(responses.shift()!)
    })
    expect(await api.capabilities()).toEqual({ speech: { enabled: false }, pdfjsBase: '/p/' })
    expect(await api.books()).toEqual(LIST)
    expect(api.fileUrl(PDF_ID)).toBe(`/ebook-reader/api/books/${PDF_ID}/file`)
    expect([...await api.fileBytes(PDF_ID)]).toEqual([7, 8])
    await api.saveProgress(PDF_ID, { position: { section: 0, offset: 0 }, fraction: 0 }, true)
    expect(calls[3]!.init).toMatchObject({ method: 'PUT', keepalive: true })
    const signal = new AbortController().signal
    const clips = await api.speech({ segments: ['你好'], voice: 'serena', style: 'none' }, signal)
    expect(await clips[0]!.text()).toBe('flac')
    expect(calls[4]!.init).toMatchObject({
      method: 'POST', body: '{"segments":["你好"],"voice":"serena","style":"none"}', signal,
    })
    // The synthesis succeeded but its audio was pruned before the browser fetched it.
    await expect(api.speech({ segments: ['你好'], voice: 'serena', style: 'none' }, signal)).rejects.toThrow('HTTP 404')
    await expect(api.speech({ segments: ['x'], voice: 'x', style: 'none' }, signal)).rejects.toThrow('unknown voice: x')
    await expect(api.books()).rejects.toThrow('HTTP 502')
    await expect(api.fileBytes(PDF_ID)).rejects.toThrow('HTTP 404')
    await expect(api.capabilities()).rejects.toThrow('HTTP 500')
    expect(calls.map(call => call.url)).toEqual([
      '/ebook-reader/api/capabilities',
      '/ebook-reader/api/books',
      `/ebook-reader/api/books/${PDF_ID}/file`,
      `/ebook-reader/api/books/${PDF_ID}/progress`,
      '/ebook-reader/api/speech',
      `/ebook-reader/api/speech/${'a'.repeat(64)}`,
      '/ebook-reader/api/speech',
      `/ebook-reader/api/speech/${'b'.repeat(64)}`,
      '/ebook-reader/api/speech',
      '/ebook-reader/api/books',
      `/ebook-reader/api/books/${PDF_ID}/file`,
      '/ebook-reader/api/capabilities',
    ])
  })
})

describe('library controller', () => {
  it('loads once on first use, keeps the listing while refreshing, and folds in saved progress', async () => {
    let resolve: ((list: BookList) => void) | undefined
    const api = fakeApi({ books: vi.fn(() => new Promise<BookList>((done) => { resolve = done })) })
    const library = new LibraryController(api)
    expect(library.find(PDF_ID)).toBeUndefined()
    library.ensureLoaded()
    library.ensureLoaded()
    expect(api.books).toHaveBeenCalledOnce()
    expect(library.state.getSnapshot()).toEqual({ status: 'loading' })
    resolve!(LIST)
    await vi.waitFor(() => { expect(library.state.getSnapshot().status).toBe('ready') })
    expect(library.find(PDF_ID)).toBe(PDF_BOOK)

    const refresh = library.refresh()
    expect(library.state.getSnapshot()).toEqual({ status: 'loading', list: LIST })
    resolve!(LIST)
    await refresh

    const progress: ReadingProgress = { position: { section: 2, offset: 0 }, fraction: 0.5, updatedAt: 'now' }
    library.applyProgress(PDF_ID, progress)
    expect(library.find(PDF_ID)?.progress).toBe(progress)
    library.applyProgress('book-ffffffffffffffffffffffffffffffff' as BookId, progress)
    expect(library.find(EPUB_ID)).toBe(EPUB_BOOK)
  })

  it('reports failures, keeps a previous listing, and lets the newest refresh win', async () => {
    const pending: { resolve: (list: BookList) => void; reject: (error: unknown) => void }[] = []
    const api = fakeApi({ books: vi.fn(() => new Promise<BookList>((resolve, reject) => { pending.push({ resolve, reject }) })) })
    const library = new LibraryController(api)
    const first = library.refresh()
    pending[0]!.reject('offline')
    await first
    expect(library.state.getSnapshot()).toEqual({ status: 'error', message: 'offline' })
    library.applyProgress(PDF_ID, EPUB_BOOK.progress!)

    const older = library.refresh()
    const newer = library.refresh()
    pending[2]!.resolve(LIST)
    await newer
    pending[1]!.resolve({ ...LIST, books: [] })
    pending.length = 0
    await older
    expect(library.state.getSnapshot()).toEqual({ status: 'ready', list: LIST })

    const failing = library.refresh()
    const winner = library.refresh()
    pending[0]!.reject(new Error('stale failure'))
    await failing
    pending[1]!.reject(new Error('disk gone'))
    await winner
    expect(library.state.getSnapshot()).toEqual({ status: 'error', message: 'disk gone', list: LIST })
  })
})

describe('reader controller', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function reader(overrides: { pdf?: Mock<DocumentOpeners['pdf']>; epub?: Mock<DocumentOpeners['epub']> } = {}) {
    const api = fakeApi()
    const pdf = pdfBook()
    const epub = epubBook()
    const openers = {
      pdf: overrides.pdf ?? vi.fn<DocumentOpeners['pdf']>(() => Promise.resolve(pdf)),
      epub: overrides.epub ?? vi.fn<DocumentOpeners['epub']>(() => epub),
    } satisfies DocumentOpeners
    const saved: [BookEntry, ReadingProgress][] = []
    const controller = new ReaderController(api, openers, (book, progress) => { saved.push([book, progress]) })
    return { api, pdf, epub, openers, controller, saved }
  }

  const ready = (state: ReaderState) => {
    if (state.kind !== 'ready') throw new Error(`reader is ${state.kind}`)
    return state
  }

  it('opens a PDF from its URL at the start and an EPUB from its bytes at the saved position', async () => {
    const { controller, openers, pdf, epub } = reader()
    await controller.open(PDF_BOOK)
    expect(openers.pdf).toHaveBeenCalledWith(`/file/${PDF_ID}`, '手册')
    expect(ready(controller.state.getSnapshot())).toMatchObject({
      book: PDF_BOOK, format: 'pdf', title: '手册（元数据）', sectionCount: 4, position: { section: 0, offset: 0 }, fraction: 0, reveal: 1,
    })
    await controller.open(PDF_BOOK)
    expect(openers.pdf).toHaveBeenCalledOnce()
    await controller.open(EPUB_BOOK)
    expect(pdf.disposed).toBe(1)
    expect(openers.epub).toHaveBeenCalledWith(new Uint8Array([1]), '围城')
    expect(ready(controller.state.getSnapshot())).toMatchObject({ format: 'epub', position: { section: 1, offset: 4 }, fraction: 0.6 })
    controller.dispose()
    expect(epub.disposed).toBe(1)
    expect(controller.state.getSnapshot()).toEqual({ kind: 'empty' })
  })

  it('starts over when the saved section no longer exists, and shows open failures', async () => {
    const { controller } = reader({ epub: vi.fn(() => ({ ...epubBook(), sectionCount: 1 })) })
    await controller.open(EPUB_BOOK)
    expect(ready(controller.state.getSnapshot()).position).toEqual({ section: 0, offset: 0 })
    const failing = reader({ pdf: vi.fn(() => Promise.reject(new Error('not a PDF'))) })
    await failing.controller.open(PDF_BOOK)
    expect(failing.controller.state.getSnapshot()).toEqual({ kind: 'error', book: PDF_BOOK, message: 'not a PDF' })
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the scenario under test.
    const opaque = reader({ pdf: vi.fn(() => Promise.reject('bad bytes')) })
    await opaque.controller.open(PDF_BOOK)
    expect(opaque.controller.state.getSnapshot()).toMatchObject({ kind: 'error', message: 'bad bytes' })
    await opaque.controller.open(PDF_BOOK)
    expect(opaque.openers.pdf).toHaveBeenCalledTimes(2)
  })

  it('discards a document that finishes opening after another book was chosen', async () => {
    let finish: ((book: PdfBook) => void) | undefined
    let failLate: ((error: Error) => void) | undefined
    const late = pdfBook()
    const { controller } = reader({
      pdf: vi.fn()
        .mockImplementationOnce(() => new Promise<PdfBook>((resolve) => { finish = resolve }))
        .mockImplementationOnce(() => new Promise<PdfBook>((_resolve, reject) => { failLate = reject })),
    })
    const first = controller.open(PDF_BOOK)
    await controller.open(EPUB_BOOK)
    finish!(late)
    await first
    expect(late.disposed).toBe(1)
    expect(ready(controller.state.getSnapshot()).book).toBe(EPUB_BOOK)
    const second = controller.open(PDF_BOOK)
    controller.close()
    failLate!(new Error('too late'))
    await second
    expect(controller.state.getSnapshot()).toEqual({ kind: 'empty' })
  })

  it('moves the position, reveals on request, and saves progress once the reader pauses', async () => {
    const { controller, api, saved } = reader()
    await controller.open(PDF_BOOK)
    controller.moveTo({ section: 9, offset: 0 }, true)
    expect(ready(controller.state.getSnapshot()).position).toEqual({ section: 0, offset: 0 })
    await controller.section(1)
    controller.moveTo({ section: 1, offset: 5 }, false)
    const moved = ready(controller.state.getSnapshot())
    expect(moved).toMatchObject({ position: { section: 1, offset: 5 }, fraction: 1.5 / 4, reveal: 1 })
    controller.moveTo({ section: 1, offset: 5 }, false)
    expect(controller.state.getSnapshot()).toBe(moved)
    controller.moveTo({ section: 1, offset: 5 }, true)
    expect(ready(controller.state.getSnapshot()).reveal).toBe(2)
    controller.speak(1, { start: 5, end: 9 })
    const spoken = ready(controller.state.getSnapshot())
    expect(spoken).toMatchObject({ position: { section: 1, offset: 5 }, sentence: { start: 5, end: 9 }, reveal: 3 })
    // A move of its own ends the sentence highlight, even when the position stays put.
    controller.moveTo({ section: 1, offset: 5 }, false)
    expect(ready(controller.state.getSnapshot()).sentence).toBeUndefined()
    controller.moveTo({ section: 2, offset: 50 }, false)
    expect(ready(controller.state.getSnapshot()).fraction).toBe(0.5)
    expect(api.saveProgress).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(api.saved).toEqual([{ id: PDF_ID, update: { position: { section: 2, offset: 50 }, fraction: 0.5 }, keepalive: false }])
    expect(saved[0]![1]).toMatchObject({ fraction: 0.5 })
    controller.flush(true)
    expect(api.saveProgress).toHaveBeenCalledOnce()
    await controller.section(0)
    controller.moveTo({ section: 0, offset: 20 }, false)
    controller.flush(true)
    expect(api.saved.at(-1)).toMatchObject({ update: { fraction: 0.25 }, keepalive: true })
  })

  it('retries a failed save on the next flush', async () => {
    const api = fakeApi({ saveProgress: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ position: { section: 0, offset: 1 }, fraction: 0, updatedAt: 'now' }) })
    const controller = new ReaderController(api, { pdf: () => Promise.resolve(pdfBook()), epub: () => epubBook() }, () => undefined)
    await controller.open(PDF_BOOK)
    controller.moveTo({ section: 0, offset: 1 }, false)
    controller.flush(false)
    await vi.waitFor(() => { expect(api.saveProgress).toHaveBeenCalledOnce() })
    await Promise.resolve()
    controller.flush(false)
    expect(api.saveProgress).toHaveBeenCalledTimes(2)
  })

  it('exposes PDF pages and EPUB links only for the matching format', async () => {
    const { controller, pdf } = reader()
    expect(controller.sectionCount()).toBe(0)
    await expect(controller.section(0)).rejects.toThrow('no book is open')
    expect(controller.pageSize(0)).toBeUndefined()
    await controller.open(PDF_BOOK)
    expect(controller.sectionCount()).toBe(4)
    const canvas = document.createElement('canvas')
    controller.renderPage(1, canvas, 2)
    expect(pdf.renderPage).toHaveBeenCalledWith(1, canvas, 2)
    expect(controller.pageSize(1)).toEqual({ width: 600, height: 800 })
    expect(await controller.followLink(0, 'x')).toBe(false)
    await controller.goToTarget(3, 'ignored')
    expect(ready(controller.state.getSnapshot()).position).toEqual({ section: 3, offset: 0 })

    await controller.open(EPUB_BOOK)
    expect(() => controller.renderPage(0, canvas, 1)).toThrow('not a PDF')
    expect(controller.pageSize(0)).toBeUndefined()
    expect(await controller.followLink(0, 'out')).toBe(false)
    expect(await controller.followLink(0, 'chapter#mid')).toBe(true)
    expect(ready(controller.state.getSnapshot()).position).toEqual({ section: 2, offset: 4 })
    await controller.goToTarget(0, 'absent')
    expect(ready(controller.state.getSnapshot()).position).toEqual({ section: 0, offset: 0 })
    await controller.goToTarget(1)
    expect(ready(controller.state.getSnapshot()).position).toEqual({ section: 1, offset: 0 })
  })
})

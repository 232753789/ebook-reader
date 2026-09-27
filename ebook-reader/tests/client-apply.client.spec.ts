// @vitest-environment jsdom
import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type { EbookReaderPanelInjected, ReaderViewInjected } from '../src/client/contract.ts'
import { apply, inject } from '../src/client/index.ts'
import type { BookList, ReaderCapabilities } from '../src/types.ts'
import { EPUB_BOOK, EPUB_ID, LIST, PDF_ID } from './reader-fixtures.client.ts'

usePinnedBrowserLanguages('zh-CN')

const EPUB_BYTES = zipSync({
  'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'),
  'book.opf': strToU8('<package><manifest><item id="a" href="a.xhtml"/><item id="b" href="b.xhtml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>'),
  'a.xhtml': strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><body><p>第一章。</p><p id="end">第二句。</p></body></html>'),
  'b.xhtml': strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><body><p>第二章。</p></body></html>'),
})

const SPEECH: ReaderCapabilities = {
  speech: {
    enabled: true,
    voices: [{ id: 'serena' }],
    defaultVoice: 'serena',
    styles: [{ id: 'none', instruct: '' }],
    defaultStyle: 'none',
    maxSegmentChars: 50,
    prefetchParagraphs: 0,
    maxRequestSegments: 24,
    segmentGapMs: 0,
  },
  pdfjsBase: 'data:text/javascript,export const GlobalWorkerOptions = {}; export const getDocument = () => ({ promise: Promise.reject(new Error("fixture PDF")) });//',
}

/** Scripted Host routes; each test adjusts the capability answer and records what was asked. */
const host = vi.hoisted(() => ({
  capabilities: [] as (() => Response)[],
  requests: [] as { url: string; method: string; body?: string }[],
  speech: [] as { resolve: (response: Response) => void }[],
}))

function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input)
  host.requests.push({ url, method: init?.method ?? 'GET', ...typeof init?.body === 'string' ? { body: init.body } : {} })
  if (url.endsWith('/capabilities')) return Promise.resolve(host.capabilities.shift()?.() ?? Response.json(SPEECH))
  if (url.endsWith('/books')) return Promise.resolve(Response.json({ ...LIST } satisfies BookList))
  if (url.endsWith(`/books/${EPUB_ID}/file`)) return Promise.resolve(new Response(EPUB_BYTES))
  if (url.endsWith('/progress')) return Promise.resolve(Response.json({ ...JSON.parse(init!.body as string) as object, updatedAt: 'now' }))
  if (url.endsWith('/speech')) return new Promise((resolve) => { host.speech.push({ resolve }) })
  if (url.includes('/speech/')) return Promise.resolve(new Response('flac'))
  return Promise.resolve(new Response('', { status: 404 }))
}

async function bench() {
  const runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.declare({ 'sidebar.panellist': { kind: 'list', scope: 'root' }, main: { kind: 'list', scope: 'root' } })
  const handle = await runtime.mount({ inject: [...inject], apply })
  const tab = runtime.slots.entries('sidebar.panellist')[0]!
  const view = runtime.slots.entries('main')[0]!
  const panel = (view.inject as unknown as (actions: never) => EbookReaderPanelInjected)({} as never)
  const library = panel
  const reader = panel as ReaderViewInjected
  return { runtime, handle, tab, view, library, reader }
}

beforeEach(() => {
  host.capabilities.length = 0
  host.requests.length = 0
  host.speech.length = 0
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockReturnValue(undefined)
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:audio') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const readerKind = (reader: ReaderViewInjected) => reader.hooks.reader.getSnapshot().kind

describe('ebook-reader browser plugin', () => {
  it('registers the library tab and the reader view under one id with a localized label', async () => {
    const { tab, view, handle, runtime } = await bench()
    expect(inject).toEqual(['slots', 'locale'])
    expect(tab.options).toMatchObject({ id: 'ebook-reader', order: 100 })
    expect(view.options).toMatchObject({ key: 'ebook-reader' })
    expect((tab.options.label as () => string)()).toBe('书库')
    expect((view.options.label as () => string)()).toBe('书库')
    await handle.dispose()
    expect(runtime.slots.entries('sidebar.panellist')).toHaveLength(0)
    expect(runtime.slots.entries('main')).toHaveLength(0)
  })

  it('loads the listing and capabilities, opens a listed book, and ignores unknown ids', async () => {
    const { library, reader } = await bench()
    library.open(EPUB_ID)
    expect(readerKind(reader)).toBe('empty')
    library.ensureLoaded()
    reader.ensureLoaded()
    await vi.waitFor(() => { expect(library.hooks.library.getSnapshot().status).toBe('ready') })
    await vi.waitFor(() => { expect(reader.hooks.capabilities.getSnapshot()).toEqual(SPEECH) })
    library.refresh()
    library.open(EPUB_ID)
    await vi.waitFor(() => { expect(readerKind(reader)).toBe('ready') })
    expect(reader.hooks.reader.getSnapshot()).toMatchObject({ sectionCount: 2, position: EPUB_BOOK.progress!.position })
    const section = await reader.section(0)
    expect(section.text).toBe('第一章。第二句。')
  })

  it('reports a PDF the reader cannot open, retries it, and survives a capabilities failure', async () => {
    host.capabilities.push(() => new Response('', { status: 503 }))
    const { library, reader } = await bench()
    reader.ensureLoaded()
    library.ensureLoaded()
    await vi.waitFor(() => { expect(library.hooks.library.getSnapshot().status).toBe('ready') })
    expect(reader.hooks.capabilities.getSnapshot()).toBeUndefined()
    reader.retry()
    library.open(PDF_ID)
    await vi.waitFor(() => { expect(reader.hooks.reader.getSnapshot()).toMatchObject({ kind: 'error', message: 'fixture PDF' }) })
    host.capabilities.push(() => Response.json({ ...SPEECH, pdfjsBase: 'data:text/javascript,export const broken = ;//' }))
    const fresh = await bench()
    fresh.library.ensureLoaded()
    await vi.waitFor(() => { expect(fresh.library.hooks.library.getSnapshot().status).toBe('ready') })
    fresh.library.open(PDF_ID)
    await vi.waitFor(() => { expect(readerKind(fresh.reader)).toBe('error') })
    // A failed PDF.js import is not cached: the retry imports again and fails the same way.
    fresh.reader.retry()
    expect(readerKind(fresh.reader)).toBe('loading')
    await vi.waitFor(() => {
      const state = fresh.reader.hooks.reader.getSnapshot()
      expect(state.kind === 'error' ? state.message : state.kind).toContain('Unexpected token')
    })
  })

  it('reads aloud from the position, restarts after a navigation, and settles only while silent', async () => {
    const { library, reader, handle } = await bench()
    reader.play('serena', 'none')
    reader.goTo({ section: 0, offset: 0 })
    expect(host.speech).toHaveLength(0)
    reader.ensureLoaded()
    library.ensureLoaded()
    await vi.waitFor(() => { expect(reader.hooks.capabilities.getSnapshot()).toEqual(SPEECH) })
    await vi.waitFor(() => { expect(library.hooks.library.getSnapshot().status).toBe('ready') })
    library.open(EPUB_ID)
    await vi.waitFor(() => { expect(readerKind(reader)).toBe('ready') })

    reader.settle({ section: 0, offset: 4 })
    expect(reader.hooks.reader.getSnapshot()).toMatchObject({ position: { section: 0, offset: 4 } })
    reader.play('serena', 'none')
    await vi.waitFor(() => { expect(host.speech).toHaveLength(1) })
    expect(JSON.parse(host.requests.at(-1)!.body!)).toEqual({ segments: ['第二句。'], voice: 'serena', style: 'none' })
    reader.settle({ section: 1, offset: 0 })
    expect(reader.hooks.reader.getSnapshot()).toMatchObject({ position: { section: 0, offset: 4 } })

    reader.goTo({ section: 1, offset: 0 })
    await vi.waitFor(() => { expect(host.speech).toHaveLength(2) })
    expect(JSON.parse(host.requests.at(-1)!.body!)).toEqual({ segments: ['第二章。'], voice: 'serena', style: 'none' })
    host.speech[1]!.resolve(Response.json({ segments: [{ key: 'a'.repeat(64) }] }))
    await vi.waitFor(() => { expect(reader.hooks.speech.getSnapshot().status).toBe('playing') })
    reader.setRate(1.5)
    reader.pause()
    expect(reader.hooks.speech.getSnapshot().status).toBe('paused')
    reader.resume()
    expect(reader.hooks.speech.getSnapshot().status).toBe('playing')

    reader.goToTarget(0, 'end')
    await vi.waitFor(() => { expect(host.speech).toHaveLength(3) })
    expect(JSON.parse(host.requests.at(-1)!.body!)).toEqual({ segments: ['第二句。'], voice: 'serena', style: 'none' })
    reader.goToTarget(9)
    reader.goToTarget(9, 'missing-chapter')
    expect(await reader.followLink(0, 'b.xhtml')).toBe(true)
    await vi.waitFor(() => { expect(host.speech).toHaveLength(4) })
    expect(await reader.followLink(0, 'https://example.com')).toBe(false)
    reader.stop()
    expect(reader.hooks.speech.getSnapshot().status).toBe('idle')
    await reader.followLink(1, 'a.xhtml')
    expect(host.speech).toHaveLength(4)

    window.dispatchEvent(new Event('pagehide'))
    await vi.waitFor(() => { expect(host.requests.some(request => request.method === 'PUT')).toBe(true) })
    await handle.dispose()
    expect(readerKind(reader)).toBe('empty')
  })

  it('reports read-aloud as unavailable when the Host offers none', async () => {
    host.capabilities.push(() => Response.json({ speech: { enabled: false }, pdfjsBase: '/p/' }))
    const { library, reader } = await bench()
    reader.ensureLoaded()
    library.ensureLoaded()
    await vi.waitFor(() => { expect(reader.hooks.capabilities.getSnapshot()?.speech.enabled).toBe(false) })
    await vi.waitFor(() => { expect(library.hooks.library.getSnapshot().status).toBe('ready') })
    library.open(EPUB_ID)
    await vi.waitFor(() => { expect(readerKind(reader)).toBe('ready') })
    reader.play('serena', 'none')
    expect(reader.hooks.speech.getSnapshot()).toEqual({ status: 'error', message: 'read-aloud is unavailable' })
  })

  it('renders PDF pages only through an open PDF', async () => {
    const { reader } = await bench()
    expect(reader.pageSize(0)).toBeUndefined()
    expect(() => reader.renderPage(0, document.createElement('canvas'), 1)).toThrow('not a PDF')
  })
})

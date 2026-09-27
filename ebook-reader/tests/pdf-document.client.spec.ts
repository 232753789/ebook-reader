// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { importPdfJs, openPdf, type PdfJsModule } from '../src/client/pdf-document.ts'

class RenderingCancelledException extends Error {}

interface FakeRender {
  readonly promise: Promise<void>
  cancel: () => void
}

/** A PDF.js stand-in: three 600×800 pages, one outline tree, and scripted renders. */
function fakePdfJs(options: { render?: () => FakeRender; textFails?: number; outline?: null } = {}) {
  let textFailures = options.textFails ?? 0
  const renders: unknown[] = []
  const page = (number: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({
      width: (number === 3 ? 400 : 600) * scale,
      height: 800 * scale,
      convertToViewportPoint: (x: number, y: number) => [x * scale, (800 - y) * scale],
    }),
    getTextContent: () => {
      if (textFailures > 0) {
        textFailures -= 1
        return Promise.reject(new Error('text failed'))
      }
      return Promise.resolve({
        items: [
          { type: 'beginMarkedContent', id: 'x' },
          { str: `第${String(number)}页`, transform: [10, 0, 0, 10, 50, 700], width: 30, hasEOL: false },
        ],
      })
    },
    render: (parameters: unknown) => {
      renders.push(parameters)
      return options.render?.() ?? { promise: Promise.resolve(), cancel: vi.fn() }
    },
  })
  const document = {
    numPages: 3,
    getPage: (number: number) => Promise.resolve(page(number)),
    getOutline: () => Promise.resolve(options.outline === null ? null : [
      { title: '第一章', dest: 'named', items: [{ title: '  ', dest: [2], items: [] }] },
      { title: '坏目标', dest: 'broken', items: [] },
      { title: '无目标', dest: null, items: [] },
      { title: '奇怪目标', dest: ['name'], items: [] },
    ]),
    getDestination: (name: string) => name === 'named' ? Promise.resolve([{ num: 7 }]) : Promise.reject(new Error('no such destination')),
    getPageIndex: () => Promise.resolve(1),
  }
  const destroy = vi.fn(() => Promise.resolve())
  const getDocument = vi.fn(() => ({ promise: Promise.resolve(document), destroy }))
  const pdfjs = { GlobalWorkerOptions: { workerSrc: '' }, RenderingCancelledException, getDocument } as unknown as PdfJsModule
  return { pdfjs, getDocument, destroy, renders }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('PDF documents', () => {
  it('opens with range loading and the PDF.js asset directories, and flattens the outline', async () => {
    const { pdfjs, getDocument } = fakePdfJs()
    const book = await openPdf(pdfjs, '/pdfjs/6/', '/books/x/file', '手册')
    expect(getDocument).toHaveBeenCalledWith({
      url: '/books/x/file',
      cMapUrl: '/pdfjs/6/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs/6/standard_fonts/',
      wasmUrl: '/pdfjs/6/wasm/',
      iccUrl: '/pdfjs/6/iccs/',
      enableXfa: false,
    })
    expect(book).toMatchObject({ format: 'pdf', title: '手册', sectionCount: 3 })
    expect(book.toc).toEqual([
      { label: '第一章', depth: 0, section: 1 },
      { label: '—', depth: 1, section: 2 },
    ])
  })

  it('opens a PDF without an outline', async () => {
    const { pdfjs } = fakePdfJs({ outline: null })
    expect((await openPdf(pdfjs, '/p/', '/f', 't')).toc).toEqual([])
  })

  it('loads each page text once, learns page sizes as pages load, and retries a failed load', async () => {
    const { pdfjs } = fakePdfJs({ textFails: 1 })
    const book = await openPdf(pdfjs, '/pdfjs/6/', '/f', 't')
    expect(book.pageSize(2)).toEqual({ width: 600, height: 800 })
    await expect(book.section(2)).rejects.toThrow('text failed')
    const page = await book.section(2)
    expect(page).toMatchObject({ kind: 'pdf', width: 400, height: 800, text: '第3页' })
    expect(page.lines[0]!.box.left).toBe(50)
    expect(book.pageSize(2)).toEqual({ width: 400, height: 800 })
    expect(await book.section(2)).toBe(page)
  })

  it('renders at the device pixel ratio and swallows only render cancellation', async () => {
    vi.stubGlobal('devicePixelRatio', 2)
    let next: FakeRender = { promise: Promise.resolve(), cancel: vi.fn() }
    const { pdfjs, renders } = fakePdfJs({ render: () => next })
    const book = await openPdf(pdfjs, '/pdfjs/6/', '/f', 't')
    const canvas = document.createElement('canvas')
    await book.renderPage(0, canvas, 1.5).done
    expect([canvas.width, canvas.height, canvas.style.width, canvas.style.height]).toEqual([1800, 2400, '900px', '1200px'])
    expect(renders).toHaveLength(1)

    next = { promise: Promise.reject(new RenderingCancelledException('cancelled')), cancel: vi.fn() }
    const cancelled = book.renderPage(0, canvas, 1)
    await cancelled.done
    cancelled.cancel()
    expect(next.cancel).toHaveBeenCalledOnce()

    next = { promise: Promise.reject(new Error('corrupt page')), cancel: vi.fn() }
    await expect(book.renderPage(1, canvas, 1).done).rejects.toThrow('corrupt page')

    const early = book.renderPage(2, canvas, 1)
    early.cancel()
    await early.done
    expect(renders).toHaveLength(3)
  })

  it('falls back to a device pixel ratio of 1 and destroys the loading task on disposal', async () => {
    vi.stubGlobal('devicePixelRatio', 0)
    const { pdfjs, destroy } = fakePdfJs()
    const book = await openPdf(pdfjs, '/pdfjs/6/', '/f', 't')
    const canvas = document.createElement('canvas')
    await book.renderPage(0, canvas, 1).done
    expect(canvas.width).toBe(600)
    book.dispose()
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('imports PDF.js as a browser module and points it at the worker', async () => {
    const module = await importPdfJs('data:text/javascript,export const GlobalWorkerOptions = {};//')
    expect(module.GlobalWorkerOptions.workerSrc).toBe('data:text/javascript,export const GlobalWorkerOptions = {};//build/pdf.worker.min.mjs')
  })
})

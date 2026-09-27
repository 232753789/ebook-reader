/** PDF documents through PDF.js, loaded at runtime from the Host's versioned PDF.js directory. */

import type * as PdfJs from 'pdfjs-dist'
import type { PdfBook, PdfSection, PageRender, PageSize, TocEntry } from './book.ts'
import { groupPdfLines, type PdfTextItem } from './pdf-lines.ts'

/** The PDF.js module namespace. */
export type PdfJsModule = typeof PdfJs

type OutlineNode = Awaited<ReturnType<PdfJs.PDFDocumentProxy['getOutline']>>[number]

/**
 * Import PDF.js from the Host. The import is a native browser module load: the client bundle
 * does not include PDF.js, and the browser caches the versioned file.
 * @param base - versioned PDF.js directory URL ending in `/`.
 * @returns the PDF.js module with its worker source set.
 */
export async function importPdfJs(base: string): Promise<PdfJsModule> {
  const url = `${base}build/pdf.min.mjs`
  const pdfjs = await import(/* @vite-ignore */ url) as PdfJsModule
  pdfjs.GlobalWorkerOptions.workerSrc = `${base}build/pdf.worker.min.mjs`
  return pdfjs
}

type ContentItem = Awaited<ReturnType<PdfJs.PDFPageProxy['getTextContent']>>['items'][number]

function isTextItem(item: ContentItem): item is Extract<ContentItem, PdfTextItem> {
  return 'str' in item
}

async function flattenOutline(
  document: PdfJs.PDFDocumentProxy,
  nodes: readonly OutlineNode[],
  depth: number,
  into: TocEntry[],
): Promise<void> {
  for (const node of nodes) {
    let section: number | undefined
    try {
      const destination = typeof node.dest === 'string' ? await document.getDestination(node.dest) : node.dest
      const reference: unknown = destination?.[0]
      if (typeof reference === 'number') section = reference
      else if (typeof reference === 'object' && reference !== null) {
        section = await document.getPageIndex(reference as Parameters<PdfJs.PDFDocumentProxy['getPageIndex']>[0])
      }
    } catch {
      // A broken destination leaves the row without a page; its children may still resolve.
    }
    if (section !== undefined) into.push({ label: node.title.trim() || '—', depth, section })
    await flattenOutline(document, node.items as readonly OutlineNode[], depth + 1, into)
  }
}

/**
 * Open a PDF over HTTP; PDF.js fetches byte ranges as pages are needed.
 * @param pdfjs - the imported PDF.js module.
 * @param base - versioned PDF.js directory URL, for CMaps, fonts, and decoders.
 * @param url - the book file URL.
 * @param title - the library title.
 * @returns the opened book.
 */
export async function openPdf(pdfjs: PdfJsModule, base: string, url: string, title: string): Promise<PdfBook> {
  const loading = pdfjs.getDocument({
    url,
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
    iccUrl: `${base}iccs/`,
    enableXfa: false,
  })
  const document = await loading.promise
  const first = (await document.getPage(1)).getViewport({ scale: 1 })
  const firstSize: PageSize = { width: first.width, height: first.height }
  const sizes = new Map<number, PageSize>([[0, firstSize]])
  const sections = new Map<number, Promise<PdfSection>>()
  const toc: TocEntry[] = []
  /* oxlint-disable-next-line typescript/no-unnecessary-condition --
   * The pdf.js types declare an array; a document without an outline resolves to null. */
  await flattenOutline(document, await document.getOutline() ?? [], 0, toc)

  const loadSection = async (index: number): Promise<PdfSection> => {
    const page = await document.getPage(index + 1)
    const viewport = page.getViewport({ scale: 1 })
    const size = { width: viewport.width, height: viewport.height }
    sizes.set(index, size)
    const content = await page.getTextContent()
    const grouped = groupPdfLines(content.items.filter(isTextItem), ([x1, y1, x2, y2]) => [
      ...viewport.convertToViewportPoint(x1, y1) as [number, number],
      ...viewport.convertToViewportPoint(x2, y2) as [number, number],
    ])
    return { kind: 'pdf', ...size, text: grouped.text, lines: grouped.lines, skip: grouped.skip }
  }

  return {
    format: 'pdf',
    title,
    sectionCount: document.numPages,
    toc,
    pageSize: index => sizes.get(index) ?? firstSize,
    section: (index) => {
      let section = sections.get(index)
      if (section === undefined) {
        section = loadSection(index)
        sections.set(index, section)
        // A failed load is retried on the next request instead of being cached.
        section.catch(() => { sections.delete(index) })
      }
      return section
    },
    renderPage: (index, canvas, scale): PageRender => {
      const render: { cancelled: boolean; task?: PdfJs.RenderTask } = { cancelled: false }
      const done = (async () => {
        const page = await document.getPage(index + 1)
        if (render.cancelled) return
        const ratio = window.devicePixelRatio || 1
        const viewport = page.getViewport({ scale: scale * ratio })
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        canvas.style.width = `${String(viewport.width / ratio)}px`
        canvas.style.height = `${String(viewport.height / ratio)}px`
        render.task = page.render({ canvas, viewport })
        try {
          await render.task.promise
        } catch (error) {
          if (!(error instanceof pdfjs.RenderingCancelledException)) throw error
        }
      })()
      return {
        done,
        cancel: () => {
          render.cancelled = true
          render.task?.cancel()
        },
      }
    },
    dispose: () => { void loading.destroy() },
  }
}

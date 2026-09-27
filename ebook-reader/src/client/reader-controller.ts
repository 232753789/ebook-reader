/** The open book: document loading, the reading position, and debounced progress saving. */

import type { BookEntry, BookFormat, ReadingPosition, ReadingProgress } from '../types.ts'
import type { ReaderApi } from './api.ts'
import type { BookDocument, BookSection, EpubBook, PageRender, PdfBook, TocEntry } from './book.ts'
import type { TextSpan } from './reading-text.ts'
import { Observable } from './observable.ts'

/** Delay between the last position change and its progress save. */
const SAVE_DELAY_MS = 1_000

/** Opens documents of each format; injected so the controller runs without PDF.js or archives. */
export interface DocumentOpeners {
  pdf(url: string, title: string): Promise<PdfBook>
  epub(bytes: Uint8Array, title: string): EpubBook
}

/** What the reader view shows. */
export type ReaderState =
  | { readonly kind: 'empty' }
  | { readonly kind: 'loading'; readonly book: BookEntry }
  | { readonly kind: 'error'; readonly book: BookEntry; readonly message: string }
  | {
    readonly kind: 'ready'
    readonly book: BookEntry
    readonly format: BookFormat
    readonly title: string
    readonly sectionCount: number
    readonly toc: readonly TocEntry[]
    readonly position: ReadingPosition
    /** Share of the book before `position`, from 0 to 1. */
    readonly fraction: number
    /** Increments whenever the view should scroll the position into view. */
    readonly reveal: number
    /** The sentence read aloud, while read-aloud drives the position. */
    readonly sentence?: TextSpan
  }

type ReadyState = Extract<ReaderState, { kind: 'ready' }>

/** `exactOptionalPropertyTypes` forbids assigning undefined, so the key leaves with the highlight. */
function omitSentence(state: ReadyState): ReadyState {
  const { sentence: _sentence, ...rest } = state
  return rest
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Owns at most one open document and its reading position. */
export class ReaderController {
  /** Published reader state. */
  readonly state = new Observable<ReaderState>({ kind: 'empty' })
  private document: BookDocument | undefined
  private generation = 0
  private readonly textLengths = new Map<number, number>()
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private unsaved = false

  /**
   * @param api - Host routes.
   * @param openers - document parsers.
   * @param onSaved - receives each stored progress, so the library listing follows it.
   */
  constructor(
    private readonly api: ReaderApi,
    private readonly openers: DocumentOpeners,
    private readonly onSaved: (book: BookEntry, progress: ReadingProgress) => void,
  ) {}

  /**
   * Open a book at its saved position; opening the book already shown does nothing.
   * @param book - listed book.
   * @returns settlement once the book is shown, failed, or superseded.
   */
  async open(book: BookEntry): Promise<void> {
    const state = this.state.getSnapshot()
    if (state.kind !== 'empty' && state.kind !== 'error' && state.book.id === book.id) return
    this.close()
    const generation = ++this.generation
    this.state.set({ kind: 'loading', book })
    let document: BookDocument
    try {
      document = book.format === 'pdf'
        ? await this.openers.pdf(this.api.fileUrl(book.id), book.title)
        : this.openers.epub(await this.api.fileBytes(book.id), book.title)
    } catch (error) {
      if (generation === this.generation) this.state.set({ kind: 'error', book, message: message(error) })
      return
    }
    if (generation !== this.generation) {
      document.dispose()
      return
    }
    this.document = document
    const saved = book.progress
    const resumes = saved !== undefined && saved.position.section < document.sectionCount
    this.state.set({
      kind: 'ready',
      book,
      format: document.format,
      title: document.title,
      sectionCount: document.sectionCount,
      toc: document.toc,
      position: resumes ? saved.position : { section: 0, offset: 0 },
      fraction: resumes ? saved.fraction : 0,
      reveal: 1,
    })
  }

  /**
   * The share of the book before a position; within a section it counts reading-text offsets
   * once the section was loaded, and treats the section as unstarted before that.
   */
  private fractionOf(position: ReadingPosition, sectionCount: number): number {
    const length = this.textLengths.get(position.section) ?? 0
    const within = length === 0 ? 0 : Math.min(1, position.offset / length)
    return Math.min(1, (position.section + within) / sectionCount)
  }

  /** Save pending progress, release the document, and show nothing. */
  close(): void {
    this.flush(false)
    this.generation += 1
    this.document?.dispose()
    this.document = undefined
    this.textLengths.clear()
    this.state.set({ kind: 'empty' })
  }

  /**
   * Count the open book's sections: PDF pages or EPUB spine chapters.
   * @returns the open book's section count, 0 when no book is open.
   */
  sectionCount(): number {
    return this.document?.sectionCount ?? 0
  }

  /**
   * Load one section of the open book.
   * @param index - zero-based section.
   * @returns the section.
   */
  async section(index: number): Promise<BookSection> {
    const document = this.document
    if (document === undefined) throw new Error('ebook-reader: no book is open')
    const section = await document.section(index)
    this.textLengths.set(index, section.text.length)
    return section
  }

  /**
   * Draw a page of the open PDF.
   * @param index - zero-based page.
   * @param canvas - target canvas.
   * @param scale - CSS pixels per PDF point.
   * @returns the in-flight render.
   */
  renderPage(index: number, canvas: HTMLCanvasElement, scale: number): PageRender {
    const document = this.document
    if (document?.format !== 'pdf') throw new Error('ebook-reader: the open book is not a PDF')
    return document.renderPage(index, canvas, scale)
  }

  /**
   * Size a PDF page at scale 1; pages not yet loaded report the first page's size.
   * @param index - zero-based page of the open PDF.
   * @returns the page size known so far, or undefined when no PDF is open.
   */
  pageSize(index: number): { width: number; height: number } | undefined {
    return this.document?.format === 'pdf' ? this.document.pageSize(index) : undefined
  }

  /**
   * Resolve a link inside an EPUB chapter and move there.
   * @param from - the section holding the link.
   * @param href - the link's raw `href`.
   * @returns whether the link pointed into the book.
   */
  async followLink(from: number, href: string): Promise<boolean> {
    const document = this.document
    if (document?.format !== 'epub') return false
    const target = document.resolveHref(from, href)
    if (target === undefined) return false
    await this.goToTarget(target.section, target.fragment)
    return true
  }

  /**
   * Move to a section, or to an element id inside an EPUB section.
   * @param section - zero-based section.
   * @param fragment - EPUB element id.
   */
  async goToTarget(section: number, fragment?: string): Promise<void> {
    let offset = 0
    if (fragment !== undefined) {
      const loaded = await this.section(section)
      offset = loaded.kind === 'epub' ? loaded.anchors[fragment] ?? 0 : 0
    }
    this.moveTo({ section, offset }, true)
  }

  /**
   * Change the reading position and schedule its progress save; the sentence highlight ends here.
   * @param position - the new position; it must lie inside the open book.
   * @param reveal - whether the view scrolls the position into view.
   */
  moveTo(position: ReadingPosition, reveal: boolean): void {
    this.place(position, reveal, undefined)
  }

  /**
   * Follow read-aloud to the sentence it started playing.
   * @param section - zero-based section holding the sentence.
   * @param sentence - its span of that section's reading text.
   */
  speak(section: number, sentence: TextSpan): void {
    this.place({ section, offset: sentence.start }, true, sentence)
  }

  private place(position: ReadingPosition, reveal: boolean, sentence: TextSpan | undefined): void {
    const state = this.state.getSnapshot()
    if (state.kind !== 'ready' || position.section >= state.sectionCount) return
    const settled = position.section === state.position.section && position.offset === state.position.offset
    if (settled && !reveal && state.sentence === undefined) return
    const moved = {
      ...state,
      position,
      fraction: this.fractionOf(position, state.sectionCount),
      reveal: reveal ? state.reveal + 1 : state.reveal,
    }
    this.state.set(sentence === undefined ? omitSentence(moved) : { ...moved, sentence })
    this.unsaved = true
    if (this.saveTimer !== undefined) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => { this.flush(false) }, SAVE_DELAY_MS)
  }

  /**
   * Save the pending position now.
   * @param keepalive - lets the request outlive the page.
   */
  flush(keepalive: boolean): void {
    if (this.saveTimer !== undefined) clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    const state = this.state.getSnapshot()
    if (!this.unsaved || state.kind !== 'ready') return
    this.unsaved = false
    const { book, position, fraction } = state
    this.api.saveProgress(book.id, { position, fraction }, keepalive).then(
      (progress) => { this.onSaved(book, progress) },
      // A failed save leaves the position unsaved, so the next flush retries it.
      () => { this.unsaved = true },
    )
  }

  /** Save pending progress and release the document. */
  dispose(): void {
    this.close()
  }
}

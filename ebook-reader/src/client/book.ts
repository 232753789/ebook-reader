/** The opened-book interface both document formats implement for the reader. */

import type { TextSpan } from './reading-text.ts'
import type { PdfLine } from './pdf-lines.ts'

/** One table-of-contents row. */
export interface TocEntry {
  readonly label: string
  /** Nesting level, 0 for top-level rows. */
  readonly depth: number
  readonly section: number
  /** EPUB element id inside the section, when the row points below the section start. */
  readonly fragment?: string
}

/** Page size in CSS pixels at scale 1. */
export interface PageSize {
  readonly width: number
  readonly height: number
}

/** A PDF page's reading text, lines, and size. */
export interface PdfSection extends PageSize {
  readonly kind: 'pdf'
  readonly text: string
  readonly lines: readonly PdfLine[]
  /** Spans of `text` that are not body prose; read-aloud skips them. */
  readonly skip: readonly TextSpan[]
}

/** An EPUB chapter's sanitized markup and the reading text of its text nodes. */
export interface EpubSection {
  readonly kind: 'epub'
  /** Sanitized chapter body markup; its text nodes, in document order, concatenate to `text`. */
  readonly html: string
  readonly text: string
  /** Ascending offsets where a block element's text starts; read-aloud never joins across one. */
  readonly breaks: readonly number[]
  /** Offset of the text following each element id. */
  readonly anchors: Readonly<Record<string, number>>
  /** Spans of `text` that are code rather than prose; read-aloud skips them. */
  readonly skip: readonly TextSpan[]
}

/** An in-flight page render that can be abandoned. */
export interface PageRender {
  readonly done: Promise<void>
  cancel(): void
}

interface BookDocumentBase {
  readonly title: string
  /** PDF pages or EPUB spine items. */
  readonly sectionCount: number
  readonly toc: readonly TocEntry[]
  /** Release the parsed document and every object URL it created. */
  dispose(): void
}

/** An opened PDF. */
export interface PdfBook extends BookDocumentBase {
  readonly format: 'pdf'
  /**
   * Load one page's text and size; repeated calls share one load.
   * @param index - zero-based page.
   */
  section(index: number): Promise<PdfSection>
  /**
   * A page's size: exact once the page was loaded, otherwise the first page's.
   * @param index - zero-based page.
   */
  pageSize(index: number): PageSize
  /**
   * Draw a page into a canvas at a CSS scale, at the device pixel ratio.
   * @param index - zero-based page.
   * @param canvas - target canvas; its size and CSS size are set here.
   * @param scale - CSS pixels per PDF point.
   */
  renderPage(index: number, canvas: HTMLCanvasElement, scale: number): PageRender
}

/** An opened EPUB. */
export interface EpubBook extends BookDocumentBase {
  readonly format: 'epub'
  /**
   * Load one chapter; repeated calls share one load.
   * @param index - zero-based spine item.
   */
  section(index: number): Promise<EpubSection>
  /**
   * Resolve a link found in a chapter to a place in this book.
   * @param from - the section holding the link.
   * @param href - the link's raw `href`.
   * @returns the target, or undefined for a link leaving the book.
   */
  resolveHref(from: number, href: string): { readonly section: number; readonly fragment?: string } | undefined
}

/** An opened book of either format. */
export type BookDocument = PdfBook | EpubBook

/** Any section of either format. */
export type BookSection = PdfSection | EpubSection

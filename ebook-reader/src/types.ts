import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque identifier for one book file in the configured library directory. */
export type BookId = Branded<'BookId'>

/** Book file formats the reader opens. */
export type BookFormat = 'pdf' | 'epub'

/**
 * A reading location that survives relayout.
 *
 * `section` is the zero-based PDF page or EPUB spine item. `offset` is a UTF-16 offset into that
 * section's reading text: the PDF page's lines joined by `\n`, or the concatenated text nodes of
 * the sanitized EPUB chapter.
 */
export interface ReadingPosition {
  readonly section: number
  readonly offset: number
}

/** Durable reading progress of one book. */
export interface ReadingProgress {
  readonly position: ReadingPosition
  /** Share of the book before `position`, from 0 to 1. */
  readonly fraction: number
  /** Instant the progress was last saved. */
  readonly updatedAt: string
}

/** Progress fields the browser sends; the Host stamps `updatedAt`. */
export interface ReadingProgressUpdate {
  readonly position: ReadingPosition
  readonly fraction: number
}

/** One book of the library listing. */
export interface BookEntry {
  readonly id: BookId
  /** File name without its extension. */
  readonly title: string
  readonly format: BookFormat
  /** Path relative to the library directory, with `/` separators. */
  readonly path: string
  /** File size in bytes. */
  readonly size: number
  /** Instant the file was last modified. */
  readonly modifiedAt: string
  /** Saved progress, absent before the book was first read. */
  readonly progress?: ReadingProgress
}

/** Library listing returned by the collection route. */
export interface BookList {
  /** Absolute library directory the listing scanned. */
  readonly root: string
  /** Books sorted by path. */
  readonly books: readonly BookEntry[]
  /** Whether more books exist than `listMaxBooks` allows. */
  readonly truncated: boolean
}

/** One speaker of the configured Qwen3-TTS CustomVoice model. */
export interface SpeechVoice {
  /** Speaker id from the model's `talker_config.spk_id` table, lower case. */
  readonly id: string
  /** Dialect the speaker is tuned for, when the model marks one. */
  readonly dialect?: string
}

/** One reading style the voice menu offers beside the speaker. */
export interface SpeechStyle {
  /** Stable category id the browser sends back and labels itself. */
  readonly id: string
  /** Qwen3-TTS style instruction sent with every segment read under this category; empty sends none. */
  readonly instruct: string
}

/** Read-aloud settings the browser needs, or the disabled marker. */
export type SpeechCapabilities =
  | { readonly enabled: false }
  | {
    readonly enabled: true
    readonly voices: readonly SpeechVoice[]
    readonly defaultVoice: string
    /** Reading styles in menu order; the browser sends one back as `style`. */
    readonly styles: readonly SpeechStyle[]
    /** The style a book reads with until the reader picks another. */
    readonly defaultStyle: string
    /** Longest text one synthesis request may carry. */
    readonly maxSegmentChars: number
    /** Paragraphs synthesized ahead of the one playing. */
    readonly prefetchParagraphs: number
    /** Most segments one synthesis request may carry. */
    readonly maxRequestSegments: number
    /** Silence held between one segment's audio and the next. */
    readonly segmentGapMs: number
  }

/** Capabilities route response. */
export interface ReaderCapabilities {
  readonly speech: SpeechCapabilities
  /**
   * Versioned URL directory serving the PDF.js distribution (`build/`, `cmaps/`,
   * `standard_fonts/`, `wasm/`, `iccs/`), ending in `/`.
   */
  readonly pdfjsBase: string
}

/** Body of one synthesis request: the segments of one group, generated together. */
export interface SpeechRequest {
  /** Segment texts in reading order. */
  readonly segments: readonly string[]
  readonly voice: string
  /** Reading-style id; an unknown id is refused. */
  readonly style: string
}

/** Synthesis response: where each requested segment's audio is served from. */
export interface SpeechResponse {
  /** One entry per requested segment, in the same order. */
  readonly segments: readonly { readonly key: string }[]
}

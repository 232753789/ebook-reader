/** The Host runtime behind the routes: library listing, progress, and read-aloud synthesis. */

import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import type { ResolvedConfig } from './config.ts'
import { scanLibrary, type LibraryFile } from './library.ts'
import { ProgressStore } from './progress.ts'
import type { SpeechEngine } from './speech.ts'
import { SpeechSynthesizer } from './speech.ts'
import { DEFAULT_SPEECH_STYLE, SPEECH_STYLES } from './styles.ts'
import type {
  BookEntry, BookId, BookList, ReaderCapabilities, ReadingProgress, ReadingProgressUpdate,
} from './types.ts'

/** Route prefix owned by the ebook-reader Host plugin. */
export const EBOOK_API_PREFIX = '/ebook-reader/api'

const pdfjsPackage = createRequire(import.meta.url)('pdfjs-dist/package.json') as { version: string }

/** Installed PDF.js distribution: its directory and the version that names its URL directory. */
export const PDFJS = {
  directory: dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
  version: pdfjsPackage.version,
} as const

/** Owns one resolved configuration's library view, progress store, and synthesizer. */
export class EbookReaderRuntime {
  private readonly progress: ProgressStore
  private files = new Map<BookId, LibraryFile>()
  /** The synthesizer, absent while `speechMode` is `off`. */
  readonly speech: SpeechSynthesizer | undefined

  /**
   * @param config - resolved settings.
   * @param engine - synthesis engine, required exactly when speech is enabled.
   * @param report - receives background failures that never fail a request.
   */
  constructor(
    readonly config: ResolvedConfig,
    engine: SpeechEngine | undefined,
    report: (error: Error) => void,
  ) {
    this.progress = new ProgressStore(config.storageRoot)
    this.speech = config.speech === undefined || engine === undefined
      ? undefined
      : new SpeechSynthesizer(config.speech, config.storageRoot, engine, report)
  }

  /**
   * Describe the reader features this configuration enables.
   * @returns what the browser needs to render the reader and drive read-aloud.
   */
  capabilities(): ReaderCapabilities {
    const speech = this.config.speech
    return {
      speech: speech === undefined || this.speech === undefined
        ? { enabled: false }
        : {
          enabled: true,
          voices: speech.voices,
          defaultVoice: speech.defaultVoice,
          styles: SPEECH_STYLES,
          defaultStyle: DEFAULT_SPEECH_STYLE,
          maxSegmentChars: speech.maxSegmentChars,
          prefetchParagraphs: speech.prefetchParagraphs,
          maxRequestSegments: speech.maxRequestSegments,
          segmentGapMs: speech.segmentGapMs,
        },
      pdfjsBase: `${EBOOK_API_PREFIX}/pdfjs/${PDFJS.version}/`,
    }
  }

  /**
   * Scan the library and attach each book's saved progress.
   * @returns the listing.
   */
  async list(): Promise<BookList> {
    const scan = await scanLibrary(this.config.libraryRoot, this.config.listMaxBooks)
    this.files = new Map(scan.files.map(file => [file.id, file]))
    const books = await Promise.all(scan.files.map(async (file): Promise<BookEntry> => {
      const progress = await this.progress.read(file.id)
      const entry: BookEntry = {
        id: file.id,
        title: file.title,
        format: file.format,
        path: file.path,
        size: file.size,
        modifiedAt: file.modifiedAt,
      }
      return progress === undefined ? entry : { ...entry, progress }
    }))
    return { root: this.config.libraryRoot, books, truncated: scan.truncated }
  }

  /**
   * Find a listed book, rescanning once when the id is not from the latest listing.
   * @param id - validated book id.
   * @returns the book file, or undefined when no such book exists.
   */
  async find(id: BookId): Promise<LibraryFile | undefined> {
    const known = this.files.get(id)
    if (known !== undefined) return known
    await this.list()
    return this.files.get(id)
  }

  /**
   * Save a book's progress.
   * @param file - the book.
   * @param update - validated position and fraction.
   * @returns the stored progress.
   */
  saveProgress(file: LibraryFile, update: ReadingProgressUpdate): Promise<ReadingProgress> {
    return this.progress.write(file.id, file.path, update, new Date())
  }

  /** Stop the synthesizer and await its quiescence. */
  async dispose(): Promise<void> {
    await this.speech?.dispose()
  }
}

/** Component props of the library tab and the reader view: injected data sources and callbacks. */

import type { HostObservable, InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the sidebar icon and keyed main panel SlotMap rows these entries register into.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { BookId, ReaderCapabilities, ReadingPosition } from '../types.ts'
import type { BookSection, PageRender, PageSize } from './book.ts'
import type { LibraryState } from './library-controller.ts'
import type { ReaderState } from './reader-controller.ts'
import type { SpeechState } from './speech-player.ts'
import type { createReaderPrefsStore } from './stores.ts'

/** Injected share of the library tab. */
export interface LibraryPanelInjected {
  hooks: {
    library: HostObservable<LibraryState>
    reader: HostObservable<ReaderState>
  }
  /** Load the listing if it was never loaded. */
  ensureLoaded: () => void
  /** Rescan the library directory. */
  refresh: () => void
  /** Open a listed book in the reader view. */
  open: (id: BookId) => void
}

/** Library tab component props. */
export type LibraryPanelProps =
  PropsRuntime<'main'> & InjectFace<LibraryPanelInjected> & PropsLocale<'ebook-reader'>

/** Injected share of the reader view. */
export interface ReaderViewInjected {
  hooks: {
    reader: HostObservable<ReaderState>
    speech: HostObservable<SpeechState>
    library: HostObservable<LibraryState>
    /** Undefined until the Host answered, or when it could not be reached. */
    capabilities: HostObservable<ReaderCapabilities | undefined>
  }
  /** Load the capabilities and the listing if they were never loaded. */
  ensureLoaded: () => void
  /** Open a listed book. */
  open: (id: BookId) => void
  /** Reopen the book whose opening failed. */
  retry: () => void
  /** Load one section of the open book. */
  section: (index: number) => Promise<BookSection>
  /** Draw a page of the open PDF. */
  renderPage: (index: number, canvas: HTMLCanvasElement, scale: number) => PageRender
  /** A page size of the open PDF. */
  pageSize: (index: number) => PageSize | undefined
  /** Navigate: move and reveal the position; a read-aloud run restarts there. */
  goTo: (position: ReadingPosition) => void
  /** Navigate to a table-of-contents row or an EPUB element id. */
  goToTarget: (section: number, fragment?: string) => void
  /** Follow a link inside an EPUB chapter; resolves false for a link leaving the book. */
  followLink: (from: number, href: string) => Promise<boolean>
  /** Record the position the reader scrolled to; ignored during read-aloud. */
  settle: (position: ReadingPosition) => void
  /** Read aloud from the current position with the chosen speaker and reading style. */
  play: (voice: string, style: string) => void
  pause: () => void
  resume: () => void
  stop: () => void
  setRate: (rate: number) => void
}

/** Reader view component props. */
export type ReaderViewProps =
  PropsRuntime<'main'>
  & PropsStore<ReturnType<typeof createReaderPrefsStore>>
  & InjectFace<ReaderViewInjected>
  & PropsLocale<'ebook-reader'>

/** Combined injection face used by the single Desktop panel. */
export interface EbookReaderPanelInjected extends ReaderViewInjected {
  refresh: () => void
}

export type EbookReaderPanelProps =
  PropsRuntime<'main'>
  & PropsStore<ReturnType<typeof createReaderPrefsStore>>
  & InjectFace<EbookReaderPanelInjected>
  & PropsLocale<'ebook-reader'>

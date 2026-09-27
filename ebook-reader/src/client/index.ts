/** Library sidebar tab and reader main view of the ebook-reader plugin. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { BookId, ReaderCapabilities, ReadingPosition } from '../types.ts'
import { httpReaderApi } from './api.ts'
import type { EbookReaderPanelInjected } from './contract.ts'
import { openEpub } from './epub-document.ts'
import { LibraryController } from './library-controller.ts'
import { EbookReaderPanel } from './EbookReaderPanel.tsx'
import { LibraryPanelIcon } from './LibraryPanelIcon.tsx'
import { en, zh, type EbookReaderKey } from './locales.ts'
import { Observable } from './observable.ts'
import { importPdfJs, openPdf, type PdfJsModule } from './pdf-document.ts'
import { ReaderController } from './reader-controller.ts'
import { SpeechPlayer } from './speech-player.ts'
import { createReaderPrefsStore } from './stores.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Library tab, reader toolbar, read-aloud, and voice copy. */
    'ebook-reader': EbookReaderKey
  }
}

const NS = 'ebook-reader'
type ClientContext = any
/** The id shared by the sidebar entry and the keyed main panel. */
const VIEW_ID = 'ebook-reader'

/** Required slot and locale services. */
export const inject = ['slots', 'locale']

/**
 * Register the library tab and the reader view, sharing one library, reader, and read-aloud player.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ebook-reader: dictionaries')
  const t = ctx.locale.bind(NS)
  const api = httpReaderApi((input, init) => fetch(input, init))
  const library = new LibraryController(api)

  const capabilities = new Observable<ReaderCapabilities | undefined>(undefined)
  let capabilitiesRequest: Promise<ReaderCapabilities> | undefined
  const loadCapabilities = (): Promise<ReaderCapabilities> => {
    capabilitiesRequest ??= api.capabilities().then(
      (loaded) => {
        capabilities.set(loaded)
        return loaded
      },
      (error: unknown) => {
        capabilitiesRequest = undefined
        throw error
      },
    )
    return capabilitiesRequest
  }
  let pdfjs: Promise<PdfJsModule> | undefined
  const reader = new ReaderController(api, {
    pdf: async (url, title) => {
      const { pdfjsBase } = await loadCapabilities()
      pdfjs ??= importPdfJs(pdfjsBase).catch((error: unknown) => {
        pdfjs = undefined
        throw error
      })
      return await openPdf(await pdfjs, pdfjsBase, url, title)
    },
    epub: (bytes, title) => openEpub(bytes, title),
  }, (book, progress) => { library.applyProgress(book.id, progress) })

  const speech = new SpeechPlayer(api, {
    sectionCount: () => reader.sectionCount(),
    section: index => reader.section(index),
    spoken: (section, sentence) => { reader.speak(section, sentence) },
  }, () => {
    const settings = capabilities.getSnapshot()?.speech
    return settings?.enabled === true ? settings : undefined
  }, new Audio())
  let voiceInUse = ''
  let styleInUse = ''

  const currentPosition = (): ReadingPosition | undefined => {
    const state = reader.state.getSnapshot()
    return state.kind === 'ready' ? state.position : undefined
  }
  // A navigation during read-aloud continues reading from the new position.
  const followNavigation = (): void => {
    const position = currentPosition()
    if (position !== undefined && speech.active()) speech.play(position, voiceInUse, styleInUse)
  }
  const openBook = (id: BookId): void => {
    const book = library.find(id)
    if (book === undefined) return
    speech.stop()
    void reader.open(book)
  }

  ctx.effect(() => {
    const onPageHide = (): void => { reader.flush(true) }
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      speech.dispose()
      reader.dispose()
    }
  }, 'ebook-reader: reader and read-aloud lifetime')

  const panelInject = (): EbookReaderPanelInjected => ({
    hooks: { reader: reader.state, speech: speech.state, library: library.state, capabilities },
    ensureLoaded: () => {
      // A failed capabilities request leaves read-aloud disabled; the next mount retries it.
      loadCapabilities().catch(() => undefined)
      library.ensureLoaded()
    },
    refresh: () => { void library.refresh() },
    open: openBook,
    retry: () => {
      const state = reader.state.getSnapshot()
      if (state.kind === 'error') void reader.open(state.book)
    },
    section: index => reader.section(index),
    renderPage: (index, canvas, scale) => reader.renderPage(index, canvas, scale),
    pageSize: index => reader.pageSize(index),
    goTo: (position) => { reader.moveTo(position, true); followNavigation() },
    goToTarget: (section, fragment) => {
      void reader.goToTarget(section, fragment).then(followNavigation, () => undefined)
    },
    followLink: async (from, href) => {
      const moved = await reader.followLink(from, href)
      if (moved) followNavigation()
      return moved
    },
    settle: (position) => { if (!speech.active()) reader.moveTo(position, false) },
    play: (voice, style) => {
      const position = currentPosition()
      if (position === undefined) return
      voiceInUse = voice
      styleInUse = style
      speech.play(position, voice, style)
    },
    pause: () => { speech.pause() },
    resume: () => { speech.resume() },
    stop: () => { speech.stop() },
    setRate: (rate) => { speech.setRate(rate) },
  })

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: VIEW_ID,
    order: 100,
    label: () => t('tab.label'),
    locale: NS,
  }, LibraryPanelIcon))

  const prefs = createReaderPrefsStore()
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: VIEW_ID,
    locale: NS,
    store: prefs,
    inject: panelInject,
  }, EbookReaderPanel))
}

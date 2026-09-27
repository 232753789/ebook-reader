/** Per-browser reader preferences: voice, reading style, playback rate, zoom, font size, and the contents panel. */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** Playback rates the rate menu offers. */
export const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2] as const
/** PDF zoom factors over the fit-to-width scale. */
export const PDF_ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const
/** EPUB font-size factors over the reader's base size. */
export const FONT_SCALES = [0.85, 1, 1.15, 1.3, 1.5, 1.75] as const

/** Reader preference state. */
export interface ReaderPrefs {
  /** Chosen speaker id; null follows the Host's default voice. */
  voice: string | null
  /** Reading style per book id; a book absent from the map follows the Host's default style. */
  styles: Record<string, string>
  rate: number
  pdfZoom: number
  fontScale: number
  tocOpen: boolean
}

type ReaderPrefsActions = {
  setVoice: (draft: ReaderPrefs, voice: string) => void
  setStyle: (draft: ReaderPrefs, book: string, style: string) => void
  setRate: (draft: ReaderPrefs, rate: number) => void
  setPdfZoom: (draft: ReaderPrefs, zoom: number) => void
  setFontScale: (draft: ReaderPrefs, scale: number) => void
  toggleToc: (draft: ReaderPrefs) => void
}

/**
 * Create the preference store handle, persisted in this browser's localStorage.
 * @returns the store handle.
 */
export function createReaderPrefsStore(): EngineStoreHandle<ReaderPrefs, ReaderPrefsActions> {
  return defineStore({
    init: (): ReaderPrefs => ({ voice: null, styles: {}, rate: 1, pdfZoom: 1, fontScale: 1, tocOpen: false }),
    persist: 'dsh.ebook-reader.prefs.v2',
    actions: {
      setVoice: (d, voice: string) => { d.voice = voice },
      setStyle: (d, book: string, style: string) => { d.styles[book] = style },
      setRate: (d, rate: number) => { d.rate = rate },
      setPdfZoom: (d, zoom: number) => { d.pdfZoom = zoom },
      setFontScale: (d, scale: number) => { d.fontScale = scale },
      toggleToc: (d) => { d.tocOpen = !d.tocOpen },
    },
  })
}

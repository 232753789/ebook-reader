/** Browser test fixtures: selector hooks over value sources, the Chinese translate seat, and sample books. */

import { useSyncExternalStore } from 'react'
import type { HostObservable, SnapshotSelectorHook, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'ebook-reader' LocaleNamespaceMap merge the components' translate seat reads.
import type {} from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'
import type { BookEntry, BookId, BookList } from '../src/types.ts'

/**
 * Bind a value source into the selector hook the slot renderer would inject.
 * @param source - the observable value.
 * @returns the selector hook.
 */
export function hookOf<T>(source: HostObservable<T>): SnapshotSelectorHook<T> {
  return function useSelected<S>(select: (snapshot: T) => S): S {
    return select(useSyncExternalStore(listener => source.subscribe(listener), () => source.getSnapshot()))
  }
}

/** The locale seat over the Chinese dictionary, with `{name}` interpolation; shared keys echo themselves. */
export const t: TranslateNS<'ebook-reader'> = (key, params) =>
  ((zh as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_match: string, name: string) => String(params?.[name]))

export const PDF_ID = 'book-00000000000000000000000000000001' as BookId
export const EPUB_ID = 'book-00000000000000000000000000000002' as BookId

export const PDF_BOOK: BookEntry = {
  id: PDF_ID, title: '机器学习', format: 'pdf', path: '技术/机器学习.pdf', size: 10, modifiedAt: '2026-09-19T00:00:00.000Z',
}
export const EPUB_BOOK: BookEntry = {
  id: EPUB_ID,
  title: '围城',
  format: 'epub',
  path: '围城.epub',
  size: 10,
  modifiedAt: '2026-09-19T00:00:00.000Z',
  progress: { position: { section: 1, offset: 4 }, fraction: 0.426, updatedAt: '2026-09-19T01:00:00.000Z' },
}
export const LIST: BookList = { root: '/Users/reader/Documents/Books', books: [PDF_BOOK, EPUB_BOOK], truncated: false }

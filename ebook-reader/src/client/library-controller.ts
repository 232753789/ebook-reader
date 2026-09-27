/** The library listing the sidebar tab shows. */

import type { BookEntry, BookId, BookList, ReadingProgress } from '../types.ts'
import type { ReaderApi } from './api.ts'
import { Observable } from './observable.ts'

/** Listing state; a refresh keeps showing the previous listing until it settles. */
export type LibraryState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading'; readonly list?: BookList }
  | { readonly status: 'ready'; readonly list: BookList }
  | { readonly status: 'error'; readonly message: string; readonly list?: BookList }

function listOf(state: LibraryState): BookList | undefined {
  return state.status === 'idle' ? undefined : state.list
}

/** Loads the listing and folds saved progress into it. */
export class LibraryController {
  /** Published listing state. */
  readonly state = new Observable<LibraryState>({ status: 'idle' })
  private generation = 0

  /** @param api - Host routes. */
  constructor(private readonly api: ReaderApi) {}

  /**
   * Rescan the library; a newer refresh supersedes an older one still in flight.
   * @returns settlement once this refresh published its outcome or was superseded.
   */
  async refresh(): Promise<void> {
    const generation = ++this.generation
    const previous = listOf(this.state.getSnapshot())
    this.state.set(previous === undefined ? { status: 'loading' } : { status: 'loading', list: previous })
    try {
      const list = await this.api.books()
      if (generation === this.generation) this.state.set({ status: 'ready', list })
    } catch (error) {
      if (generation !== this.generation) return
      const message = error instanceof Error ? error.message : String(error)
      this.state.set(previous === undefined ? { status: 'error', message } : { status: 'error', message, list: previous })
    }
  }

  /** Load the listing once, on first use. */
  ensureLoaded(): void {
    if (this.state.getSnapshot().status === 'idle') void this.refresh()
  }

  /**
   * Look a book up in the current listing.
   * @param id - book id.
   * @returns the listed book, when the current listing holds it.
   */
  find(id: BookId): BookEntry | undefined {
    return listOf(this.state.getSnapshot())?.books.find(book => book.id === id)
  }

  /**
   * Replace one book's progress in the current listing after the Host stored it.
   * @param id - book id.
   * @param progress - the stored progress.
   */
  applyProgress(id: BookId, progress: ReadingProgress): void {
    const state = this.state.getSnapshot()
    const list = listOf(state)
    if (list === undefined || !list.books.some(book => book.id === id)) return
    const next: BookList = { ...list, books: list.books.map(book => book.id === id ? { ...book, progress } : book) }
    this.state.set({ ...state, list: next } as LibraryState)
  }
}

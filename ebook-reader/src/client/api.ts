/** Browser calls to the ebook-reader Host routes. */

import type {
  BookId, BookList, ReaderCapabilities, ReadingProgress, ReadingProgressUpdate, SpeechRequest,
  SpeechResponse,
} from '../types.ts'

/** Route prefix owned by the ebook-reader Host plugin. */
const API = '/ebook-reader/api'

async function failure(response: Response): Promise<Error> {
  let message = `HTTP ${String(response.status)}`
  try {
    const body = await response.json() as { error?: unknown }
    if (typeof body.error === 'string') message = body.error
  } catch {
    // A body that is not the routes' JSON error keeps the status-only message.
  }
  return new Error(message)
}

/** The Host operations the reader uses; injected so controllers run against a fake in tests. */
export interface ReaderApi {
  capabilities(): Promise<ReaderCapabilities>
  books(): Promise<BookList>
  /**
   * @param id - book id from the listing.
   * @returns the URL serving the book file with byte-range support.
   */
  fileUrl(id: BookId): string
  /**
   * @param id - book id from the listing.
   * @returns the complete book file.
   */
  fileBytes(id: BookId): Promise<Uint8Array>
  /**
   * @param id - book id from the listing.
   * @param update - position and fraction to store.
   * @param keepalive - lets the request outlive the page, for a save during unload.
   * @returns the stored progress.
   */
  saveProgress(id: BookId, update: ReadingProgressUpdate, keepalive: boolean): Promise<ReadingProgress>
  /**
   * Synthesize one group of segments together.
   * @param request - the group's texts, speaker, and reading style.
   * @param signal - abandons the request.
   * @returns each segment's FLAC audio, in the requested order.
   */
  speech(request: SpeechRequest, signal: AbortSignal): Promise<Blob[]>
}

/**
 * The `fetch`-backed API.
 * @param fetcher - the page's fetch.
 * @returns the API bound to the same-origin Host routes.
 */
export function httpReaderApi(fetcher: typeof fetch): ReaderApi {
  const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetcher(`${API}${path}`, init)
    if (!response.ok) throw await failure(response)
    return await response.json() as T
  }
  return {
    capabilities: () => json<ReaderCapabilities>('/capabilities'),
    books: () => json<BookList>('/books'),
    fileUrl: id => `${API}/books/${id}/file`,
    fileBytes: async (id) => {
      const response = await fetcher(`${API}/books/${id}/file`)
      if (!response.ok) throw await failure(response)
      return new Uint8Array(await response.arrayBuffer())
    },
    saveProgress: (id, update, keepalive) => json<ReadingProgress>(`/books/${id}/progress`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(update),
      keepalive,
    }),
    speech: async (request, signal) => {
      const response = await fetcher(`${API}/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal,
      })
      if (!response.ok) throw await failure(response)
      const { segments } = await response.json() as SpeechResponse
      // The synthesis published each segment; fetching them is a cache read the browser may reuse.
      return await Promise.all(segments.map(async ({ key }) => {
        const audio = await fetcher(`${API}/speech/${key}`, { signal })
        if (!audio.ok) throw await failure(audio)
        return await audio.blob()
      }))
    },
  }
}

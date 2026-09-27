/** Loopback same-origin HTTP routes: library, book files, progress, read-aloud audio, and PDF.js assets. */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { isLoopbackSameOriginRequest } from './loopback-request.ts'
import { isBookId } from './library.ts'
import { parseProgressUpdate } from './progress.ts'
import { EBOOK_API_PREFIX, PDFJS, type EbookReaderRuntime } from './runtime.ts'
import { AUDIO_SUFFIX } from './speech.ts'
import { DEFAULT_SPEECH_STYLE, instructFor } from './styles.ts'
import type { BookFormat, SpeechResponse } from './types.ts'

/** Largest JSON request body any route accepts; progress and one speech segment fit well within it. */
const MAX_JSON_BODY_BYTES = 64 * 1024

const BOOK_MEDIA_TYPES: Readonly<Record<BookFormat, string>> = {
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
}

/** PDF.js directories the reader loads at runtime, and the media type of each file extension served. */
const PDFJS_DIRECTORIES = new Set(['build', 'cmaps', 'standard_fonts', 'wasm', 'iccs'])
const PDFJS_BUILD_FILES = new Set(['pdf.min.mjs', 'pdf.worker.min.mjs'])
const PDFJS_MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.mjs': 'text/javascript; charset=utf-8',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.icc': 'application/vnd.iccprofile',
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const media = req.headers['content-type']
  if (typeof media !== 'string' || !/^application\/json\b/i.test(media)) throw new HttpError(415, 'application/json is required')
  const chunks: Buffer[] = []
  let bytes = 0
  // A request without a set encoding yields Buffer chunks.
  for await (const chunk of req as AsyncIterable<Buffer>) {
    bytes += chunk.length
    if (bytes > MAX_JSON_BODY_BYTES) throw new HttpError(413, 'request body is too large')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'request body is not JSON')
  }
}

/** Parse a single `bytes=` range against a file size, or throw 416. */
function byteRange(value: string, size: number): { start: number; end: number } {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (match === null || (match[1] === '' && match[2] === '')) throw new HttpError(416, 'unsupported byte range')
  let start: number
  let end: number
  if (match[1] === '') {
    // Suffix form: the last N bytes.
    start = Math.max(0, size - Number(match[2]))
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
    throw new HttpError(416, 'byte range is outside the file')
  }
  return { start, end }
}

async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  headers: Readonly<Record<string, string>>,
): Promise<void> {
  const { size } = await stat(file)
  const common = { ...headers, 'accept-ranges': 'bytes' }
  const range = req.headers.range
  if (typeof range === 'string' && size > 0) {
    const { start, end } = byteRange(range, size)
    res.writeHead(206, {
      ...common,
      'content-length': end - start + 1,
      'content-range': `bytes ${String(start)}-${String(end)}/${String(size)}`,
    })
    if (req.method === 'HEAD') res.end()
    else await pipeline(createReadStream(file, { start, end }), res)
    return
  }
  res.writeHead(200, { ...common, 'content-length': size })
  if (req.method === 'HEAD') res.end()
  else await pipeline(createReadStream(file), res)
}

function requireMethod(req: IncomingMessage, ...methods: readonly string[]): void {
  if (!methods.includes(String(req.method))) throw new HttpError(405, 'method not allowed')
}

/** Tracks request lifetimes so plugin disposal reaches quiescence. */
export class EbookHttpController {
  private readonly handlers = new Set<Promise<void>>()
  private readonly requests = new Set<IncomingMessage>()
  private closed = false

  /** @param runtime - the installation's runtime. */
  constructor(private readonly runtime: EbookReaderRuntime) {}

  /** WebServer route handler. */
  handle = (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (this.closed) {
      res.writeHead(503)
      res.end()
      return Promise.resolve()
    }
    this.requests.add(req)
    const operation = this.dispatch(req, res).finally(() => {
      this.requests.delete(req)
      this.handlers.delete(operation)
    })
    this.handlers.add(operation)
    return operation
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!isLoopbackSameOriginRequest(req)) throw new HttpError(403, 'loopback same-origin access required')
      const pathname = new URL(String(req.url), 'http://localhost').pathname
      const route = pathname.startsWith(`${EBOOK_API_PREFIX}/`) ? pathname.slice(EBOOK_API_PREFIX.length + 1) : ''
      const [head, second, ...rest] = route.split('/')
      if (route === 'capabilities') {
        requireMethod(req, 'GET')
        sendJson(res, 200, this.runtime.capabilities())
        return
      }
      if (route === 'books') {
        requireMethod(req, 'GET')
        sendJson(res, 200, await this.runtime.list())
        return
      }
      if (route === 'speech') {
        requireMethod(req, 'POST')
        await this.speech(req, res)
        return
      }
      if (head === 'speech' && second !== undefined && rest.length === 0) {
        requireMethod(req, 'GET', 'HEAD')
        await this.speechAudio(req, res, second)
        return
      }
      if (head === 'books' && second !== undefined && rest.length === 1) {
        await this.book(req, res, second, rest.join('/'))
        return
      }
      if (head === 'pdfjs' && second !== undefined) {
        requireMethod(req, 'GET', 'HEAD')
        await this.pdfjs(req, res, second, rest)
        return
      }
      throw new HttpError(404, 'not found')
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      if (!res.headersSent) sendJson(res, failure instanceof HttpError ? failure.status : 500, { error: failure.message })
      else res.destroy(failure)
    }
  }

  private async book(req: IncomingMessage, res: ServerResponse, id: string, resource: string): Promise<void> {
    if (!isBookId(id)) throw new HttpError(404, 'book not found')
    if (resource !== 'file' && resource !== 'progress') throw new HttpError(404, 'not found')
    const file = await this.runtime.find(id)
    if (file === undefined) throw new HttpError(404, 'book not found')
    if (resource === 'file') {
      requireMethod(req, 'GET', 'HEAD')
      await sendFile(req, res, file.absolutePath, {
        'content-type': BOOK_MEDIA_TYPES[file.format],
        'cache-control': 'private, no-cache',
        'last-modified': new Date(file.modifiedAt).toUTCString(),
      })
      return
    }
    requireMethod(req, 'PUT')
    const update = parseProgressUpdate(await readJson(req))
    if (update === undefined) throw new HttpError(400, 'progress needs position.section, position.offset, and fraction in [0, 1]')
    sendJson(res, 200, await this.runtime.saveProgress(file, update))
  }

  private async speech(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const speech = this.runtime.config.speech
    const synthesizer = this.runtime.speech
    if (speech === undefined || synthesizer === undefined) throw new HttpError(404, 'read-aloud is disabled')
    const body = await readJson(req)
    const request = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
    const segments = Array.isArray(request.segments) ? request.segments : []
    if (segments.length === 0 || segments.length > speech.maxRequestSegments) {
      throw new HttpError(400, `segments must hold 1 to ${String(speech.maxRequestSegments)} entries`)
    }
    const texts = segments.map(segment => (typeof segment === 'string' ? segment.trim() : ''))
    if (texts.some(text => text.length === 0 || text.length > speech.maxSegmentChars)) {
      throw new HttpError(400, `each segment must hold 1 to ${String(speech.maxSegmentChars)} characters`)
    }
    const voice = typeof request.voice === 'string' ? request.voice.toLowerCase() : ''
    // The model answers to its own speaker key, not to the lower-case id the browser sends.
    const speaker = speech.speakers[voice]
    if (speaker === undefined) throw new HttpError(400, `unknown voice: ${voice}`)
    // The instruction comes from the Host's own table, so the browser names a style it cannot compose.
    const style = typeof request.style === 'string' ? request.style : DEFAULT_SPEECH_STYLE
    const instruct = instructFor(style)
    if (instruct === undefined) throw new HttpError(400, `unknown style: ${style}`)
    // Listening only while the audio is pending: a close in that window is the requester leaving.
    const requester = new AbortController()
    const onClose = (): void => { requester.abort(new Error('ebook-reader: speech requester went away')) }
    res.on('close', onClose)
    let audio: string[]
    try {
      audio = await synthesizer.audioFiles({ speaker, instruct, texts }, requester.signal)
    } catch (error) {
      if (requester.signal.aborted) return
      throw error
    } finally {
      res.off('close', onClose)
    }
    const answer: SpeechResponse = { segments: audio.map(file => ({ key: basename(file, AUDIO_SUFFIX) })) }
    sendJson(res, 200, answer)
  }

  /**
   * Serve one synthesized segment by the key its synthesis returned.
   * @param key - cache key from a speech response.
   */
  private async speechAudio(req: IncomingMessage, res: ServerResponse, key: string): Promise<void> {
    const synthesizer = this.runtime.speech
    if (synthesizer === undefined) throw new HttpError(404, 'read-aloud is disabled')
    if (!/^[0-9a-f]{64}$/.test(key)) throw new HttpError(404, 'not found')
    const file = synthesizer.cachedFile(key)
    try {
      await stat(file)
    } catch {
      // The audio was pruned between its synthesis and this fetch; the browser requests it again.
      throw new HttpError(404, 'not found')
    }
    await sendFile(req, res, file, { 'content-type': 'audio/flac', 'cache-control': 'private, max-age=86400' })
  }

  private async pdfjs(req: IncomingMessage, res: ServerResponse, version: string, path: readonly string[]): Promise<void> {
    const [directory, ...rest] = path
    const name = rest.at(-1)
    const valid = version === PDFJS.version
      && directory !== undefined && PDFJS_DIRECTORIES.has(directory)
      && name !== undefined && rest.every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))
      && (directory !== 'build' || (rest.length === 1 && PDFJS_BUILD_FILES.has(name)))
    const media = valid ? PDFJS_MEDIA_TYPES[extname(name)] : undefined
    if (!valid || media === undefined) throw new HttpError(404, 'not found')
    const file = join(PDFJS.directory, directory, ...rest)
    try {
      await stat(file)
    } catch {
      // Every missing or unreadable asset is the same absence to the browser.
      throw new HttpError(404, 'not found')
    }
    await sendFile(req, res, file, { 'content-type': media, 'cache-control': 'public, max-age=31536000, immutable' })
  }

  /** Abort active request bodies and await every route handler. */
  async dispose(): Promise<void> {
    this.closed = true
    for (const request of this.requests) request.destroy(new Error('ebook-reader: plugin disposed'))
    await Promise.allSettled(this.handlers)
  }
}

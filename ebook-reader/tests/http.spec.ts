import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { EbookHttpController } from '../src/http.ts'
import { bookIdForPath } from '../src/library.ts'
import { EbookReaderRuntime, PDFJS } from '../src/runtime.ts'
import type { SpeechEngine, SpeechJob } from '../src/speech.ts'
import type { BookList, ReaderCapabilities, SpeechResponse } from '../src/types.ts'
import { modelDirectory, tempRoot } from './fixtures.ts'

const servers: ReturnType<typeof createServer>[] = []
const controllers: EbookHttpController[] = []

afterEach(async () => {
  await Promise.all(controllers.splice(0).map(controller => controller.dispose()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => { resolve() }))))
})

/** An engine answering from a script: write audio, fail, or wait until released. */
class ScriptedEngine implements SpeechEngine {
  readonly jobs: SpeechJob[] = []
  readonly held: (() => void)[] = []
  mode: 'write' | 'fail' | 'hold' = 'write'

  readonly instructs: string[] = []

  async synthesize(instruct: string, batch: readonly SpeechJob[]): Promise<void> {
    this.instructs.push(instruct)
    this.jobs.push(...batch)
    if (this.mode === 'fail') throw new Error('synthesis exploded')
    if (this.mode === 'hold') await new Promise<void>((resolve) => { this.held.push(resolve) })
    for (const job of batch) await writeFile(job.output, 'fLaC-audio')
  }

  dispose(): Promise<void> {
    for (const release of this.held.splice(0)) release()
    return Promise.resolve()
  }
}

async function serve(options: { speech?: boolean } = {}) {
  const root = await tempRoot('ebook-http-')
  const libraryRoot = join(root, 'books')
  await mkdir(join(libraryRoot, '文学'), { recursive: true })
  await writeFile(join(libraryRoot, '文学', '围城.epub'), 'EPUB-CONTENT')
  await writeFile(join(libraryRoot, 'manual.pdf'), '%PDF-0123456789')
  const model = options.speech === true ? await modelDirectory(root) : undefined
  const config = resolveConfig({
    libraryRoot,
    storageRoot: join(root, 'storage'),
    ...model === undefined ? {} : { speechMode: 'local', speechModelPath: model, speechMaxSegmentChars: 20 },
  })
  const engine = new ScriptedEngine()
  const reported: Error[] = []
  const runtime = new EbookReaderRuntime(config, model === undefined ? undefined : engine, (error) => { reported.push(error) })
  const controller = new EbookHttpController(runtime)
  controllers.push(controller)
  const server = createServer((req, res) => { void controller.handle(req, res) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  const api = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${origin}/ebook-reader/api${path}`, { ...init, headers: { origin, ...init.headers as Record<string, string> } })
  return { root, libraryRoot, origin, api, engine, runtime, controller, reported }
}

const EPUB = bookIdForPath('文学/围城.epub')
const PDF = bookIdForPath('manual.pdf')

describe('ebook-reader HTTP routes', () => {
  it('refuses a cross-site browser request', async () => {
    const { origin } = await serve()
    const response = await fetch(`${origin}/ebook-reader/api/books`, { headers: { origin: 'https://example.com' } })
    expect(response.status).toBe(403)
  })

  it('reports read-aloud as disabled and names the versioned PDF.js directory', async () => {
    const { api } = await serve()
    const response = await api('/capabilities')
    expect(await response.json()).toEqual({
      speech: { enabled: false },
      pdfjsBase: `/ebook-reader/api/pdfjs/${PDFJS.version}/`,
    } satisfies ReaderCapabilities)
    expect((await api('/capabilities', { method: 'POST' })).status).toBe(405)
  })

  it('lists books with saved progress and stores new progress', async () => {
    const { api } = await serve()
    const listed = await (await api('/books')).json() as BookList
    expect(listed.books.map(book => [book.id, book.title, book.format, book.path])).toEqual([
      [EPUB, '围城', 'epub', '文学/围城.epub'],
      [PDF, 'manual', 'pdf', 'manual.pdf'],
    ])
    expect(listed.truncated).toBe(false)

    const saved = await api(`/books/${EPUB}/progress`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ position: { section: 3, offset: 12 }, fraction: 0.4 }),
    })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ position: { section: 3, offset: 12 }, fraction: 0.4 })
    const relisted = await (await api('/books')).json() as BookList
    expect(relisted.books.find(book => book.id === EPUB)?.progress).toMatchObject({ fraction: 0.4 })
    expect(relisted.books.find(book => book.id === PDF)?.progress).toBeUndefined()
  })

  it('validates progress bodies', async () => {
    const { api } = await serve()
    const put = (body: string, type = 'application/json') => api(`/books/${EPUB}/progress`, { method: 'PUT', headers: { 'content-type': type }, body })
    expect((await put('{"position":{"section":0},"fraction":0}')).status).toBe(400)
    expect((await put('not json')).status).toBe(400)
    expect((await put('{}', 'text/plain')).status).toBe(415)
    expect((await put(JSON.stringify({ padding: 'x'.repeat(70 * 1024) }))).status).toBe(413)
    expect((await api(`/books/${EPUB}/progress`)).status).toBe(405)
  })

  it('serves book files whole, by range, and by HEAD', async () => {
    const { api } = await serve()
    const whole = await api(`/books/${PDF}/file`)
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-type')).toBe('application/pdf')
    expect(whole.headers.get('accept-ranges')).toBe('bytes')
    expect(await whole.text()).toBe('%PDF-0123456789')
    const part = await api(`/books/${PDF}/file`, { headers: { range: 'bytes=5-8' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 5-8/15')
    expect(await part.text()).toBe('0123')
    const suffix = await api(`/books/${PDF}/file`, { headers: { range: 'bytes=-3' } })
    expect(await suffix.text()).toBe('789')
    const open = await api(`/books/${PDF}/file`, { headers: { range: 'bytes=10-99' } })
    expect(await open.text()).toBe('56789')
    const head = await api(`/books/${EPUB}/file`, { method: 'HEAD' })
    expect(head.headers.get('content-type')).toBe('application/epub+zip')
    expect(head.headers.get('content-length')).toBe('12')
    const headRange = await api(`/books/${EPUB}/file`, { method: 'HEAD', headers: { range: 'bytes=0-1' } })
    expect(headRange.status).toBe(206)
    for (const range of ['bytes=20-', 'bytes=4-2', 'bytes=-', 'items=0-1']) {
      expect((await api(`/books/${PDF}/file`, { headers: { range } })).status).toBe(416)
    }
  })

  it('answers 404 for unknown books and resources, and finds a book added after the last listing', async () => {
    const { api, libraryRoot } = await serve()
    expect((await api('/books/book-0000/file')).status).toBe(404)
    expect((await api(`/books/${bookIdForPath('missing.pdf')}/file`)).status).toBe(404)
    expect((await api(`/books/${PDF}/cover`)).status).toBe(404)
    expect((await api('/nothing')).status).toBe(404)
    expect((await api(`/books/${PDF}`)).status).toBe(404)
    expect((await api(`/books/${PDF}/file/extra`)).status).toBe(404)
    await writeFile(join(libraryRoot, 'late.pdf'), '%PDF-late')
    expect(await (await api(`/books/${bookIdForPath('late.pdf')}/file`)).text()).toBe('%PDF-late')
  })

  it('destroys the response when a file fails after its headers were sent', async () => {
    const { api, libraryRoot } = await serve()
    await api('/books')
    await rm(join(libraryRoot, 'manual.pdf'))
    await mkdir(join(libraryRoot, 'manual.pdf'))
    await expect(api(`/books/${PDF}/file`).then(response => response.text())).rejects.toThrow()
  })

  it('serves the PDF.js distribution files the reader loads, and nothing else', async () => {
    const { api } = await serve()
    const base = `/pdfjs/${PDFJS.version}`
    const module = await api(`${base}/build/pdf.min.mjs`, { method: 'HEAD' })
    expect(module.status).toBe(200)
    expect(module.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(module.headers.get('cache-control')).toContain('immutable')
    expect((await api(`${base}/cmaps/UniGB-UTF16-H.bcmap`, { method: 'HEAD' })).headers.get('content-type')).toBe('application/octet-stream')
    for (const path of [
      '/pdfjs/0.0.0/build/pdf.min.mjs',
      `${base}/build/pdf.mjs`,
      `${base}/web/viewer.mjs`,
      `${base}/cmaps/..%2F..%2Fpackage.json`,
      `${base}/cmaps/absent.bcmap`,
      `${base}/cmaps/LICENSE`,
      `${base}/build`,
      base,
      '/pdfjs',
    ]) {
      expect((await api(path)).status, path).toBe(404)
    }
    expect((await api(`${base}/build/pdf.min.mjs`, { method: 'DELETE' })).status).toBe(405)
  })

  it('answers 404 for the bare prefix and 500 with the message of an unexpected failure', async () => {
    const { api, runtime } = await serve()
    expect((await api('')).status).toBe(404)
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the scenario under test.
    runtime.list = () => Promise.reject('disk vanished')
    const response = await api('/books')
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'disk vanished' })
  })

  it('answers 503 once disposed', async () => {
    const { api, controller } = await serve()
    await controller.dispose()
    expect((await api('/books')).status).toBe(503)
  })
})

describe('ebook-reader speech route', () => {
  it('is absent while read-aloud is off', async () => {
    const { api } = await serve()
    const response = await api('/speech', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(response.status).toBe(404)
    expect((await api(`/speech/${'a'.repeat(64)}`)).status).toBe(404)
  })

  it('advertises the voices and styles, and synthesizes a group served as FLAC by key', async () => {
    const { api, engine } = await serve({ speech: true })
    const capabilities = await (await api('/capabilities')).json() as ReaderCapabilities
    expect(capabilities.speech).toMatchObject({
      enabled: true,
      voices: [{ id: 'serena' }, { id: 'vivian' }, { id: 'uncle_fu' }, { id: 'eric', dialect: 'sichuan_dialect' }],
      defaultVoice: 'serena',
      defaultStyle: 'none',
      maxSegmentChars: 20,
      prefetchParagraphs: 1,
      maxRequestSegments: 24,
    })
    const styles = capabilities.speech.enabled ? capabilities.speech.styles : []
    expect(styles.map(style => style.id)).toContain('technical')
    const response = await api('/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ segments: [' 天色已晚。 ', '窗外有风。'], voice: 'Vivian', style: 'technical' }),
    })
    expect(response.status).toBe(200)
    const { segments } = await response.json() as SpeechResponse
    expect(segments).toHaveLength(2)
    // The browser names a voice without case; the engine is given the model's own speaker key,
    // and the style it named becomes the Host's own instruction.
    expect(engine.jobs.map(job => [job.text, job.speaker])).toEqual([['天色已晚。', 'Vivian'], ['窗外有风。', 'Vivian']])
    expect(engine.instructs).toEqual(['用清晰平稳的讲解语气朗读，语速稍慢，术语和英文词读清楚'])
    const audio = await api(`/speech/${segments[0]!.key}`)
    expect(audio.status).toBe(200)
    expect(audio.headers.get('content-type')).toBe('audio/flac')
    expect(await audio.text()).toBe('fLaC-audio')
    expect((await api(`/speech/${'0'.repeat(64)}`)).status).toBe(404)
    expect((await api('/speech/not-a-key')).status).toBe(404)
  })

  it('rejects empty or oversized text, unknown voices, and bodies that are not objects', async () => {
    const { api } = await serve({ speech: true })
    const post = (body: unknown) => api('/speech', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect((await post({ segments: ['  '], voice: 'serena' })).status).toBe(400)
    expect((await post({ segments: ['长'.repeat(21)], voice: 'serena' })).status).toBe(400)
    expect((await post({ segments: [], voice: 'serena' })).status).toBe(400)
    expect((await post({ segments: ['短句'], voice: 'nobody' })).status).toBe(400)
    expect((await post({ segments: ['短句'], voice: 'serena', style: 'nonsense' })).status).toBe(400)
    expect((await post({ segments: ['短句'], voice: 2 })).status).toBe(400)
    expect((await post({ segments: [1], voice: 2 })).status).toBe(400)
    expect((await post(null)).status).toBe(400)
    expect((await api('/speech')).status).toBe(405)
  })

  it('reports a failed synthesis as a server error', async () => {
    const { api, engine } = await serve({ speech: true })
    engine.mode = 'fail'
    const response = await api('/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ segments: ['坏句子'], voice: 'serena' }),
    })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'synthesis exploded' })
  })

  it('stops waiting when the requester goes away and keeps the finished audio', async () => {
    const { api, engine, runtime } = await serve({ speech: true })
    engine.mode = 'hold'
    const requester = new AbortController()
    const request = api('/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ segments: ['离开'], voice: 'serena' }),
      signal: requester.signal,
    })
    await expect.poll(() => engine.held.length).toBe(1)
    requester.abort()
    await expect(request).rejects.toThrow()
    engine.mode = 'write'
    engine.held.shift()!()
    await expect.poll(async () => {
      const [file] = await runtime.speech!.audioFiles(
        { speaker: 'Serena', instruct: '', texts: ['离开'] }, AbortSignal.timeout(1_000),
      )
      return file!.endsWith('.flac')
    }).toBe(true)
    expect(engine.jobs).toHaveLength(1)
  })
})

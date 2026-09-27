/** Qwen3-TTS read-aloud: the resident Python worker, the audio cache, and the bounded synthesis queue. */

import { createHash } from 'node:crypto'
import { mkdir, readdir, rm, stat, utimes } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { NdjsonWorker } from './ndjson-worker.ts'
import { deadline } from '@deepseek-ai/dsh-timeout'
import type { ResolvedSpeechConfig } from './config.ts'

const WORKER_PATH = fileURLToPath(new URL('../python/tts_worker.py', import.meta.url))
const PROCESS_GRACE_MS = 10_000
const WORKER_DIAGNOSTIC_BYTES = 512 * 1024
const SPEECH_TIMEOUT_CODE = 'EBOOK_READER_SPEECH_TIMEOUT'
/** Suffix of the file a worker writes before renaming it to its cache name. */
const PARTIAL_SUFFIX = '.part'
/** Extension of a published cache file; its stem is the key the browser fetches it by. */
export const AUDIO_SUFFIX = '.flac'

/** One synthesis the engine performs. */
export interface SpeechJob {
  readonly text: string
  /** The model's own `talker_config.spk_id` key, with the casing that table uses. */
  readonly speaker: string
  /** Absolute FLAC path the engine publishes once the audio is complete. */
  readonly output: string
}

/** Performs one batch at a time; implemented by the Python worker. */
export interface SpeechEngine {
  /**
   * Synthesize one batch in a single model call and publish each FLAC file at its `output`.
   * @param instruct - style instruction for the whole batch; empty sends none.
   * @param batch - the segments to generate together, in playback order; never empty.
   * @param signal - deadline; aborting stops the engine's current work.
   */
  synthesize(instruct: string, batch: readonly SpeechJob[], signal: AbortSignal): Promise<void>
  /** Stop the engine and await its quiescence. */
  dispose(): Promise<void>
}

interface PendingRequest {
  resolve(): void
  reject(error: Error): void
}

interface WorkerResponse {
  readonly id: number
  readonly ok: boolean
  readonly error?: string
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function parseWorkerResponse(line: string): WorkerResponse {
  const parsed: unknown = JSON.parse(line)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('ebook-reader: TTS worker returned a non-object response')
  }
  const value = parsed as Record<string, unknown>
  if (!Number.isInteger(value.id) || typeof value.ok !== 'boolean') {
    throw new Error('ebook-reader: TTS worker returned an invalid response envelope')
  }
  if (!value.ok && typeof value.error !== 'string') {
    throw new Error('ebook-reader: TTS worker returned no error message')
  }
  return value as unknown as WorkerResponse
}

/**
 * One lazily started Python process that keeps the Qwen3-TTS weights loaded between segments.
 *
 * The process is stopped after `idleShutdownMs` without an outstanding request, and whenever a
 * request misses its deadline, because a stuck generation cannot be interrupted any other way.
 */
export class LocalSpeechWorker implements SpeechEngine {
  private readonly process: NdjsonWorker
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 1
  private closed = false

  /**
   * @param ctx - plugin context owning the subprocess.
   * @param speech - resolved speech settings frozen into the process arguments.
   */
  constructor(ctx: Context, private readonly speech: ResolvedSpeechConfig) {
    this.process = new NdjsonWorker(ctx, {
      executable: speech.pythonExecutable,
      args: [
        WORKER_PATH,
        '--model', speech.modelPath,
        '--device', speech.device,
        '--decoding', speech.decoding,
        // One anchor per voice, frozen into the arguments like every other resolved setting.
        ...[...speech.voicePrompts].flatMap(([voice, prompt]) => ['--voice-prompt', voice, prompt.audio, prompt.text]),
      ],
      cwd: dirname(WORKER_PATH),
      label: 'ebook-reader: TTS worker',
      idleShutdownMs: speech.idleShutdownMs,
      graceMs: PROCESS_GRACE_MS,
      diagnosticBytes: WORKER_DIAGNOSTIC_BYTES,
    }, {
      onLine: (line) => { this.onLine(line) },
      onFailure: (error) => { this.rejectPending(error) },
      isIdle: () => this.pending.size === 0,
    })
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private onLine(line: string): void {
    let response: WorkerResponse
    try {
      response = parseWorkerResponse(line)
    } catch (error) {
      this.rejectPending(asError(error))
      void this.process.stop()
      return
    }
    const pending = this.pending.get(response.id)
    if (pending === undefined) return
    this.pending.delete(response.id)
    if (response.ok) pending.resolve()
    else pending.reject(new Error(`ebook-reader: speech synthesis failed: ${response.error as string}`))
  }

  /**
   * Synthesize one batch, terminating the process when the deadline wins.
   * @param instruct - style instruction for the whole batch.
   * @param batch - the segments to generate together.
   * @param signal - deadline for this request.
   */
  async synthesize(instruct: string, batch: readonly SpeechJob[], signal: AbortSignal): Promise<void> {
    if (this.closed) throw new Error('ebook-reader: TTS worker is closed')
    this.process.clearIdleShutdown()
    await this.process.ensureStarted()
    signal.throwIfAborted()
    const id = this.nextId++
    // Every settlement path removes the request from `pending` first, so each request finishes once.
    await new Promise<void>((resolve, reject) => {
      const finish = (callback: () => void): void => {
        signal.removeEventListener('abort', onAbort)
        this.process.armIdleShutdown()
        callback()
      }
      const onAbort = (): void => {
        this.pending.delete(id)
        finish(() => { reject(asError(signal.reason)) })
        void this.process.stop()
      }
      this.pending.set(id, {
        resolve: () => { finish(resolve) },
        reject: (error) => { finish(() => { reject(error) }) },
      })
      signal.addEventListener('abort', onAbort, { once: true })
      this.process.write({
        id,
        language: this.speech.language,
        instruct,
        segments: batch.map(job => ({ text: job.text, speaker: job.speaker, output: job.output })),
      })
    })
  }

  /** Stop the worker and await process-tree quiescence. */
  async dispose(): Promise<void> {
    this.closed = true
    this.rejectPending(new Error('ebook-reader: TTS worker disposed'))
    await this.process.dispose()
  }
}

/** The segments of one group, generated by one model call under one speaker and instruction. */
export interface SpeechGroup {
  /** The model's own `talker_config.spk_id` key. */
  readonly speaker: string
  /** Style instruction for every segment of the group; empty sends none. */
  readonly instruct: string
  /** Segment texts in reading order. */
  readonly texts: readonly string[]
}

interface QueuedJob {
  readonly file: string
  readonly text: string
  readonly speaker: string
  /** Requests still waiting for this file; a job nobody waits for is dropped before it starts. */
  waiters: number
  readonly done: Promise<string>
  resolve(file: string): void
  reject(error: Error): void
}

/** One requested segment: the cached file, plus the job producing it while it is absent. */
interface Claimed {
  readonly file: string
  readonly job: QueuedJob | undefined
}

/** Rejects with the signal's reason when it aborts first; the underlying work is not cancelled. */
function unlessAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(asError(signal.reason))
      return
    }
    const onAbort = (): void => { reject(asError(signal.reason)) }
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(asError(error)) },
    )
  })
}

/**
 * Turns groups of text into cached FLAC files, one model call per group.
 *
 * The cache key covers the model directory, language, instruction, speaker, and exact text, so a
 * repeated segment is served from disk. The caller decides what belongs in a group — the reader
 * sends one paragraph — and the segments a group still needs are generated together in one engine
 * call. Groups reach the engine in call order, one at a time, because a single model instance on a
 * single device cannot run two calls at once. Segments already being generated for another group
 * are shared rather than repeated. A group whose every requester went away before the engine
 * starts is dropped; one already generating completes and stays cached.
 */
export class SpeechSynthesizer {
  private readonly directory: string
  private readonly jobs = new Map<string, QueuedJob>()
  private claims: Promise<void> = Promise.resolve()
  /** Engine serialization: each group runs after the one claimed before it, and disposal awaits it. */
  private tail: Promise<void> = Promise.resolve()
  /** The one cache-directory creation every group awaits. */
  private directoryReady: Promise<void> | undefined
  private pruning: Promise<void> | undefined
  private closed = false

  /**
   * @param speech - resolved speech settings.
   * @param storageRoot - the plugin's private storage directory.
   * @param engine - performs the syntheses.
   * @param report - receives cache-pruning failures, which never fail a request.
   * @param now - clock for cache recency.
   */
  constructor(
    private readonly speech: ResolvedSpeechConfig,
    storageRoot: string,
    private readonly engine: SpeechEngine,
    private readonly report: (error: Error) => void,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.directory = join(storageRoot, 'speech')
  }

  /**
   * The cache file one key names.
   * @param key - stem of a cache file, as a synthesis response returned it.
   * @returns the absolute path, which may have been pruned since.
   */
  cachedFile(key: string): string {
    return join(this.directory, `${key}${AUDIO_SUFFIX}`)
  }

  private fileFor(text: string, speaker: string, instruct: string): string {
    // A voice's anchor changes the audio it produces, so it belongs in the key beside the voice.
    const anchor = this.speech.voicePrompts.get(speaker.toLowerCase())?.digest ?? ''
    const key = createHash('sha256')
      .update(JSON.stringify([this.speech.modelPath, this.speech.language, instruct, speaker, anchor, text]), 'utf8')
      .digest('hex')
    return join(this.directory, `${key}${AUDIO_SUFFIX}`)
  }

  /**
   * Resolve the cached audio for one group, synthesizing the segments it still needs.
   * @param group - the segments to generate together.
   * @param signal - the requester's cancellation; it stops waiting, not a started synthesis.
   * @returns the absolute FLAC paths, one per requested segment in order.
   */
  async audioFiles(group: SpeechGroup, signal: AbortSignal): Promise<string[]> {
    if (this.closed) throw new Error('ebook-reader: speech synthesizer is closed')
    signal.throwIfAborted()
    const claimed = await this.claim(group)
    try {
      return await Promise.all(claimed.map(entry =>
        entry.job === undefined ? Promise.resolve(entry.file) : unlessAborted(entry.job.done, signal)))
    } finally {
      for (const entry of claimed) if (entry.job !== undefined) entry.job.waiters -= 1
    }
  }

  /**
   * Refresh a cached file's recency for pruning.
   * @returns whether the file is cached; a file pruned a moment ago reads as not cached.
   */
  private async touch(file: string): Promise<boolean> {
    const instant = this.now()
    try {
      await utimes(file, instant, instant)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  /**
   * Probe the cache for the whole group and queue what it needs, one requester at a time.
   *
   * Each entry counts its requester in here, before the group can reach the engine, so the
   * abandonment check never runs against a count that has not caught up.
   * @returns one entry per requested segment, in order.
   */
  private claim(group: SpeechGroup): Promise<Claimed[]> {
    const claimed = this.claims.then(async (): Promise<Claimed[]> => {
      const entries: Claimed[] = []
      const fresh: QueuedJob[] = []
      for (const text of group.texts) {
        const file = this.fileFor(text, group.speaker, group.instruct)
        if (await this.touch(file)) {
          entries.push({ file, job: undefined })
          continue
        }
        let job = this.jobs.get(file)
        if (job === undefined) {
          job = this.enqueue(file, text, group)
          fresh.push(job)
        }
        job.waiters += 1
        entries.push({ file, job })
      }
      if (fresh.length > 0) this.schedule(fresh, group.instruct)
      return entries
    })
    this.claims = claimed.then(() => undefined, () => undefined)
    return claimed
  }

  private enqueue(file: string, text: string, group: SpeechGroup): QueuedJob {
    let resolve!: (file: string) => void
    let reject!: (error: Error) => void
    const done = new Promise<string>((settle, fail) => { resolve = settle; reject = fail })
      .finally(() => { this.jobs.delete(file) })
    // Nothing else observes this settlement; each requester's own await carries the outcome.
    done.catch(() => undefined)
    const job: QueuedJob = { file, text, speaker: group.speaker, waiters: 0, done, resolve, reject }
    this.jobs.set(file, job)
    return job
  }

  /**
   * Queue one group behind the groups claimed before it; the engine runs one at a time.
   *
   * `run` settles its own jobs and never rejects, so the chain disposal awaits never breaks.
   */
  private schedule(batch: readonly QueuedJob[], instruct: string): void {
    this.tail = this.tail.then(() => this.run(batch, instruct))
  }

  /** Create the cache directory once; a failed attempt is retried by the next group. */
  private ensureDirectory(): Promise<void> {
    this.directoryReady ??= mkdir(this.directory, { recursive: true, mode: 0o700 })
      .then(() => undefined)
      .catch((error: unknown) => {
        this.directoryReady = undefined
        throw asError(error)
      })
    return this.directoryReady
  }

  /**
   * Generate one group and settle every job in it.
   *
   * Membership is decided immediately before the engine call, because a requester that leaves
   * earlier spares the model the work and one that leaves later only stops waiting.
   */
  private async run(batch: readonly QueuedJob[], instruct: string): Promise<void> {
    const live: QueuedJob[] = []
    try {
      await this.ensureDirectory()
      if (this.closed) throw new Error('ebook-reader: speech synthesizer is closed')
      for (const job of batch) {
        if (job.waiters > 0) live.push(job)
        else job.reject(new Error('ebook-reader: speech request abandoned before synthesis'))
      }
      if (live.length === 0) return
      using requestDeadline = deadline(undefined, this.speech.requestTimeoutMs, SPEECH_TIMEOUT_CODE)
      const jobs = live.map(job => ({ text: job.text, speaker: job.speaker, output: job.file }))
      await this.engine.synthesize(instruct, jobs, requestDeadline.signal)
      for (const job of live) {
        try {
          await stat(job.file)
        } catch (error) {
          throw new Error('ebook-reader: TTS worker reported success without writing readable audio', { cause: error })
        }
      }
    } catch (error) {
      // A job rejected as abandoned above is absent from `live`, which is empty only when the
      // failure came before that decision.
      for (const job of live.length > 0 ? live : batch) job.reject(asError(error))
      return
    }
    for (const job of live) job.resolve(job.file)
    this.pruning ??= this.prune()
      .catch((error: unknown) => { this.report(asError(error)) })
      .finally(() => { this.pruning = undefined })
  }

  /** Delete the least recently used audio until the cache fits, plus partial files older than a request deadline. */
  private async prune(): Promise<void> {
    const names = await readdir(this.directory)
    const files: { path: string; size: number; used: number }[] = []
    const staleBefore = this.now().getTime() - this.speech.requestTimeoutMs
    // Pruning is serialized and nothing else deletes cache files, so every listed file still exists.
    for (const name of names) {
      const path = join(this.directory, name)
      const info = await stat(path)
      if (name.endsWith(PARTIAL_SUFFIX)) {
        if (info.mtimeMs < staleBefore) await rm(path, { force: true })
        continue
      }
      if (name.endsWith(AUDIO_SUFFIX)) files.push({ path, size: info.size, used: info.mtimeMs })
    }
    let total = files.reduce((sum, file) => sum + file.size, 0)
    files.sort((a, b) => a.used - b.used)
    for (const file of files) {
      if (total <= this.speech.cacheMaxBytes) break
      await rm(file.path, { force: true })
      total -= file.size
    }
  }

  /** Reject queued work, stop the engine, and await a running prune. */
  async dispose(): Promise<void> {
    this.closed = true
    await this.engine.dispose()
    await this.tail
    await this.pruning
  }
}

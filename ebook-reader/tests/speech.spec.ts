import { mkdir, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, vi } from 'vitest'
import { resolveConfig, type ResolvedSpeechConfig } from '../src/config.ts'
import { LocalSpeechWorker, SpeechSynthesizer, type SpeechEngine, type SpeechJob } from '../src/speech.ts'
import { FakeWorkerProcess, modelDirectory, tempRoot } from './fixtures.ts'

async function speechConfig(overrides: Record<string, unknown> = {}): Promise<{ root: string; speech: ResolvedSpeechConfig }> {
  const root = await tempRoot('ebook-speech-')
  const model = await modelDirectory(root)
  const speech = resolveConfig({ speechMode: 'local', speechModelPath: model, speechLanguage: 'Chinese', ...overrides }).speech!
  return { root, speech }
}

function workerContext(
  processes: FakeWorkerProcess[], manual = false, argv: string[][] = [],
): Context {
  return {
    subprocess: {
      resolveExecutable: (command: string) => Promise.resolve(command),
      spawn: (options: { argv: string[] }) => {
        argv.push([...options.argv])
        const child = new FakeWorkerProcess(manual)
        processes.push(child)
        return child as unknown as SubprocessHandle
      },
    },
  } as unknown as Context
}

/**
 * Synthesize one segment, the shape most cases need.
 * @param synthesizer - the synthesizer under test.
 * @param text - the segment.
 * @param speaker - the model's speaker key.
 * @param signal - the requester's cancellation.
 * @returns the segment's audio file.
 */
async function one(
  synthesizer: SpeechSynthesizer, text: string, speaker: string, signal: AbortSignal,
): Promise<string> {
  const [file] = await synthesizer.audioFiles({ speaker, instruct: '平静', texts: [text] }, signal)
  return file!
}

/** An engine that writes a fixed-size FLAC file per job, optionally held until released. */
class FakeEngine implements SpeechEngine {
  readonly jobs: SpeechJob[] = []
  /** One entry per model call, holding the segments generated together. */
  readonly batches: SpeechJob[][] = []
  readonly held: (() => void)[] = []
  disposed = false

  constructor(private readonly hold = false, private readonly bytes = 10, private readonly writes = true) {}

  readonly instructs: string[] = []

  async synthesize(instruct: string, batch: readonly SpeechJob[]): Promise<void> {
    this.instructs.push(instruct)
    this.jobs.push(...batch)
    this.batches.push([...batch])
    if (this.hold) await new Promise<void>((resolve) => { this.held.push(resolve) })
    if (this.writes) for (const job of batch) await writeFile(job.output, 'x'.repeat(this.bytes))
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const release of this.held.splice(0)) release()
  }
}

describe('local TTS worker', () => {
  it('sends one request per segment with the resolved language and instruction', async () => {
    const { speech } = await speechConfig({ speechDecoding: 'fully-sampled' })
    const processes: FakeWorkerProcess[] = []
    const argv: string[][] = []
    const worker = new LocalSpeechWorker(workerContext(processes, false, argv), speech)
    expect(speech.decoding).toBe('fully-sampled')
    await worker.synthesize('平静', [{ text: '第一章', speaker: 'serena', output: '/tmp/a.flac' }], AbortSignal.timeout(5_000))
    // The resolved mode is frozen into the process arguments, so the worker cannot decode another way.
    expect(argv[0]).toContain('fully-sampled')
    expect(processes[0]!.received).toEqual([
      {
        id: 1,
        language: 'Chinese',
        instruct: '平静',
        segments: [{ text: '第一章', speaker: 'serena', output: '/tmp/a.flac' }],
      },
    ])
    await worker.dispose()
    expect(processes[0]!.terminated).toBe(true)
    await expect(worker.synthesize('平静', [{ text: 'x', speaker: 'serena', output: '/tmp/b.flac' }], AbortSignal.timeout(5_000)))
      .rejects.toThrow('TTS worker is closed')
  })

  it('freezes each configured anchor into the process arguments', async () => {
    const root = await tempRoot('ebook-anchor-')
    const model = await modelDirectory(root)
    const audio = join(root, 'serena-2.wav')
    await writeFile(audio, 'reference audio bytes')
    const speech = resolveConfig({
      speechMode: 'local',
      speechModelPath: model,
      speechLanguage: 'Chinese',
      speechVoicePrompts: [{ voice: 'serena', audio, text: '参考文本。' }],
    }).speech!
    const processes: FakeWorkerProcess[] = []
    const argv: string[][] = []
    const worker = new LocalSpeechWorker(workerContext(processes, false, argv), speech)
    await worker.synthesize('', [{ text: '第一章', speaker: 'serena', output: join(root, 'a.flac') }], AbortSignal.timeout(5_000))
    expect(argv[0]!.join(' ')).toContain(`--voice-prompt serena ${audio} 参考文本。`)
    await worker.dispose()
  })

  it('rejects a failed synthesis and keeps the process for the next one', async () => {
    const { speech } = await speechConfig()
    const processes: FakeWorkerProcess[] = []
    const worker = new LocalSpeechWorker(workerContext(processes, true), speech)
    const failed = worker.synthesize('平静', [{ text: '坏', speaker: 'serena', output: '/tmp/c.flac' }], AbortSignal.timeout(5_000))
    await vi.waitFor(() => { expect(processes[0]?.received).toHaveLength(1) })
    processes[0]!.answer(99)
    processes[0]!.answer(1, 'CUDA out of memory')
    await expect(failed).rejects.toThrow('speech synthesis failed: CUDA out of memory')
    expect(processes[0]!.terminated).toBe(false)
    await worker.dispose()
  })

  it('stops the process when a request misses its deadline or a response is malformed', async () => {
    const { speech } = await speechConfig()
    const processes: FakeWorkerProcess[] = []
    const worker = new LocalSpeechWorker(workerContext(processes, true), speech)
    const deadline = new AbortController()
    const timed = worker.synthesize('平静', [{ text: '慢', speaker: 'serena', output: '/tmp/d.flac' }], deadline.signal)
    await vi.waitFor(() => { expect(processes[0]?.received).toHaveLength(1) })
    deadline.abort('deadline')
    await expect(timed).rejects.toThrow('deadline')
    await vi.waitFor(() => { expect(processes[0]!.terminated).toBe(true) })

    for (const line of ['[]', '{"id":"x","ok":true}', '{"id":2,"ok":false}']) {
      const pending = worker.synthesize('平静', [{ text: '坏行', speaker: 'serena', output: '/tmp/e.flac' }], AbortSignal.timeout(5_000))
      const child = await vi.waitFor(() => {
        const current = processes.at(-1)!
        expect(current.terminated).toBe(false)
        expect(current.received).toHaveLength(1)
        return current
      })
      child.write(line)
      await expect(pending).rejects.toThrow('TTS worker returned')
      await vi.waitFor(() => { expect(child.terminated).toBe(true) })
    }
    await worker.dispose()
  })

  it('rejects outstanding requests when the process exits unexpectedly', async () => {
    const { speech } = await speechConfig()
    const processes: FakeWorkerProcess[] = []
    const worker = new LocalSpeechWorker(workerContext(processes, true), speech)
    const pending = worker.synthesize('平静', [{ text: '崩溃', speaker: 'serena', output: '/tmp/h.flac' }], AbortSignal.timeout(5_000))
    await vi.waitFor(() => { expect(processes[0]?.received).toHaveLength(1) })
    processes[0]!.terminate()
    await expect(pending).rejects.toThrow('TTS worker')
    await worker.dispose()
  })

  it('stops the idle process and starts a new one for the next request', async () => {
    vi.useFakeTimers()
    try {
      const { speech } = await speechConfig({ speechIdleShutdownMs: 600_000 })
      expect(speech.idleShutdownMs).toBe(600_000)
      const processes: FakeWorkerProcess[] = []
      const worker = new LocalSpeechWorker(workerContext(processes), speech)
      await worker.synthesize('平静', [{ text: '第一段', speaker: 'serena', output: '/tmp/i.flac' }], AbortSignal.timeout(5_000))
      await vi.advanceTimersByTimeAsync(599_000)
      expect(processes[0]!.terminated).toBe(false)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(processes[0]!.terminated).toBe(true)
      await worker.synthesize('平静', [{ text: '第二段', speaker: 'serena', output: '/tmp/j.flac' }], AbortSignal.timeout(5_000))
      expect(processes).toHaveLength(2)
      expect(processes[1]!.received.map(request => request.segments[0]!.text)).toEqual(['第二段'])
      await worker.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a request already past its deadline and one outstanding at disposal', async () => {
    const { speech } = await speechConfig()
    const processes: FakeWorkerProcess[] = []
    const worker = new LocalSpeechWorker(workerContext(processes, true), speech)
    await expect(worker.synthesize('平静', [{ text: '晚', speaker: 'serena', output: '/tmp/f.flac' }], AbortSignal.abort(new Error('expired'))))
      .rejects.toThrow('expired')
    const pending = worker.synthesize('平静', [{ text: '未完成', speaker: 'serena', output: '/tmp/g.flac' }], AbortSignal.timeout(5_000))
    await vi.waitFor(() => { expect(processes[0]?.received).toHaveLength(1) })
    const disposal = worker.dispose()
    await expect(pending).rejects.toThrow('TTS worker disposed')
    await disposal
  })
})

describe('speech synthesizer', () => {
  it('synthesizes a segment once and serves the cached file afterwards', async () => {
    const { root, speech } = await speechConfig()
    const engine = new FakeEngine()
    const synthesizer = new SpeechSynthesizer(speech, root, engine, () => undefined)
    const file = await one(synthesizer, '天色已晚。', 'serena', AbortSignal.timeout(5_000))
    expect(file.startsWith(join(root, 'speech'))).toBe(true)
    expect(file.endsWith('.flac')).toBe(true)
    await utimes(file, new Date(0), new Date(0))
    expect(await one(synthesizer, '天色已晚。', 'serena', AbortSignal.timeout(5_000))).toBe(file)
    expect((await stat(file)).mtimeMs).toBeGreaterThan(0)
    expect(engine.jobs).toHaveLength(1)
    expect(await one(synthesizer, '天色已晚。', 'vivian', AbortSignal.timeout(5_000))).not.toBe(file)
    expect(engine.jobs).toHaveLength(2)
    await synthesizer.dispose()
    expect(engine.disposed).toBe(true)
    await expect(one(synthesizer, 'x', 'serena', AbortSignal.timeout(5_000))).rejects.toThrow('synthesizer is closed')
  })

  it('gives a voice its own cache entries once it is anchored, and again when the anchor changes', async () => {
    const { root, speech } = await speechConfig()
    const audio = join(root, 'serena-2.wav')
    await writeFile(audio, 'reference audio bytes')
    const anchored = async (text: string): Promise<string> => {
      const config = resolveConfig({
        speechMode: 'local',
        speechModelPath: speech.modelPath,
        speechLanguage: 'Chinese',
        speechVoicePrompts: [{ voice: 'serena', audio, text }],
      }).speech!
      const synthesizer = new SpeechSynthesizer(config, root, new FakeEngine(), () => undefined)
      const file = await one(synthesizer, '天色已晚。', 'serena', AbortSignal.timeout(5_000))
      await synthesizer.dispose()
      return file
    }
    const plain = new SpeechSynthesizer(speech, root, new FakeEngine(), () => undefined)
    const unanchored = await one(plain, '天色已晚。', 'serena', AbortSignal.timeout(5_000))
    await plain.dispose()
    const first = await anchored('参考文本。')
    const second = await anchored('另一段参考文本。')
    expect(new Set([unanchored, first, second]).size).toBe(3)
    // A voice the anchor does not name keeps the entry it already had.
    const other = new SpeechSynthesizer(speech, root, new FakeEngine(), () => undefined)
    expect(await one(other, '天色已晚。', 'vivian', AbortSignal.timeout(5_000)))
      .toBe(await one(other, '天色已晚。', 'vivian', AbortSignal.timeout(5_000)))
    await other.dispose()
  })

  it('shares one synthesis between concurrent requests for the same text', async () => {
    const { root, speech } = await speechConfig()
    const engine = new FakeEngine(true)
    const synthesizer = new SpeechSynthesizer(speech, root, engine, () => undefined)
    const first = one(synthesizer, '同一句。', 'serena', AbortSignal.timeout(5_000))
    const second = one(synthesizer, '同一句。', 'serena', AbortSignal.timeout(5_000))
    await vi.waitFor(() => { expect(engine.held).toHaveLength(1) })
    engine.held.shift()!()
    expect(await first).toBe(await second)
    expect(engine.jobs).toHaveLength(1)
    await synthesizer.dispose()
  })

  it('skips a queued synthesis nobody waits for, but completes a started one', async () => {
    const { root, speech } = await speechConfig()
    const engine = new FakeEngine(true)
    const synthesizer = new SpeechSynthesizer(speech, root, engine, () => undefined)
    const running = new AbortController()
    const queued = new AbortController()
    const started = one(synthesizer, '第一句。', 'serena', running.signal)
    const waiting = one(synthesizer, '第二句。', 'serena', queued.signal)
    await vi.waitFor(() => { expect(engine.held).toHaveLength(1) })
    queued.abort(new Error('skipped'))
    running.abort(new Error('left'))
    await expect(waiting).rejects.toThrow('skipped')
    await expect(started).rejects.toThrow('left')
    engine.held.shift()!()
    await vi.waitFor(async () => { expect(await readdir(join(root, 'speech'))).toHaveLength(1) })
    expect(engine.jobs.map(job => job.text)).toEqual(['第一句。'])
    await expect(one(synthesizer, '第三句。', 'serena', AbortSignal.abort(new Error('gone')))).rejects.toThrow('gone')
    await synthesizer.dispose()
  })

  it('generates one group in one model call and shares a segment another group is already making', async () => {
    const { root, speech } = await speechConfig()
    const engine = new FakeEngine(true)
    const synthesizer = new SpeechSynthesizer(speech, root, engine, () => undefined)
    const group = { speaker: 'Serena', instruct: '平静', texts: ['第一句。', '第二句。', '第三句。'] }
    const paragraph = synthesizer.audioFiles(group, AbortSignal.timeout(5_000))
    await vi.waitFor(() => { expect(engine.batches).toHaveLength(1) })
    expect(engine.batches[0]!.map(job => job.text)).toEqual(['第一句。', '第二句。', '第三句。'])
    // The next group overlaps this one; only the segment it adds is generated again, and it
    // waits for the engine because one model instance runs one call at a time.
    const next = synthesizer.audioFiles(
      { ...group, texts: ['第三句。', '第四句。'] }, AbortSignal.timeout(5_000),
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(engine.batches).toHaveLength(1)
    engine.held.shift()!()
    await vi.waitFor(() => { expect(engine.batches).toHaveLength(2) })
    expect(engine.batches[1]!.map(job => job.text)).toEqual(['第四句。'])
    for (const release of engine.held.splice(0)) release()
    const [first, second] = await Promise.all([paragraph, next])
    expect(second[0]).toBe(first[2])
    expect(engine.jobs.map(job => job.speaker)).toEqual(['Serena', 'Serena', 'Serena', 'Serena'])
    await synthesizer.dispose()
  })

  it('stops waiting for a request aborted before its synthesis was queued', async () => {
    const { root, speech } = await speechConfig()
    const engine = new FakeEngine()
    const synthesizer = new SpeechSynthesizer(speech, root, engine, () => undefined)
    const requester = new AbortController()
    const pending = one(synthesizer, '转瞬即逝。', 'serena', requester.signal)
    requester.abort(new Error('changed my mind'))
    await expect(pending).rejects.toThrow('changed my mind')
    await synthesizer.dispose()
    expect(engine.jobs).toEqual([])
  })

  it('fails a synthesis whose cache directory cannot be created, and retries it on the next one', async () => {
    const { root, speech } = await speechConfig()
    // A dangling symbolic link at the cache directory makes the lookup report absence and the creation fail.
    await symlink(join(root, 'missing', 'deep'), join(root, 'speech'))
    const engine = new FakeEngine()
    const synthesizer = new SpeechSynthesizer(speech, root, engine, () => undefined)
    await expect(one(synthesizer, '第一句。', 'Serena', AbortSignal.timeout(5_000))).rejects.toThrow('ENOENT')
    expect(engine.jobs).toEqual([])
    await rm(join(root, 'speech'))
    await expect(one(synthesizer, '第一句。', 'Serena', AbortSignal.timeout(5_000))).resolves.toMatch(/\.flac$/)
    await synthesizer.dispose()
  })

  it('surfaces a cache lookup failure other than absence', async () => {
    const { root, speech } = await speechConfig()
    await writeFile(join(root, 'speech'), 'not a directory')
    const synthesizer = new SpeechSynthesizer(speech, root, new FakeEngine(), () => undefined)
    await expect(one(synthesizer, '一句。', 'serena', AbortSignal.timeout(5_000))).rejects.toThrow('ENOTDIR')
    await synthesizer.dispose()
  })

  it('rejects queued requests once disposal begins', async () => {
    const { root, speech } = await speechConfig()
    const engine = new FakeEngine(true)
    const synthesizer = new SpeechSynthesizer(speech, root, engine, () => undefined)
    const running = one(synthesizer, '正在合成。', 'serena', AbortSignal.timeout(5_000))
    // The queued request rejects during disposal, so its expectation waits on it from here.
    const rejected = expect(one(synthesizer, '排队中。', 'serena', AbortSignal.timeout(5_000)))
      .rejects.toThrow('synthesizer is closed')
    await vi.waitFor(() => { expect(engine.held).toHaveLength(1) })
    await synthesizer.dispose()
    await expect(running).resolves.toMatch(/\.flac$/)
    await rejected
    expect(engine.jobs).toHaveLength(1)
  })

  it('fails a synthesis that reports success without audio', async () => {
    const { root, speech } = await speechConfig()
    const synthesizer = new SpeechSynthesizer(speech, root, new FakeEngine(false, 10, false), () => undefined)
    await expect(one(synthesizer, '无声。', 'serena', AbortSignal.timeout(5_000)))
      .rejects.toThrow('reported success without writing readable audio')
    await synthesizer.dispose()
  })

  it('prunes the least recently used audio and stale partial files', async () => {
    const { root, speech } = await speechConfig({ speechCacheMaxBytes: 25, speechRequestTimeoutMs: 1_000 })
    const directory = join(root, 'speech')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'old.flac'), 'x'.repeat(10))
    await utimes(join(directory, 'old.flac'), new Date(1_000), new Date(1_000))
    await writeFile(join(directory, 'recent.flac'), 'x'.repeat(10))
    await writeFile(join(directory, 'stale.flac.part'), 'x')
    await utimes(join(directory, 'stale.flac.part'), new Date(1_000), new Date(1_000))
    await writeFile(join(directory, 'fresh.flac.part'), 'x')
    await writeFile(join(directory, 'notes.txt'), 'kept')
    const synthesizer = new SpeechSynthesizer(speech, root, new FakeEngine(), () => undefined)
    const file = await one(synthesizer, '新的一句。', 'serena', AbortSignal.timeout(5_000))
    await synthesizer.dispose()
    const names = await readdir(directory)
    expect(names.sort()).toEqual([file.slice(directory.length + 1), 'fresh.flac.part', 'notes.txt', 'recent.flac'].sort())
  })

  it('reports a pruning failure without failing the request', async () => {
    const { root, speech } = await speechConfig()
    const reported: Error[] = []
    // The lookup reads the clock once; the second read is the prune's, which fails.
    let reads = 0
    const synthesizer = new SpeechSynthesizer(speech, root, new FakeEngine(), (error) => { reported.push(error) }, () => {
      reads += 1
      if (reads > 1) throw new Error('prune broke')
      return new Date()
    })
    await expect(one(synthesizer, '一句。', 'serena', AbortSignal.timeout(5_000))).resolves.toMatch(/\.flac$/)
    await synthesizer.dispose()
    expect(reported.map(error => error.message)).toEqual(['prune broke'])
  })
})

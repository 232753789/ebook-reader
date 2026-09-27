// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReaderApi } from '../src/client/api.ts'
import { SpeechPlayer, type SpeechSettings, type SpeechSource } from '../src/client/speech-player.ts'
import type { SpeechRequest } from '../src/types.ts'

/** The HTMLAudioElement surface the player drives, with playback under test control. */
class FakeAudio extends EventTarget {
  src = ''
  playbackRate = 1
  paused = true
  /** Rejection reason the next plays fail with; undefined lets them start. */
  playError: unknown = undefined
  readonly played: string[] = []

  play(): Promise<void> {
    this.paused = false
    this.played.push(this.src)
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a non-Error refusal is one scenario under test.
    return this.playError === undefined ? Promise.resolve() : Promise.reject(this.playError)
  }

  pause(): void {
    this.paused = true
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.src = ''
  }

  end(): void {
    this.dispatchEvent(new Event('ended'))
  }
}

/** One group request the player made. */
interface Pending {
  readonly request: SpeechRequest
  readonly signal: AbortSignal
  readonly resolve: (clips: Blob[]) => void
  readonly reject: (error: unknown) => void
}

function harness(options: { settings?: SpeechSettings | undefined; sections?: string[]; failSection?: number } = {}) {
  const sections = options.sections ?? ['第一句。第二句。', '第三句。']
  const pending: Pending[] = []
  const api = {
    speech: vi.fn((request: SpeechRequest, signal: AbortSignal) => new Promise<Blob[]>((resolve, reject) => {
      pending.push({ request, signal, resolve, reject })
    })),
  } as unknown as ReaderApi
  const spoken: { section: number; text: string }[] = []
  const source: SpeechSource = {
    sectionCount: () => sections.length,
    section: index => index === options.failSection
      ? Promise.reject(new Error('chapter unreadable'))
      : Promise.resolve({ text: sections[index]! }),
    spoken: (section, sentence) => { spoken.push({ section, text: sections[section]!.slice(sentence.start, sentence.end) }) },
  }
  const audio = new FakeAudio()
  const settings = 'settings' in options
    ? options.settings
    : { maxSegmentChars: 50, prefetchParagraphs: 1, maxRequestSegments: 24, segmentGapMs: 0 }
  const player = new SpeechPlayer(api, source, () => settings, audio as unknown as HTMLAudioElement)
  /** Answer one group request with one clip per segment it carried. */
  const answer = async (index: number): Promise<void> => {
    await vi.waitFor(() => { expect(pending[index]).toBeDefined() })
    const group = pending[index]!
    group.resolve(group.request.segments.map((_, at) => new Blob([`audio-${String(index)}-${String(at)}`])))
  }
  /** Every segment text requested so far, in request order. */
  const requested = (): string[] => pending.flatMap(entry => [...entry.request.segments])
  return { api, pending, spoken, audio, player, answer, requested }
}

let urls = 0
const revokeObjectURL = vi.fn<(url: string) => void>()
beforeEach(() => {
  urls = 0
  revokeObjectURL.mockClear()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => `blob:segment/${String(++urls)}`) })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
})
afterEach(() => { vi.restoreAllMocks() })

describe('read-aloud player', () => {
  it('reads sentence after sentence across sections, reporting each spoken sentence', async () => {
    const { player, pending, spoken, audio, answer, requested } = harness()
    player.play({ section: 0, offset: 0 }, 'serena', 'technical')
    expect(player.state.getSnapshot()).toEqual({ status: 'buffering' })
    expect(player.active()).toBe(true)
    await vi.waitFor(() => { expect(pending).toHaveLength(2) })
    // The run's first request carries one sentence, so reading starts without waiting for the
    // whole paragraph; the rest of that paragraph follows as its own group.
    expect(pending.map(entry => entry.request.segments)).toEqual([['第一句。'], ['第二句。']])
    expect(pending.every(entry => entry.request.voice === 'serena' && entry.request.style === 'technical')).toBe(true)
    await answer(0)
    await vi.waitFor(() => { expect(player.state.getSnapshot()).toEqual({ status: 'playing' }) })
    expect(audio.played).toEqual(['blob:segment/1'])
    expect(spoken).toEqual([{ section: 0, text: '第一句。' }])

    audio.end()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:segment/1')
    await answer(1)
    await vi.waitFor(() => { expect(spoken.at(-1)).toEqual({ section: 0, text: '第二句。' }) })
    // The next section is one paragraph of its own, requested once the first one finished playing.
    await vi.waitFor(() => { expect(requested()).toEqual(['第一句。', '第二句。', '第三句。']) })
    audio.end()
    await answer(2)
    await vi.waitFor(() => { expect(spoken.at(-1)).toEqual({ section: 1, text: '第三句。' }) })
    audio.end()
    await vi.waitFor(() => { expect(player.state.getSnapshot()).toEqual({ status: 'idle' }) })
    expect(player.active()).toBe(false)
  })

  it('reads the whole sentence the starting offset falls in', async () => {
    const { player, spoken, requested, answer } = harness({
      settings: { maxSegmentChars: 50, prefetchParagraphs: 0, maxRequestSegments: 24, segmentGapMs: 0 },
    })
    player.play({ section: 0, offset: 2 }, 'vivian', 'none')
    await answer(0)
    expect(requested()[0]).toBe('第一句。')
    await vi.waitFor(() => { expect(spoken).toEqual([{ section: 0, text: '第一句。' }]) })
  })

  it('pauses and resumes only the matching states, and applies the playback rate', async () => {
    const { player, audio, answer } = harness()
    player.setRate(1.5)
    expect(audio.playbackRate).toBe(1.5)
    player.pause()
    player.resume()
    expect(player.state.getSnapshot()).toEqual({ status: 'idle' })
    player.play({ section: 0, offset: 0 }, 'serena', 'technical')
    player.pause()
    expect(player.state.getSnapshot()).toEqual({ status: 'buffering' })
    await answer(0)
    await vi.waitFor(() => { expect(player.state.getSnapshot()).toEqual({ status: 'playing' }) })
    expect(audio.playbackRate).toBe(1.5)
    player.pause()
    expect(player.state.getSnapshot()).toEqual({ status: 'paused' })
    expect(audio.paused).toBe(true)
    player.resume()
    expect(player.state.getSnapshot()).toEqual({ status: 'playing' })
    expect(audio.paused).toBe(false)
  })

  it('holds the segment gap between sentences, and lets a pause interrupt it', async () => {
    const { player, audio, answer } = harness({
      settings: { maxSegmentChars: 50, prefetchParagraphs: 1, maxRequestSegments: 24, segmentGapMs: 40 },
    })
    player.play({ section: 0, offset: 0 }, 'serena', 'technical')
    await answer(0)
    await answer(1)
    await vi.waitFor(() => { expect(audio.played).toEqual(['blob:segment/1']) })

    audio.end()
    // The silence is held before the next sentence, and the run keeps reading through it.
    expect(audio.played).toEqual(['blob:segment/1'])
    expect(player.state.getSnapshot()).toEqual({ status: 'playing' })
    await vi.waitFor(() => { expect(audio.played).toHaveLength(2) })

    audio.end()
    player.pause()
    expect(player.state.getSnapshot()).toEqual({ status: 'paused' })
    await new Promise((resolve) => { setTimeout(resolve, 80) })
    expect(audio.played).toHaveLength(2)
    player.resume()
    expect(player.state.getSnapshot()).toEqual({ status: 'playing' })
    await answer(2)
    await vi.waitFor(() => { expect(audio.played).toHaveLength(3) })
  })

  it('stops by aborting outstanding synthesis and releasing the audio', async () => {
    const { player, pending, audio, answer } = harness()
    player.play({ section: 0, offset: 0 }, 'serena', 'technical')
    await answer(0)
    await vi.waitFor(() => { expect(player.state.getSnapshot().status).toBe('playing') })
    player.stop()
    expect(player.state.getSnapshot()).toEqual({ status: 'idle' })
    expect(pending.every(entry => entry.signal.aborted)).toBe(true)
    expect(audio.src).toBe('')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:segment/1')
    // Events of the finished run change nothing.
    audio.end()
    audio.dispatchEvent(new Event('error'))
    expect(player.state.getSnapshot()).toEqual({ status: 'idle' })
    player.stop()
    expect(player.state.getSnapshot()).toEqual({ status: 'idle' })
  })

  it('reports unavailable read-aloud, failed synthesis, unplayable audio, and unreadable sections', async () => {
    const disabled = harness({ settings: undefined })
    disabled.player.play({ section: 0, offset: 0 }, 'serena', 'technical')
    expect(disabled.player.state.getSnapshot()).toEqual({ status: 'error', message: 'read-aloud is unavailable' })

    const failed = harness()
    failed.player.play({ section: 0, offset: 0 }, 'serena', 'technical')
    await vi.waitFor(() => { expect(failed.pending).toHaveLength(2) })
    failed.pending[0]!.reject(new Error('unknown voice: serena'))
    await vi.waitFor(() => { expect(failed.player.state.getSnapshot()).toEqual({ status: 'error', message: 'unknown voice: serena' }) })

    const blocked = harness()
    blocked.audio.playError = new Error('NotAllowedError')
    blocked.player.play({ section: 0, offset: 0 }, 'serena', 'technical')
    await blocked.answer(0)
    await vi.waitFor(() => { expect(blocked.player.state.getSnapshot()).toEqual({ status: 'error', message: 'NotAllowedError' }) })

    const broken = harness()
    broken.player.play({ section: 0, offset: 0 }, 'serena', 'technical')
    await broken.answer(0)
    await vi.waitFor(() => { expect(broken.player.state.getSnapshot().status).toBe('playing') })
    broken.audio.dispatchEvent(new Event('error'))
    expect(broken.player.state.getSnapshot()).toEqual({ status: 'error', message: 'ebook-reader: the audio could not be played' })

    const unreadable = harness({ failSection: 0 })
    unreadable.player.play({ section: 0, offset: 0 }, 'serena', 'technical')
    await vi.waitFor(() => { expect(unreadable.player.state.getSnapshot()).toEqual({ status: 'error', message: 'chapter unreadable' }) })

    const later = harness({
      failSection: 1,
      settings: { maxSegmentChars: 50, prefetchParagraphs: 0, maxRequestSegments: 24, segmentGapMs: 0 },
    })
    later.player.play({ section: 0, offset: 5 }, 'serena', 'technical')
    await later.answer(0)
    await vi.waitFor(() => { expect(later.player.state.getSnapshot().status).toBe('playing') })
    later.audio.end()
    await vi.waitFor(() => { expect(later.player.state.getSnapshot()).toEqual({ status: 'error', message: 'chapter unreadable' }) })
  })

  it('fails a resume the browser refuses, and ignores a stale rejection after another run began', async () => {
    const { player, audio, answer } = harness()
    player.play({ section: 0, offset: 0 }, 'serena', 'technical')
    await answer(0)
    await vi.waitFor(() => { expect(player.state.getSnapshot().status).toBe('playing') })
    player.pause()
    audio.playError = 'refused'
    player.resume()
    await vi.waitFor(() => { expect(player.state.getSnapshot()).toEqual({ status: 'error', message: 'refused' }) })

    const stale = harness()
    stale.player.play({ section: 0, offset: 0 }, 'serena', 'technical')
    await vi.waitFor(() => { expect(stale.pending).toHaveLength(2) })
    const rejectStale = stale.pending[0]!.reject
    stale.player.play({ section: 1, offset: 0 }, 'serena', 'technical')
    rejectStale(new Error('aborted'))
    await Promise.resolve()
    expect(stale.player.state.getSnapshot()).toEqual({ status: 'buffering' })
  })

  it('abandons a run stopped while a section loads, while audio arrives, or while playback starts', async () => {
    let releaseSection: (() => void) | undefined
    const slow = harness()
    const section = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { releaseSection = () => { resolve({ text: '慢。' }) } }))
    const player = new SpeechPlayer(
      slow.api,
      { sectionCount: () => 1, section, spoken: vi.fn() },
      () => ({ maxSegmentChars: 50, prefetchParagraphs: 0, maxRequestSegments: 24, segmentGapMs: 0 }),
      slow.audio as unknown as HTMLAudioElement,
    )
    player.play({ section: 0, offset: 0 }, 'serena', 'technical')
    await vi.waitFor(() => { expect(releaseSection).toBeDefined() })
    player.stop()
    releaseSection!()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(slow.pending).toEqual([])
    expect(player.state.getSnapshot()).toEqual({ status: 'idle' })

    const arriving = harness()
    arriving.player.play({ section: 0, offset: 0 }, 'serena', 'technical')
    await vi.waitFor(() => { expect(arriving.pending.length).toBeGreaterThan(0) })
    arriving.player.stop()
    await arriving.answer(0)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(arriving.audio.played).toEqual([])

    let started: (() => void) | undefined
    const starting = harness()
    starting.audio.play = () => new Promise<void>((resolve) => { started = resolve })
    starting.player.play({ section: 0, offset: 0 }, 'serena', 'technical')
    await starting.answer(0)
    await vi.waitFor(() => { expect(started).toBeDefined() })
    starting.player.stop()
    started!()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(starting.player.state.getSnapshot()).toEqual({ status: 'idle' })
  })

  it('stops with an error when prefetching reaches an unreadable section', async () => {
    const { player } = harness({
      failSection: 1,
      settings: { maxSegmentChars: 50, prefetchParagraphs: 1, maxRequestSegments: 24, segmentGapMs: 0 },
    })
    player.play({ section: 0, offset: 5 }, 'serena', 'technical')
    await vi.waitFor(() => { expect(player.state.getSnapshot()).toEqual({ status: 'error', message: 'chapter unreadable' }) })
  })

  it('moves on without buffering when the next segment already arrived', async () => {
    const { player, audio, answer } = harness()
    const statuses: string[] = []
    player.state.subscribe(() => { statuses.push(player.state.getSnapshot().status) })
    player.play({ section: 0, offset: 0 }, 'serena', 'technical')
    await answer(0)
    await answer(1)
    await vi.waitFor(() => { expect(player.state.getSnapshot().status).toBe('playing') })
    statuses.length = 0
    audio.end()
    await vi.waitFor(() => { expect(audio.played).toHaveLength(2) })
    expect(statuses).not.toContain('buffering')
  })

  it('plays in text order when a later group\'s audio arrives first', async () => {
    const { player, pending, spoken, audio } = harness({ sections: ['第一句。第二句。第三句。'] })
    player.play({ section: 0, offset: 0 }, 'serena', 'none')
    await vi.waitFor(() => { expect(pending).toHaveLength(2) })
    // One paragraph, split only by the run's fast start: one sentence, then the rest together.
    expect(pending.map(entry => entry.request.segments)).toEqual([['第一句。'], ['第二句。', '第三句。']])
    pending[1]!.resolve([new Blob(['audio-2']), new Blob(['audio-3'])])
    await new Promise(resolve => setTimeout(resolve, 0))
    // Nothing plays while the first sentence is still being synthesized.
    expect(audio.played).toEqual([])
    expect(player.state.getSnapshot()).toEqual({ status: 'buffering' })
    pending[0]!.resolve([new Blob(['audio-1'])])
    await vi.waitFor(() => { expect(player.state.getSnapshot().status).toBe('playing') })
    audio.end()
    await vi.waitFor(() => { expect(audio.played).toHaveLength(2) })
    audio.end()
    await vi.waitFor(() => { expect(audio.played).toHaveLength(3) })
    expect(spoken).toEqual([
      { section: 0, text: '第一句。' },
      { section: 0, text: '第二句。' },
      { section: 0, text: '第三句。' },
    ])
    // The group's last sentence frees its place in the window, and the book has nothing after it.
    audio.end()
    await vi.waitFor(() => { expect(player.state.getSnapshot()).toEqual({ status: 'idle' }) })
  })

  it('synthesizes every group of a run with its voice and style, and restarts when either changes', async () => {
    const { player, pending, audio, answer } = harness({ sections: ['第一句。第二句。', '第三句。'] })
    player.play({ section: 0, offset: 0 }, 'serena', 'technical')
    await vi.waitFor(() => { expect(pending).toHaveLength(2) })
    await answer(0)
    await vi.waitFor(() => { expect(player.state.getSnapshot().status).toBe('playing') })
    audio.end()
    await answer(1)
    await vi.waitFor(() => { expect(pending).toHaveLength(3) })
    expect(pending.every(entry => entry.request.voice === 'serena' && entry.request.style === 'technical')).toBe(true)

    // Choosing another voice or category restarts the run, so nothing left over is played with the old one.
    const before = pending.length
    player.play({ section: 0, offset: 0 }, 'vivian', 'fiction')
    await vi.waitFor(() => { expect(pending.length).toBeGreaterThan(before) })
    expect(pending.slice(before).every(entry => entry.request.voice === 'vivian' && entry.request.style === 'fiction')).toBe(true)
    expect(pending.slice(0, before).every(entry => entry.signal.aborted)).toBe(true)
  })

  it('fails when a group comes back with fewer clips than it asked for', async () => {
    const { player, pending, audio } = harness({ sections: ['第一句。第二句。第三句。'] })
    player.play({ section: 0, offset: 0 }, 'serena', 'none')
    await vi.waitFor(() => { expect(pending).toHaveLength(2) })
    pending[0]!.resolve([new Blob(['audio-1'])])
    await vi.waitFor(() => { expect(player.state.getSnapshot().status).toBe('playing') })
    // The second group carries two sentences and answers with one.
    pending[1]!.resolve([new Blob(['audio-2'])])
    audio.end()
    await vi.waitFor(() => { expect(audio.played).toHaveLength(2) })
    audio.end()
    await vi.waitFor(() => {
      expect(player.state.getSnapshot())
        .toEqual({ status: 'error', message: 'ebook-reader: the Host returned fewer clips than segments' })
    })
  })

  it('reads nothing for a section without speakable text and detaches on disposal', async () => {
    const { player, pending, audio } = harness({ sections: ['……'] })
    player.play({ section: 0, offset: 0 }, 'serena', 'technical')
    await vi.waitFor(() => { expect(player.state.getSnapshot()).toEqual({ status: 'idle' }) })
    expect(pending).toEqual([])
    const removed = vi.spyOn(audio, 'removeEventListener')
    player.dispose()
    expect(removed.mock.calls.map(call => call[0])).toEqual(['ended', 'error'])
  })
})

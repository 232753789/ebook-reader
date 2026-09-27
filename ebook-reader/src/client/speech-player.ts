/** Read-aloud playback: segments the book from a position, synthesizes ahead, and reports the spoken position. */

import type { ReadingPosition } from '../types.ts'
import type { ReaderApi } from './api.ts'
import { speechGroups, speechSegments, speechText, type TextSpan } from './reading-text.ts'
import { Observable } from './observable.ts'

/** Playback status. `buffering` waits for the next segment's audio. */
export type SpeechStatus = 'idle' | 'buffering' | 'playing' | 'paused' | 'error'

/** Published playback state. */
export interface SpeechState {
  readonly status: SpeechStatus
  /** Failure description while `status` is `error`. */
  readonly message?: string
}

/** Segmenting limits from the Host's speech capabilities. */
export interface SpeechSettings {
  readonly maxSegmentChars: number
  /** Paragraphs requested ahead of the one playing. */
  readonly prefetchParagraphs: number
  /** Most segments one request may carry; a longer paragraph is cut to fit. */
  readonly maxRequestSegments: number
  /** Silence held between one segment's audio and the next; 0 plays them back to back. */
  readonly segmentGapMs: number
}

/** The book text read-aloud walks through, and where it reports progress. */
export interface SpeechSource {
  /** @returns the open book's section count, 0 when none is open. */
  sectionCount(): number
  /**
   * @param index - zero-based section.
   * @returns its reading text and block starts.
   */
  section(index: number): Promise<{
    readonly text: string
    readonly breaks?: readonly number[]
    /** Spans of the section that are not body prose; read-aloud skips them. */
    readonly skip?: readonly TextSpan[]
  }>
  /**
   * Playback moved on to a sentence.
   * @param section - zero-based section holding it.
   * @param sentence - its span of the section's reading text.
   */
  spoken(section: number, sentence: TextSpan): void
}

interface Segment {
  readonly section: number
  readonly span: TextSpan
  readonly text: string
}

interface QueuedSegment extends Segment {
  readonly audio: Promise<Blob>
  /** Set once the audio arrived, so moving on to this segment shows no buffering. */
  ready: boolean
  /** Called when this segment leaves the queue; the last of its request frees a window place. */
  readonly release: () => void
}

/** One paragraph's segments, as the Host generates them: one request, one model call. */
interface Group {
  readonly section: number
  readonly segments: readonly Segment[]
}

interface Playing extends Segment {
  readonly url: string
}

/** One `play` call's state; `stop` or the next `play` replaces it. */
interface Run {
  readonly requests: AbortController
  readonly groups: AsyncGenerator<Group>
  /** The one voice every segment of this run is synthesized with. */
  readonly voice: string
  /** The one reading style every segment of this run is synthesized with. */
  readonly style: string
  /** Silence held between segments of this run. */
  readonly gap: number
  /** Requested paragraphs still holding unplayed segments: the playing one plus the prefetch. */
  readonly window: number
  readonly queue: QueuedSegment[]
  /** Paragraphs requested so far and not yet fully played, counting the one being played. */
  requested: number
  exhausted: boolean
  filling: Promise<void> | undefined
  /** Cleared once the first request of the run is made, which is the one sentence that starts it. */
  fastStart: boolean
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Plays a book aloud from a position, one sentence after another.
 *
 * Each `play` starts a run; `stop` or another `play` ends it, aborting its outstanding synthesis
 * requests. A finished segment is followed by `segmentGapMs` of silence before the next one starts;
 * the run's first segment starts without it. The queue holds the playing segment plus up to `prefetchSegments` requested ahead, all
 * in flight at once so the Host generates the window in parallel; each finished segment makes room
 * for one more. Playback stays in text order whatever order the audio arrives in: only `queue[0]`
 * ever plays, and a segment that arrived early waits its turn. One run synthesizes and plays every
 * segment with the voice `play` was called with, so a voice change restarts the run.
 */
export class SpeechPlayer {
  /** Published playback state. */
  readonly state = new Observable<SpeechState>({ status: 'idle' })
  private run: Run | undefined
  private playing: Playing | undefined
  private rate = 1
  /** Set while the silence after a finished segment is being held. */
  private gapTimer: ReturnType<typeof setTimeout> | undefined
  /** The run whose silence `pause` interrupted, so `resume` moves straight on to its next segment. */
  private gapPaused: Run | undefined

  /**
   * @param api - Host routes.
   * @param source - the open book.
   * @param settings - segmenting limits, undefined while read-aloud is unavailable.
   * @param audio - the element playing each segment.
   */
  constructor(
    private readonly api: ReaderApi,
    private readonly source: SpeechSource,
    private readonly settings: () => SpeechSettings | undefined,
    private readonly audio: HTMLAudioElement,
  ) {
    audio.addEventListener('ended', this.onEnded)
    audio.addEventListener('error', this.onError)
  }

  /**
   * Report whether read-aloud owns the reading position.
   * @returns whether a run is in progress (buffering, playing, or paused).
   */
  active(): boolean {
    const status = this.state.getSnapshot().status
    return status === 'buffering' || status === 'playing' || status === 'paused'
  }

  /**
   * Start reading aloud, replacing any run in progress.
   * @param from - where reading starts.
   * @param voice - speaker id.
   * @param style - reading-style id every segment of this run is synthesized with.
   */
  play(from: ReadingPosition, voice: string, style: string): void {
    this.stop()
    const settings = this.settings()
    if (settings === undefined) {
      this.state.set({ status: 'error', message: 'read-aloud is unavailable' })
      return
    }
    const run: Run = {
      requests: new AbortController(),
      groups: this.walk(from, settings),
      voice,
      style,
      gap: settings.segmentGapMs,
      window: 1 + settings.prefetchParagraphs,
      queue: [],
      requested: 0,
      exhausted: false,
      filling: undefined,
      fastStart: true,
    }
    this.run = run
    this.state.set({ status: 'buffering' })
    void this.advance(run)
  }

  /** Pause the segment playing now; synthesis ahead continues. Only a playing run pauses. */
  pause(): void {
    if (this.state.getSnapshot().status !== 'playing') return
    if (this.gapTimer !== undefined) {
      this.clearGap()
      this.gapPaused = this.run
    }
    this.audio.pause()
    this.state.set({ status: 'paused' })
  }

  /** Continue a paused segment. */
  resume(): void {
    if (this.state.getSnapshot().status !== 'paused') return
    const run = this.run
    const interrupted = this.gapPaused
    this.state.set({ status: 'playing' })
    if (interrupted !== undefined) {
      this.gapPaused = undefined
      void this.advance(interrupted)
      return
    }
    this.audio.play().catch((error: unknown) => { this.fail(run, error) })
  }

  /**
   * Set the playback speed of this and later segments.
   * @param rate - playback rate, 1 for normal speed.
   */
  setRate(rate: number): void {
    this.rate = rate
    this.audio.playbackRate = rate
  }

  /** End the run: stop playback, abort outstanding synthesis, and release audio. */
  stop(): void {
    const run = this.run
    this.run = undefined
    this.clearGap()
    this.gapPaused = undefined
    if (run !== undefined) {
      run.requests.abort(new Error('ebook-reader: read-aloud stopped'))
      void run.groups.return(undefined)
    }
    this.audio.pause()
    this.release()
    if (this.state.getSnapshot().status !== 'idle') this.state.set({ status: 'idle' })
  }

  /** Stop and detach from the audio element. */
  dispose(): void {
    this.stop()
    this.audio.removeEventListener('ended', this.onEnded)
    this.audio.removeEventListener('error', this.onError)
  }

  private async *walk(from: ReadingPosition, settings: SpeechSettings): AsyncGenerator<Group> {
    for (let section = from.section; section < this.source.sectionCount(); section += 1) {
      const loaded = await this.source.section(section)
      const start = section === from.section ? from.offset : 0
      const spans = speechSegments(loaded.text, start, settings.maxSegmentChars, loaded.breaks, loaded.skip)
      for (const group of speechGroups(spans, loaded.breaks, settings.maxRequestSegments)) {
        // Every segment holds a letter, so its speech text is never empty.
        yield {
          section,
          segments: group.map(span => ({ section, span, text: speechText(loaded.text.slice(span.start, span.end)) })),
        }
      }
    }
  }

  /**
   * Request paragraphs until the playing one and the prefetch window are in flight.
   *
   * A request carries one paragraph, which the Host generates in one model call. The run's first
   * request carries only the first sentence, so reading starts as soon as that sentence is ready
   * instead of after the whole paragraph; the rest of that paragraph follows as its own request.
   */
  private fill(run: Run): Promise<void> {
    run.filling ??= (async () => {
      while (run === this.run && !run.exhausted && run.requested < run.window) {
        const next = await run.groups.next()
        if (run !== this.run) return
        if (next.done === true) {
          run.exhausted = true
          return
        }
        let segments = next.value.segments
        if (run.fastStart) {
          run.fastStart = false
          const [first, ...rest] = segments
          if (first !== undefined && rest.length > 0) {
            this.request(run, [first])
            segments = rest
          }
        }
        this.request(run, segments)
      }
    })().finally(() => { run.filling = undefined })
    return run.filling
  }

  /** Send one group and queue its segments in reading order. */
  private request(run: Run, segments: readonly Segment[]): void {
    const audio = this.api.speech(
      { segments: segments.map(segment => segment.text), voice: run.voice, style: run.style },
      run.requests.signal,
    )
    // The rejection handler also keeps a request abandoned by stop() from being unhandled.
    audio.catch(() => undefined)
    run.requested += 1
    let outstanding = segments.length
    // A segment is released as it leaves the queue, which only happens for the run playing it.
    const release = (): void => {
      outstanding -= 1
      if (outstanding > 0) return
      run.requested -= 1
      void this.fill(run).catch((error: unknown) => { this.fail(run, error) })
    }
    for (const [index, segment] of segments.entries()) {
      const queued: QueuedSegment = {
        ...segment,
        audio: audio.then((clips) => {
          const clip = clips[index]
          if (clip === undefined) throw new Error('ebook-reader: the Host returned fewer clips than segments')
          return clip
        }),
        ready: false,
        release,
      }
      queued.audio.then(() => { queued.ready = true }, () => undefined)
      run.queue.push(queued)
    }
  }

  private async advance(run: Run): Promise<void> {
    try {
      await this.fill(run)
    } catch (error) {
      this.fail(run, error)
      return
    }
    if (run !== this.run) return
    const next = run.queue[0]
    if (next === undefined) {
      this.state.set({ status: 'idle' })
      return
    }
    if (!next.ready) this.state.set({ status: 'buffering' })
    let blob: Blob
    try {
      blob = await next.audio
    } catch (error) {
      this.fail(run, error)
      return
    }
    if (run !== this.run) return
    this.playing = { ...next, url: URL.createObjectURL(blob) }
    this.audio.src = this.playing.url
    this.audio.playbackRate = this.rate
    this.source.spoken(next.section, next.span)
    try {
      await this.audio.play()
    } catch (error) {
      this.fail(run, error)
      return
    }
    if (run === this.run) this.state.set({ status: 'playing' })
  }

  private readonly onEnded = (): void => {
    // A playing segment belongs to the current run; stop() releases it with the run.
    const run = this.run
    if (this.playing === undefined || run === undefined) return
    this.release()
    run.queue.shift()?.release()
    if (run.gap <= 0) {
      void this.advance(run)
      return
    }
    // The state stays `playing` through the silence, which is part of the reading.
    this.gapTimer = setTimeout(() => {
      this.gapTimer = undefined
      void this.advance(run)
    }, run.gap)
  }

  private clearGap(): void {
    if (this.gapTimer === undefined) return
    clearTimeout(this.gapTimer)
    this.gapTimer = undefined
  }

  private readonly onError = (): void => {
    if (this.playing === undefined) return
    this.fail(this.run, new Error('ebook-reader: the audio could not be played'))
  }

  private release(): void {
    if (this.playing === undefined) return
    URL.revokeObjectURL(this.playing.url)
    this.playing = undefined
    this.audio.removeAttribute('src')
  }

  private fail(run: Run | undefined, error: unknown): void {
    if (run !== this.run) return
    const text = message(error)
    this.stop()
    this.state.set({ status: 'error', message: text })
  }
}

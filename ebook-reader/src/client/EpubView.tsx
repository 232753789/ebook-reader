/**
 * One EPUB chapter at a time. The chapter's visual lines are measured after layout (and again on
 * resize, font change, and image load); the sentence being read aloud is highlighted, or the line
 * containing the reading offset while reading by hand.
 * Clicking a line or stepping with the arrow keys moves the position, and links inside the book
 * navigate in place.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type UIEvent } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReadingPosition } from '../types.ts'
import type { BookSection, EpubSection } from './book.ts'
import { measureLines, measureSpan, type LineBox, type VisualLine } from './epub-lines.ts'
import { lineAt, type TextSpan } from './reading-text.ts'
import css from './EpubView.module.css'

/** Chapter text size before the reader's font scale. */
const BASE_FONT_PX = 18
/** Quiet period after scrolling before the position follows the viewport. */
const SETTLE_DELAY_MS = 250

/** EPUB view props. */
export interface EpubViewProps {
  readonly sectionCount: number
  readonly position: ReadingPosition
  readonly reveal: number
  readonly fontScale: number
  readonly speaking: boolean
  /** The sentence being read aloud, highlighted in place of the reading line. */
  readonly sentence: TextSpan | undefined
  readonly section: (index: number) => Promise<BookSection>
  readonly goTo: (position: ReadingPosition) => void
  readonly settle: (position: ReadingPosition) => void
  readonly followLink: (from: number, href: string) => Promise<boolean>
  readonly t: TranslateNS<'ebook-reader'>
}

type Chapter =
  | { readonly status: 'loading'; readonly index: number }
  | { readonly status: 'ready'; readonly index: number; readonly section: EpubSection }
  | { readonly status: 'error'; readonly index: number; readonly message: string }

/**
 * Render the chapter holding the reading position.
 * @param props - position, font scale, loaders, and navigation callbacks.
 * @returns the scrolling chapter.
 */
export function EpubView({
  sectionCount, position, reveal, fontScale, speaking, sentence, section, goTo, settle, followLink, t,
}: EpubViewProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const article = useRef<HTMLDivElement>(null)
  const [chapter, setChapter] = useState<Chapter>({ status: 'loading', index: position.section })
  const [lines, setLines] = useState<readonly VisualLine[]>([])
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const index = position.section

  useEffect(() => {
    let cancelled = false
    setChapter({ status: 'loading', index })
    setLines([])
    section(index).then(
      (loaded) => {
        if (cancelled || loaded.kind !== 'epub') return
        setChapter({ status: 'ready', index, section: loaded })
      },
      (error: unknown) => {
        if (!cancelled) setChapter({ status: 'error', index, message: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => {
      cancelled = true
      // A pending scroll settle belongs to the chapter being left.
      clearTimeout(settleTimer.current)
    }
  }, [index, section])

  const html = chapter.status === 'ready' ? chapter.section.html : undefined

  useLayoutEffect(() => {
    const element = article.current
    // The article renders exactly when the chapter markup is ready.
    if (html === undefined || element === null) return
    const remeasure = (): void => { setLines(measureLines(element)) }
    remeasure()
    let frame = 0
    const schedule = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(remeasure)
    }
    const resize = new ResizeObserver(schedule)
    resize.observe(element)
    const images = [...element.querySelectorAll('img, image')]
    for (const image of images) image.addEventListener('load', schedule)
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      for (const image of images) image.removeEventListener('load', schedule)
    }
  }, [html, fontScale])

  const active = lines.length === 0 ? -1 : Math.max(0, lineAt(lines, position.offset))
  const activeLine = active >= 0 ? lines[active] : undefined
  const [spoken, setSpoken] = useState<readonly LineBox[]>([])

  // The sentence read aloud is boxed row by row, as a text selection would show it.
  useLayoutEffect(() => {
    const element = article.current
    setSpoken(sentence === undefined || element === null ? [] : measureSpan(element, sentence))
  }, [sentence, lines])

  const highlight = sentence === undefined
    ? (activeLine === undefined ? [] : [activeLine])
    : spoken

  // Reveal: scroll the active line into view, or the chapter top before its lines are measured.
  useEffect(() => {
    const element = scroller.current
    const body = article.current
    // The article renders only once the chapter is ready.
    if (element === null || body === null) return
    const top = body.offsetTop + (activeLine?.top ?? 0)
    const bottom = body.offsetTop + (activeLine?.bottom ?? 0)
    if (activeLine !== undefined && top >= element.scrollTop + 8 && bottom <= element.scrollTop + element.clientHeight - 8) return
    const atStart = activeLine === undefined || position.offset === 0 && active === 0
    const destination = Math.max(0, atStart ? 0 : top - element.clientHeight * 0.3)
    element.scrollTo({ top: destination, behavior: Math.abs(destination - element.scrollTop) < element.clientHeight * 2 ? 'smooth' : 'auto' })
    // Revealing follows the reveal counter and re-measurement, not every position update.
  }, [reveal, lines, chapter.status])

  const onScroll = (event: UIEvent<HTMLDivElement>): void => {
    clearTimeout(settleTimer.current)
    const element = event.currentTarget
    const body = article.current
    // Read-aloud drives the position while speaking; a chapter still loading has no lines to follow.
    if (speaking || body === null) return
    settleTimer.current = setTimeout(() => {
      const viewTop = element.scrollTop - body.offsetTop
      const viewBottom = viewTop + element.clientHeight
      const first = lines.find(line => line.top >= viewTop) ?? lines.at(-1)
      // Unmeasured lines leave the position alone, and so does a view still showing the active line.
      if (first === undefined || activeLine !== undefined && activeLine.top >= viewTop && activeLine.top <= viewBottom) return
      settle({ section: index, offset: first.start })
    }, SETTLE_DELAY_MS)
  }

  const moveLine = (delta: 1 | -1): void => {
    const line = lines[active + delta]
    if (line !== undefined) {
      goTo({ section: index, offset: line.start })
      return
    }
    const target = index + delta
    if (target < 0 || target >= sectionCount) return
    // Stepping past the chapter's edge opens the neighbour at its start or its end.
    if (delta > 0) {
      goTo({ section: target, offset: 0 })
      return
    }
    // A chapter that fails to load leaves the position where it is.
    void section(target).then((loaded) => { goTo({ section: target, offset: Math.max(0, loaded.text.length - 1) }) }, () => undefined)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'j') {
      event.preventDefault()
      moveLine(1)
    } else if (event.key === 'ArrowUp' || event.key === 'k') {
      event.preventDefault()
      moveLine(-1)
    }
  }

  const onClick = (event: MouseEvent<HTMLDivElement>): void => {
    const href = (event.target as Element).closest('a[href]')?.getAttribute('href')
    if (typeof href === 'string') {
      // Links leaving the book open in a new tab through their own target.
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return
      event.preventDefault()
      void followLink(index, href)
      return
    }
    // A click that ends a text selection selects, it does not move the reading position.
    if (window.getSelection()?.isCollapsed === false) return
    const y = event.clientY - event.currentTarget.getBoundingClientRect().top
    const hit = lines.find(line => y >= line.top - 2 && y <= line.bottom + 2)
    if (hit !== undefined) goTo({ section: index, offset: hit.start })
  }

  return (
    <div ref={scroller} className={css.scroller} tabIndex={0} data-testid="epub-view" onScroll={onScroll} onKeyDown={onKeyDown}>
      {chapter.status === 'loading' && <div className={css.status}>{t('reader.sectionLoading')}</div>}
      {chapter.status === 'error' && <div className={css.status} role="alert">{t('reader.sectionError', { message: chapter.message })}</div>}
      {html !== undefined && (
        <div className={css.page} style={{ fontSize: BASE_FONT_PX * fontScale }}>
          <div ref={article} className={css.article} onClick={onClick}>
            {highlight.map(line => (
              <div
                key={`${String(line.top)}:${String(line.left)}`}
                className={css.line}
                data-testid="epub-active-line"
                aria-hidden="true"
                style={{
                  top: line.top - 2,
                  left: line.left - 4,
                  width: line.right - line.left + 8,
                  height: line.bottom - line.top + 4,
                }}
              />
            ))}
            <div className={css.content} dangerouslySetInnerHTML={{ __html: html }} />
          </div>
          <nav className={css.chapterNav}>
            <button type="button" disabled={index === 0} onClick={() => { goTo({ section: index - 1, offset: 0 }) }}>
              {t('reader.previousChapter')}
            </button>
            <button type="button" disabled={index + 1 >= sectionCount} onClick={() => { goTo({ section: index + 1, offset: 0 }) }}>
              {t('reader.nextChapter')}
            </button>
          </nav>
        </div>
      )}
    </div>
  )
}

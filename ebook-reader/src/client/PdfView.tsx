/**
 * Continuous PDF pages. Only pages near the viewport hold a rendered canvas; the page holding the
 * reading position highlights the sentence being read aloud, or the line containing its offset
 * while reading by hand. Clicking a line or stepping with the arrow keys moves the position line
 * by line, and a revealed position scrolls into view.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReadingPosition } from '../types.ts'
import type { BookSection, PageRender, PageSize, PdfSection } from './book.ts'
import { spanBoxes, type PageBox } from './pdf-lines.ts'
import { lineAt, type TextSpan } from './reading-text.ts'
import css from './PdfView.module.css'

/** Horizontal room around a fit-to-width page. */
const PAGE_GUTTER = 48
/** Quiet period after scrolling before the position follows the viewport. */
const SETTLE_DELAY_MS = 250
/** One identity for every page that highlights nothing, so pages memoize across renders. */
const NO_BOXES: readonly PageBox[] = []

/** PDF view props. */
export interface PdfViewProps {
  readonly sectionCount: number
  readonly position: ReadingPosition
  readonly reveal: number
  readonly zoom: number
  readonly speaking: boolean
  /** The sentence being read aloud, highlighted in place of the reading line. */
  readonly sentence: TextSpan | undefined
  readonly section: (index: number) => Promise<BookSection>
  readonly renderPage: (index: number, canvas: HTMLCanvasElement, scale: number) => PageRender
  readonly pageSize: (index: number) => PageSize | undefined
  readonly goTo: (position: ReadingPosition) => void
  readonly settle: (position: ReadingPosition) => void
  readonly t: TranslateNS<'ebook-reader'>
}

interface PdfPageProps {
  readonly index: number
  readonly scale: number
  readonly size: PageSize
  readonly text: PdfSection | undefined
  readonly highlight: readonly PageBox[]
  readonly renderPage: PdfViewProps['renderPage']
  readonly noText: string
}

/** One rendered page: its canvas and the highlighted boxes. */
const PdfPage = memo(function PdfPage({ index, scale, size, text, highlight, renderPage, noText }: PdfPageProps) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    /* v8 ignore next -- the canvas renders unconditionally, so the ref is attached by effect time. */
    if (canvas.current === null) return
    const render = renderPage(index, canvas.current, scale)
    // A cancelled or failed render leaves the placeholder; the next scale change retries.
    render.done.catch(() => undefined)
    return () => { render.cancel() }
  }, [index, scale, renderPage])
  return (
    <>
      <canvas ref={canvas} className={css.canvas} style={{ width: size.width * scale, height: size.height * scale }} />
      {highlight.map(box => (
        <div
          key={`${String(box.top)}:${String(box.left)}`}
          className={css.line}
          data-testid="pdf-active-line"
          style={{
            left: box.left * scale - 3,
            top: box.top * scale - 2,
            width: box.width * scale + 6,
            height: box.height * scale + 4,
          }}
        />
      ))}
      {text !== undefined && text.lines.length === 0 && <div className={css.noText}>{noText}</div>}
    </>
  )
})

/**
 * Render the PDF pages of the open book.
 * @param props - position, zoom, loaders, and navigation callbacks.
 * @returns the scrolling page column.
 */
export function PdfView({
  sectionCount, position, reveal, zoom, speaking, sentence, section, renderPage, pageSize, goTo, settle, t,
}: PdfViewProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [visible, setVisible] = useState<ReadonlySet<number>>(() => new Set())
  const [texts, setTexts] = useState<ReadonlyMap<number, PdfSection>>(() => new Map())
  const observer = useRef<IntersectionObserver | undefined>(undefined)
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const baseWidth = pageSize(0)?.width ?? 612
  const scale = width > 0 ? Math.max(0.1, (width - PAGE_GUTTER) / baseWidth) * zoom : 0

  const loadText = useCallback(async (index: number): Promise<PdfSection | undefined> => {
    const loaded = await section(index)
    if (loaded.kind !== 'pdf') return undefined
    setTexts(previous => previous.get(index) === loaded ? previous : new Map(previous).set(index, loaded))
    return loaded
  }, [section])

  useEffect(() => {
    const element = scroller.current
    /* v8 ignore next -- the scroller renders unconditionally. */
    if (element === null) return
    const resize = new ResizeObserver(() => { setWidth(element.clientWidth) })
    resize.observe(element)
    setWidth(element.clientWidth)
    const intersection = new IntersectionObserver((entries) => {
      setVisible((previous) => {
        const next = new Set(previous)
        for (const entry of entries) {
          const page = Number((entry.target as HTMLElement).dataset.page)
          if (entry.isIntersecting) next.add(page)
          else next.delete(page)
        }
        return next
      })
    }, { root: element, rootMargin: '100% 0px' })
    // Pages render once the width is known, after this effect; each registers through `registerPage`.
    observer.current = intersection
    return () => {
      resize.disconnect()
      intersection.disconnect()
      observer.current = undefined
    }
  }, [])

  // Text of the pages near the viewport and of the page being read.
  useEffect(() => {
    for (const page of [...visible, position.section]) {
      if (!texts.has(page)) void loadText(page).catch(() => undefined)
    }
  }, [visible, position.section, texts, loadText])

  const pageElement = (index: number): HTMLElement | null =>
    scroller.current?.querySelector<HTMLElement>(`[data-page="${String(index)}"]`) ?? null

  // Reveal: scroll the position's line into view when it is outside the viewport.
  useEffect(() => {
    if (scale === 0) return
    let cancelled = false
    const target = position.section
    const scrollTo = (text: PdfSection | undefined): void => {
      const element = scroller.current
      const page = pageElement(target)
      if (cancelled || element === null || page === null) return
      const line = text === undefined ? undefined : text.lines[lineAt(text.lines, position.offset)]
      const top = page.offsetTop + (line === undefined ? 0 : line.box.top * scale)
      const height = line === undefined ? 0 : line.box.height * scale
      const viewTop = element.scrollTop
      const viewBottom = viewTop + element.clientHeight
      if (top >= viewTop + 8 && top + height <= viewBottom - 8) return
      const destination = Math.max(0, top - element.clientHeight * 0.3)
      element.scrollTo({ top: destination, behavior: Math.abs(destination - viewTop) < element.clientHeight * 2 ? 'smooth' : 'auto' })
    }
    loadText(target).then(scrollTo, () => { scrollTo(undefined) })
    return () => { cancelled = true }
    // Revealing follows the reveal counter and scale changes, not every position update.
  }, [reveal, scale])

  const onScroll = (): void => {
    if (settleTimer.current !== undefined) clearTimeout(settleTimer.current)
    settleTimer.current = setTimeout(() => {
      const element = scroller.current
      if (speaking || element === null || scale === 0) return
      const viewTop = element.scrollTop
      const viewBottom = viewTop + element.clientHeight
      const current = pageElement(position.section)
      const currentText = texts.get(position.section)
      const currentLine = currentText?.lines[lineAt(currentText.lines, position.offset)]
      if (current !== null && currentLine !== undefined) {
        const top = current.offsetTop + currentLine.box.top * scale
        if (top >= viewTop && top <= viewBottom) return
      }
      let page = 0
      let pageTop = 0
      for (const candidate of element.querySelectorAll<HTMLElement>('[data-page]')) {
        if (candidate.offsetTop + candidate.offsetHeight > viewTop) {
          page = Number(candidate.dataset.page)
          pageTop = candidate.offsetTop
          break
        }
      }
      void loadText(page).then((text) => {
        const first = text?.lines.find(line => pageTop + line.box.top * scale >= viewTop)
        settle({ section: page, offset: first?.start ?? 0 })
      }, () => { settle({ section: page, offset: 0 }) })
    }, SETTLE_DELAY_MS)
  }
  useEffect(() => () => { if (settleTimer.current !== undefined) clearTimeout(settleTimer.current) }, [])

  const step = async (delta: 1 | -1): Promise<void> => {
    let page = position.section
    const text = await loadText(page)
    let target = text?.lines[lineAt(text.lines, position.offset) + delta]
    while (target === undefined) {
      page += delta
      if (page < 0 || page >= sectionCount) return
      const lines = (await loadText(page))?.lines
      target = delta > 0 ? lines?.[0] : lines?.at(-1)
    }
    goTo({ section: page, offset: target.start })
  }

  // A page that fails to load leaves the position where it is.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'j') {
      event.preventDefault()
      void step(1).catch(() => undefined)
    } else if (event.key === 'ArrowUp' || event.key === 'k') {
      event.preventDefault()
      void step(-1).catch(() => undefined)
    }
  }

  const onPageClick = (index: number, event: MouseEvent<HTMLDivElement>): void => {
    const text = texts.get(index)
    if (text === undefined || scale === 0) return
    const box = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - box.left) / scale
    const y = (event.clientY - box.top) / scale
    const hits = text.lines.filter(line => y >= line.box.top - 2 && y <= line.box.top + line.box.height + 2)
    const hit = hits.find(line => x >= line.box.left - 8 && x <= line.box.left + line.box.width + 8) ?? hits[0]
    if (hit !== undefined) goTo({ section: index, offset: hit.start })
  }

  const registerPage = useCallback((element: HTMLDivElement | null): void => {
    if (element !== null) observer.current?.observe(element)
  }, [])

  const activeText = texts.get(position.section)
  const highlight = useMemo(() => {
    if (activeText === undefined) return NO_BOXES
    if (sentence !== undefined) return spanBoxes(activeText.lines, sentence)
    const line = activeText.lines[lineAt(activeText.lines, position.offset)]
    return line === undefined ? NO_BOXES : [line.box]
  }, [activeText, sentence, position.offset])
  const pages = Array.from({ length: sectionCount }, (_, index) => index)
  return (
    <div
      ref={scroller}
      className={css.scroller}
      tabIndex={0}
      data-testid="pdf-view"
      onScroll={onScroll}
      onKeyDown={onKeyDown}
    >
      {scale > 0 && pages.map((index) => {
        const size = pageSize(index) ?? { width: baseWidth, height: baseWidth * 1.3 }
        return (
          <div
            key={index}
            ref={registerPage}
            data-page={index}
            className={css.page}
            style={{ width: size.width * scale, height: size.height * scale }}
            onClick={(event) => { onPageClick(index, event) }}
          >
            {visible.has(index)
              ? (
                <PdfPage
                  index={index}
                  scale={scale}
                  size={size}
                  text={texts.get(index)}
                  highlight={index === position.section ? highlight : NO_BOXES}
                  renderPage={renderPage}
                  noText={t('reader.noText')}
                />
              )
              : <span className={css.pageNumber}>{index + 1}</span>}
          </div>
        )
      })}
    </div>
  )
}

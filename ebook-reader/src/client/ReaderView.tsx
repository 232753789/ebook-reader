/**
 * The reader main view: the toolbar (contents, navigation, zoom, progress, and read-aloud
 * controls), the contents panel, and the PDF or EPUB view of the open book.
 */
import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import {
  IconChevronLeftOutline14, IconChevronRightOutline14, IconLoadingOutline16, IconPanelLeftOutline16,
  IconPauseOutline16, IconPlayOutline16, IconStopFill16, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReadingPosition } from '../types.ts'
import type { ReaderViewProps } from './contract.ts'
import { EpubView } from './EpubView.tsx'
import { STYLE_LABELS, VOICE_LABELS } from './locales.ts'
import { PdfView } from './PdfView.tsx'
import { FONT_SCALES, PDF_ZOOMS, PLAYBACK_RATES } from './stores.ts'
import css from './ReaderView.module.css'

/** The option next to `current` in an ascending list, or undefined past the list's end. */
function adjacentOption(options: readonly number[], current: number, delta: 1 | -1): number | undefined {
  return delta > 0 ? options.find(option => option > current) : options.findLast(option => option < current)
}

/**
 * Render the reader view.
 * @param props - reader, speech, library, and capability sources, preferences, and callbacks.
 * @returns the view element.
 */
export function ReaderView(props: ReaderViewProps) {
  const {
    useReader, useSpeech, useLibrary, useCapabilities, useStore, actions,
    ensureLoaded, open, retry, section, renderPage, pageSize, goTo, goToTarget, followLink, settle,
    play, pause, resume, stop, setRate, t,
  } = props
  const reader = useReader(state => state)
  const speech = useSpeech(state => state)
  const capabilities = useCapabilities(state => state)
  const prefs = useStore(state => state)
  const recent = useLibrary((state) => {
    const books = state.status === 'idle' ? [] : state.list?.books ?? []
    let latest: (typeof books)[number] | undefined
    for (const book of books) {
      if (book.progress === undefined) continue
      if (latest?.progress === undefined || book.progress.updatedAt > latest.progress.updatedAt) latest = book
    }
    return latest
  })
  const [pageDraft, setPageDraft] = useState<string | undefined>(undefined)

  useEffect(() => { ensureLoaded() }, [ensureLoaded])
  useEffect(() => { setRate(prefs.rate) }, [prefs.rate, setRate])

  const speechCaps = capabilities?.speech.enabled === true ? capabilities.speech : undefined
  const voice = speechCaps === undefined
    ? undefined
    : prefs.voice !== null && speechCaps.voices.some(candidate => candidate.id === prefs.voice) ? prefs.voice : speechCaps.defaultVoice
  const speaking = speech.status === 'buffering' || speech.status === 'playing' || speech.status === 'paused'

  // Element-id offsets of the section being read, for contents rows that point inside it.
  const readingSection = reader.kind === 'ready' ? reader.position.section : undefined
  const [anchors, setAnchors] = useState<{ section: number; offsets: Readonly<Record<string, number>> } | undefined>()
  useEffect(() => {
    if (readingSection === undefined) return
    let cancelled = false
    section(readingSection).then(
      (loaded) => { if (!cancelled) setAnchors({ section: readingSection, offsets: loaded.kind === 'epub' ? loaded.anchors : {} }) },
      // A section that fails to load shows its error in the book view; the label keeps its section-level answer.
      () => undefined,
    )
    return () => { cancelled = true }
  }, [readingSection, section])

  // The contents row being read: the last row starting at or before the position.
  const currentEntry = useMemo(() => {
    if (reader.kind !== 'ready') return undefined
    const { position } = reader
    let current: number | undefined
    reader.toc.forEach((entry, index) => {
      if (entry.section > position.section) return
      if (entry.section === position.section && entry.fragment !== undefined) {
        const offset = anchors?.section === position.section ? anchors?.offsets[entry.fragment] : undefined
        if (offset === undefined || offset > position.offset) return
      }
      current = index
    })
    return current
  }, [reader, anchors])
  const chapterLabel = currentEntry === undefined || reader.kind !== 'ready' ? undefined : reader.toc[currentEntry]?.label

  if (reader.kind === 'empty') {
    return (
      <div className={css.placeholder}>
        <p>{t('reader.empty')}</p>
        {recent !== undefined && (
          <button type="button" className={css.primary} onClick={() => { open(recent.id) }}>
            {t('reader.continue', { title: recent.title })}
          </button>
        )}
      </div>
    )
  }
  if (reader.kind === 'loading') {
    return (
      <div className={css.placeholder} role="status">
        <IconLoadingOutline16 className={css.spin} />
        <p>{t('reader.loading', { title: reader.book.title })}</p>
      </div>
    )
  }
  if (reader.kind === 'error') {
    return (
      <div className={css.placeholder} role="alert">
        <p>{t('reader.error', { title: reader.book.title, message: reader.message })}</p>
        <button type="button" className={css.primary} onClick={() => { retry() }}>{t('reader.retry')}</button>
      </div>
    )
  }

  const { position, sectionCount, format } = reader
  // The category is remembered per book, so opening another book reads it with its own category.
  const bookId = reader.book.id
  const saved = prefs.styles[bookId]
  const style = speechCaps === undefined
    ? undefined
    : saved !== undefined && speechCaps.styles.some(candidate => candidate.id === saved) ? saved : speechCaps.defaultStyle
  const isPdf = format === 'pdf'
  // The buttons are disabled at the first and last section.
  const moveSection = (delta: 1 | -1): void => { goTo({ section: position.section + delta, offset: 0 }) }
  const submitPage = (): void => {
    const page = Number(pageDraft)
    setPageDraft(undefined)
    if (Number.isInteger(page) && page >= 1 && page <= sectionCount) goTo({ section: page - 1, offset: 0 })
  }
  const choose = (next: string): void => {
    actions.setVoice(next)
    if (speaking && style !== undefined) play(next, style)
  }
  const chooseStyle = (current: string, next: string): void => {
    actions.setStyle(bookId, next)
    // The instruction is part of the cache key, so a category change re-reads from this sentence.
    if (speaking) play(current, next)
  }
  const zoom = isPdf ? prefs.pdfZoom : prefs.fontScale
  const setZoom = (value: number): void => {
    if (isPdf) actions.setPdfZoom(value)
    else actions.setFontScale(value)
  }
  const zoomOptions: readonly number[] = isPdf ? PDF_ZOOMS : FONT_SCALES
  const smaller = adjacentOption(zoomOptions, zoom, -1)
  const larger = adjacentOption(zoomOptions, zoom, 1)
  const jump = (target: ReadingPosition): void => { goTo(target) }

  return (
    <div className={css.view}>
      <header className={css.toolbar}>
        <Tooltip label={t('reader.toc')} delayMs={500}>
          <button
            type="button"
            className={clsx(css.icon, prefs.tocOpen && css.pressed)}
            aria-label={t('reader.toc')}
            aria-pressed={prefs.tocOpen}
            onClick={() => { actions.toggleToc() }}
          >
            <IconPanelLeftOutline16 />
          </button>
        </Tooltip>
        <div className={css.heading}>
          <span className={css.title} title={reader.title}>{reader.title}</span>
          {chapterLabel !== undefined && <span className={css.chapter} title={chapterLabel}>{chapterLabel}</span>}
        </div>
        <div className={css.group}>
          <button
            type="button"
            className={css.icon}
            aria-label={isPdf ? t('reader.previousPage') : t('reader.previousChapter')}
            disabled={position.section === 0}
            onClick={() => { moveSection(-1) }}
          >
            <IconChevronLeftOutline14 />
          </button>
          {isPdf
            ? (
              <span className={css.counter}>
                <input
                  className={css.pageInput}
                  inputMode="numeric"
                  aria-label={t('reader.pageInput')}
                  value={pageDraft ?? String(position.section + 1)}
                  onChange={(event) => { setPageDraft(event.target.value) }}
                  onBlur={submitPage}
                  onKeyDown={(event) => { if (event.key === 'Enter') submitPage() }}
                />
                <span>/ {sectionCount}</span>
              </span>
            )
            : <span className={css.counter}>{t('reader.chapter', { current: position.section + 1, total: sectionCount })}</span>}
          <button
            type="button"
            className={css.icon}
            aria-label={isPdf ? t('reader.nextPage') : t('reader.nextChapter')}
            disabled={position.section + 1 >= sectionCount}
            onClick={() => { moveSection(1) }}
          >
            <IconChevronRightOutline14 />
          </button>
        </div>
        <div className={css.group}>
          <button
            type="button"
            className={css.textButton}
            aria-label={isPdf ? t('reader.zoomOut') : t('reader.fontSmaller')}
            disabled={smaller === undefined}
            onClick={smaller === undefined ? undefined : () => { setZoom(smaller) }}
          >
            {isPdf ? '−' : 'A−'}
          </button>
          <span className={css.zoom}>{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            className={css.textButton}
            aria-label={isPdf ? t('reader.zoomIn') : t('reader.fontLarger')}
            disabled={larger === undefined}
            onClick={larger === undefined ? undefined : () => { setZoom(larger) }}
          >
            {isPdf ? '+' : 'A+'}
          </button>
        </div>
        <span className={css.percent} aria-label={t('reader.percent', { percent: Math.round(reader.fraction * 100) })}>
          {t('reader.percent', { percent: Math.round(reader.fraction * 100) })}
        </span>
        <div className={clsx(css.group, css.speech)}>
          {speechCaps === undefined || voice === undefined || style === undefined
            ? (
              <Tooltip label={t('speech.disabled')} delayMs={200}>
                <button type="button" className={css.icon} aria-label={t('speech.disabled')} disabled>
                  <IconPlayOutline16 />
                </button>
              </Tooltip>
            )
            : (
              <>
                <select
                  className={css.select}
                  aria-label={t('speech.voice')}
                  value={voice}
                  onChange={(event) => { choose(event.target.value) }}
                >
                  {speechCaps.voices.map((candidate) => {
                    const key = VOICE_LABELS[candidate.id]
                    return <option key={candidate.id} value={candidate.id}>{key === undefined ? candidate.id : t(key)}</option>
                  })}
                </select>
                <select
                  className={css.select}
                  aria-label={t('speech.style')}
                  value={style}
                  onChange={(event) => { chooseStyle(voice, event.target.value) }}
                >
                  {speechCaps.styles.map((candidate) => {
                    const key = STYLE_LABELS[candidate.id]
                    return <option key={candidate.id} value={candidate.id}>{key === undefined ? candidate.id : t(key)}</option>
                  })}
                </select>
                <select
                  className={css.select}
                  aria-label={t('speech.rate')}
                  value={String(prefs.rate)}
                  onChange={(event) => { actions.setRate(Number(event.target.value)) }}
                >
                  {PLAYBACK_RATES.map(rate => (
                    <option key={rate} value={String(rate)}>{t('speech.rateValue', { rate })}</option>
                  ))}
                </select>
                {speech.status === 'playing'
                  ? (
                    <button type="button" className={clsx(css.icon, css.accent)} aria-label={t('speech.pause')} onClick={() => { pause() }}>
                      <IconPauseOutline16 />
                    </button>
                  )
                  : speech.status === 'paused'
                    ? (
                      <button type="button" className={clsx(css.icon, css.accent)} aria-label={t('speech.resume')} onClick={() => { resume() }}>
                        <IconPlayOutline16 />
                      </button>
                    )
                    : (
                      <button
                        type="button"
                        className={clsx(css.icon, css.accent)}
                        aria-label={t('speech.play')}
                        disabled={speech.status === 'buffering'}
                        onClick={() => { play(voice, style) }}
                      >
                        {speech.status === 'buffering' ? <IconLoadingOutline16 className={css.spin} /> : <IconPlayOutline16 />}
                      </button>
                    )}
                <button type="button" className={css.icon} aria-label={t('speech.stop')} disabled={!speaking} onClick={() => { stop() }}>
                  <IconStopFill16 />
                </button>
              </>
            )}
        </div>
      </header>
      {(speech.status === 'buffering' || speech.status === 'error') && (
        <div className={clsx(css.banner, speech.status === 'error' && css.bannerError)} role={speech.status === 'error' ? 'alert' : 'status'}>
          {speech.status === 'error' ? t('speech.error', { message: speech.message ?? '' }) : t('speech.buffering')}
        </div>
      )}
      <div className={css.body}>
        {prefs.tocOpen && (
          <nav className={css.toc} aria-label={t('reader.toc')}>
            {reader.toc.length === 0
              ? <p className={css.tocEmpty}>{t('reader.tocEmpty')}</p>
              : (
                <ul>
                  {reader.toc.map((entry, index) => (
                    <li key={`${String(index)}-${entry.label}`}>
                      <button
                        type="button"
                        className={clsx(css.tocItem, index === currentEntry && css.tocCurrent)}
                        aria-current={index === currentEntry ? 'location' : undefined}
                        style={{ paddingLeft: 12 + entry.depth * 14 }}
                        onClick={() => { goToTarget(entry.section, entry.fragment) }}
                      >
                        {entry.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
          </nav>
        )}
        <div className={css.content}>
          {isPdf
            ? (
              <PdfView
                key={reader.book.id}
                sectionCount={sectionCount}
                position={position}
                reveal={reader.reveal}
                zoom={prefs.pdfZoom}
                speaking={speaking}
                sentence={speaking ? reader.sentence : undefined}
                section={section}
                renderPage={renderPage}
                pageSize={pageSize}
                goTo={jump}
                settle={settle}
                t={t}
              />
            )
            : (
              <EpubView
                key={reader.book.id}
                sectionCount={sectionCount}
                position={position}
                reveal={reader.reveal}
                fontScale={prefs.fontScale}
                speaking={speaking}
                sentence={speaking ? reader.sentence : undefined}
                section={section}
                goTo={jump}
                settle={settle}
                followLink={followLink}
                t={t}
              />
            )}
        </div>
      </div>
    </div>
  )
}

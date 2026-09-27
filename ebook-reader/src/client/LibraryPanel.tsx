/**
 * The library sidebar tab: search, refresh, and one row per book with its format, folder, and
 * reading progress. Clicking a row opens the book in the reader view.
 */
import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { IconLoadingOutline16, IconRefreshOutline16, IconSearchOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BookEntry } from '../types.ts'
import type { LibraryPanelProps } from './contract.ts'
import css from './LibraryPanel.module.css'

function folderOf(book: BookEntry): string {
  const slash = book.path.lastIndexOf('/')
  return slash === -1 ? '' : book.path.slice(0, slash)
}

/**
 * Render the library tab.
 * @param props - injected library and reader state, callbacks, and the locale seat.
 * @returns the panel element.
 */
export function LibraryPanel({ useLibrary, useReader, ensureLoaded, refresh, open, t }: LibraryPanelProps) {
  const library = useLibrary(state => state)
  const openId = useReader(state => state.kind === 'empty' ? undefined : state.book.id)
  const [query, setQuery] = useState('')
  useEffect(() => { ensureLoaded() }, [ensureLoaded])

  const list = library.status === 'idle' ? undefined : library.list
  const books = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const all = list?.books ?? []
    return needle === '' ? all : all.filter(book => book.path.toLowerCase().includes(needle))
  }, [list, query])
  const loading = library.status === 'loading' || library.status === 'idle'

  return (
    <div className={css.panel}>
      <div className={css.toolbar}>
        <label className={css.search}>
          <IconSearchOutline16 size={14} />
          <input
            className={css.searchInput}
            type="search"
            value={query}
            placeholder={t('library.search')}
            aria-label={t('library.search')}
            onChange={(event) => { setQuery(event.target.value) }}
          />
        </label>
        <Tooltip label={t('library.refresh')} delayMs={500}>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('library.refresh')}
            disabled={library.status === 'loading'}
            onClick={() => { refresh() }}
          >
            {library.status === 'loading' ? <IconLoadingOutline16 className={css.spin} /> : <IconRefreshOutline16 />}
          </button>
        </Tooltip>
      </div>
      {list !== undefined && <div className={css.root} title={list.root}>{list.root}</div>}
      {library.status === 'error' && (
        <div className={css.notice} role="alert">
          <span>{t('library.error', { message: library.message })}</span>
          <button type="button" className={css.link} onClick={() => { refresh() }}>{t('library.retry')}</button>
        </div>
      )}
      <ul className={css.list} aria-label={t('tab.label')} aria-busy={loading}>
        {books.map((book) => {
          const percent = book.progress === undefined ? undefined : Math.round(book.progress.fraction * 100)
          const folder = folderOf(book)
          return (
            <li key={book.id}>
              <button
                type="button"
                className={clsx(css.row, book.id === openId && css.selected)}
                aria-current={book.id === openId ? 'true' : undefined}
                onClick={() => { open(book.id) }}
              >
                <span className={clsx(css.badge, css[book.format])}>{book.format.toUpperCase()}</span>
                <span className={css.text}>
                  <span className={css.title}>{book.title}</span>
                  <span className={css.meta}>
                    {folder !== '' && <span className={css.folder}>{folder}</span>}
                    <span>{percent === undefined ? t('library.unread') : t('library.progress', { percent })}</span>
                  </span>
                  {percent !== undefined && (
                    <span className={css.bar} aria-hidden="true"><span style={{ width: `${String(percent)}%` }} /></span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {loading && list === undefined && <div className={css.hint}>{t('library.loading')}</div>}
      {list !== undefined && list.books.length === 0 && (
        <div className={css.hint}>
          <p>{t('library.empty')}</p>
          <p>{t('library.emptyHint', { root: list.root })}</p>
        </div>
      )}
      {list !== undefined && list.books.length > 0 && books.length === 0 && <div className={css.hint}>{t('library.noMatch')}</div>}
      {list?.truncated === true && <div className={css.hint}>{t('library.truncated', { count: list.books.length })}</div>}
    </div>
  )
}

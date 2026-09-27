// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LibraryState } from '../src/client/library-controller.ts'
import { LibraryPanel } from '../src/client/LibraryPanel.tsx'
import { Observable } from '../src/client/observable.ts'
import type { ReaderState } from '../src/client/reader-controller.ts'
import { EPUB_BOOK, EPUB_ID, hookOf, LIST, PDF_ID, t } from './reader-fixtures.client.ts'

afterEach(cleanup)

function mount(initial: LibraryState, reader: ReaderState = { kind: 'empty' }) {
  const library = new Observable<LibraryState>(initial)
  const readerState = new Observable<ReaderState>(reader)
  const callbacks = { ensureLoaded: vi.fn(), refresh: vi.fn(), open: vi.fn() }
  render(
    <LibraryPanel
      useLibrary={hookOf(library)}
      useReader={hookOf(readerState)}
      useSessions={undefined as never}
      useWorkspaces={undefined as never}
      {...callbacks}
      t={t}
    />,
  )
  return { library, readerState, ...callbacks }
}

describe('library tab', () => {
  it('asks for the listing on mount and shows the scan in progress', () => {
    const { ensureLoaded } = mount({ status: 'idle' })
    expect(ensureLoaded).toHaveBeenCalledOnce()
    expect(screen.getByText('正在扫描书库…')).toBeTruthy()
    expect(screen.getByRole('list', { name: '书库' }).getAttribute('aria-busy')).toBe('true')
  })

  it('lists each book with its format, folder, and progress, and opens a clicked book', () => {
    const { open } = mount({ status: 'ready', list: LIST }, { kind: 'loading', book: EPUB_BOOK })
    expect(screen.getByTitle(LIST.root).textContent).toBe(LIST.root)
    const rows = screen.getAllByRole('button').filter(button => button.closest('li') !== null)
    expect(rows.map(row => row.textContent)).toEqual(['PDF机器学习技术未读', 'EPUB围城已读 43%'])
    expect(rows[1]!.getAttribute('aria-current')).toBe('true')
    expect(rows[0]!.getAttribute('aria-current')).toBeNull()
    fireEvent.click(rows[0]!)
    expect(open).toHaveBeenCalledWith(PDF_ID)
  })

  it('filters by path and says when nothing matches', () => {
    mount({ status: 'ready', list: LIST })
    const search = screen.getByRole('searchbox', { name: '搜索书名' })
    fireEvent.change(search, { target: { value: '技术' } })
    expect(within(screen.getByRole('list')).getAllByRole('button')).toHaveLength(1)
    fireEvent.change(search, { target: { value: '不存在的书' } })
    expect(screen.getByText('没有匹配的书。')).toBeTruthy()
  })

  it('explains an empty library and a truncated listing', () => {
    const { library } = mount({ status: 'ready', list: { ...LIST, books: [] } })
    expect(screen.getByText('书库中还没有 PDF 或 EPUB 文件。')).toBeTruthy()
    expect(screen.getByText(`把电子书放进 ${LIST.root} 后点击刷新。`)).toBeTruthy()
    act(() => { library.set({ status: 'ready', list: { ...LIST, truncated: true } }) })
    expect(screen.getByText('只列出前 2 本书。')).toBeTruthy()
  })

  it('refreshes on request, disables refresh while scanning, and offers a retry after a failure', () => {
    const { library, refresh, readerState } = mount({ status: 'loading', list: LIST })
    const button = screen.getByRole('button', { name: '刷新书库' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    act(() => { library.set({ status: 'error', message: '权限不足', list: LIST }) })
    expect(screen.getByRole('alert').textContent).toContain('读取书库失败：权限不足')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    fireEvent.click(screen.getByRole('button', { name: '刷新书库' }))
    expect(refresh).toHaveBeenCalledTimes(2)
    act(() => { readerState.set({ kind: 'error', book: { ...EPUB_BOOK }, message: 'x' }) })
    expect(screen.getByRole('button', { current: true }).textContent).toContain('围城')
    expect(EPUB_ID).toBe(EPUB_BOOK.id)
  })

  it('shows only the failure when the first scan fails', () => {
    mount({ status: 'error', message: '目录不可读' })
    expect(screen.getByRole('alert').textContent).toContain('目录不可读')
    expect(screen.queryByTitle(LIST.root)).toBeNull()
  })
})

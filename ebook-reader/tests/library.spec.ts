import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bookIdForPath, isBookId, scanLibrary } from '../src/library.ts'
import { tempRoot } from './fixtures.ts'

async function library(): Promise<string> {
  const root = await tempRoot('ebook-library-')
  await mkdir(join(root, '历史', '近代'), { recursive: true })
  await mkdir(join(root, '.hidden'))
  await writeFile(join(root, '三体.epub'), 'epub-bytes')
  await writeFile(join(root, '历史', '近代', '中国近代史.PDF'), 'pdf')
  await writeFile(join(root, '历史', 'notes.txt'), 'ignored')
  await writeFile(join(root, '.hidden', 'secret.pdf'), 'ignored')
  await writeFile(join(root, '.draft.epub'), 'ignored')
  return root
}

describe('library scanning', () => {
  it('lists PDF and EPUB files recursively, sorted by Chinese collation of the path, with stable ids', async () => {
    const root = await library()
    const scan = await scanLibrary(root, 10)
    expect(scan.truncated).toBe(false)
    expect(scan.files.map(file => ({ path: file.path, title: file.title, format: file.format, size: file.size }))).toEqual([
      { path: '历史/近代/中国近代史.PDF', title: '中国近代史', format: 'pdf', size: 3 },
      { path: '三体.epub', title: '三体', format: 'epub', size: 10 },
    ])
    expect(scan.files[0]!.absolutePath).toBe(join(root, '历史', '近代', '中国近代史.PDF'))
    expect(scan.files[1]!.id).toBe(bookIdForPath('三体.epub'))
    expect(isBookId(scan.files[1]!.id)).toBe(true)
    expect(Number.isFinite(Date.parse(scan.files[1]!.modifiedAt))).toBe(true)
  })

  it('skips symbolic links so a link cannot pull files from outside the library', async () => {
    const root = await library()
    const outside = await tempRoot('ebook-outside-')
    await writeFile(join(outside, 'elsewhere.pdf'), 'pdf')
    await symlink(outside, join(root, 'linked-directory'))
    await symlink(join(outside, 'elsewhere.pdf'), join(root, 'linked.pdf'))
    const scan = await scanLibrary(root, 10)
    expect(scan.files.map(file => file.path)).toEqual(['历史/近代/中国近代史.PDF', '三体.epub'])
  })

  it('truncates after sorting and reports it', async () => {
    const root = await library()
    const scan = await scanLibrary(root, 1)
    expect(scan.files.map(file => file.path)).toEqual(['历史/近代/中国近代史.PDF'])
    expect(scan.truncated).toBe(true)
  })

  it('lists nothing for a missing library directory and fails for a file in its place', async () => {
    const root = await tempRoot('ebook-library-')
    await expect(scanLibrary(join(root, 'absent'), 10)).resolves.toEqual({ files: [], truncated: false })
    await writeFile(join(root, 'file'), '')
    await expect(scanLibrary(join(root, 'file'), 10)).rejects.toThrow()
  })

  it('recognizes only the book id wire form', () => {
    expect(isBookId(bookIdForPath('a.pdf'))).toBe(true)
    expect(isBookId('book-123')).toBe(false)
    expect(isBookId('../etc/passwd')).toBe(false)
    expect(bookIdForPath('a.pdf')).not.toBe(bookIdForPath('b.pdf'))
  })
})

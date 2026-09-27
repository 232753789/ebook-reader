/** Library directory scanning and stable book identity. */

import { createHash } from 'node:crypto'
import type { Dirent, Stats } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'
import type { BookFormat, BookId } from './types.ts'

const BOOK_ID_PATTERN = /^book-[0-9a-f]{32}$/

/** One book file found under the library directory. */
export interface LibraryFile {
  readonly id: BookId
  readonly format: BookFormat
  /** Absolute file path. */
  readonly absolutePath: string
  /** Path relative to the library directory, with `/` separators. */
  readonly path: string
  readonly title: string
  readonly size: number
  readonly modifiedAt: string
}

/** Result of one library scan. */
export interface LibraryScan {
  readonly files: readonly LibraryFile[]
  readonly truncated: boolean
}

/**
 * Whether a wire value has the shape of a book id.
 * @param value - untrusted route segment.
 * @returns true when the value can name a book.
 */
export function isBookId(value: string): value is BookId {
  return BOOK_ID_PATTERN.test(value)
}

/**
 * Derive a book's id from its library-relative path, so progress follows the file path.
 * @param path - `/`-separated path relative to the library directory.
 * @returns the stable book id.
 */
export function bookIdForPath(path: string): BookId {
  return `book-${createHash('sha256').update(path, 'utf8').digest('hex').slice(0, 32)}` as BookId
}

function formatOf(name: string): BookFormat | undefined {
  const extension = extname(name).toLowerCase()
  if (extension === '.pdf') return 'pdf'
  if (extension === '.epub') return 'epub'
  return undefined
}

async function entries(directory: string): Promise<Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true })
  } catch (error) {
    // An unreadable subdirectory is skipped; only the root's absence is a listing error.
    if ((error as NodeJS.ErrnoException).code === 'EACCES') return []
    throw error
  }
}

/**
 * Walk the library directory for PDF and EPUB files.
 *
 * Hidden entries and symbolic links are skipped, so a link cannot pull files from outside the
 * library into the listing or loop the walk. A missing library directory lists no books.
 * @param root - absolute library directory.
 * @param limit - most files to return; files are sorted by path before truncation.
 * @returns the files and whether more existed.
 */
export async function scanLibrary(root: string, limit: number): Promise<LibraryScan> {
  const found: { absolutePath: string; path: string; format: BookFormat }[] = []
  const pending = [root]
  try {
    await stat(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { files: [], truncated: false }
    throw error
  }
  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    for (const entry of await entries(directory)) {
      if (entry.name.startsWith('.')) continue
      const absolutePath = join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(absolutePath)
        continue
      }
      if (!entry.isFile()) continue
      const format = formatOf(entry.name)
      if (format === undefined) continue
      found.push({ absolutePath, path: relative(root, absolutePath).split(sep).join('/'), format })
    }
  }
  found.sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'))
  const kept = found.slice(0, limit)
  const files = await Promise.all(kept.map(async (file): Promise<LibraryFile | undefined> => {
    let info: Stats
    try {
      info = await stat(file.absolutePath)
    } catch (error) {
      // A file removed between the directory read and this stat is simply no longer listed.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const name = file.path.slice(file.path.lastIndexOf('/') + 1)
    return {
      id: bookIdForPath(file.path),
      format: file.format,
      absolutePath: file.absolutePath,
      path: file.path,
      title: name.slice(0, name.length - extname(name).length),
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
    }
  }))
  return { files: files.filter(file => file !== undefined), truncated: found.length > limit }
}

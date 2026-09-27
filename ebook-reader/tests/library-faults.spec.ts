import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tempRoot } from './fixtures.ts'

/** Paths whose next `readdir` or `stat` fails with the mapped errno code. */
const faults = new Map<string, string>()

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const fail = (path: unknown): void => {
    const code = faults.get(String(path))
    if (code !== undefined) throw Object.assign(new Error(`${code}: ${String(path)}`), { code })
  }
  return {
    ...actual,
    readdir: (async (path: string, options: object) => {
      fail(path)
      return actual.readdir(path, options as never)
    }) as typeof actual.readdir,
    stat: (async (path: string) => {
      fail(path)
      return actual.stat(path)
    }) as typeof actual.stat,
  }
})

const { scanLibrary } = await import('../src/library.ts')

afterEach(() => { faults.clear() })

describe('library scanning under filesystem faults', () => {
  it('skips an unreadable subdirectory', async () => {
    const root = await tempRoot('ebook-faults-')
    await mkdir(join(root, 'locked'))
    await writeFile(join(root, 'locked', 'hidden.pdf'), '')
    await writeFile(join(root, 'open.pdf'), '')
    faults.set(join(root, 'locked'), 'EACCES')
    expect((await scanLibrary(root, 10)).files.map(file => file.path)).toEqual(['open.pdf'])
  })

  it('drops a file removed between the directory read and its stat', async () => {
    const root = await tempRoot('ebook-faults-')
    await writeFile(join(root, 'gone.pdf'), '')
    await writeFile(join(root, 'kept.epub'), '')
    faults.set(join(root, 'gone.pdf'), 'ENOENT')
    expect((await scanLibrary(root, 10)).files.map(file => file.path)).toEqual(['kept.epub'])
  })

  it('fails on other errors of the root, a directory, or a file', async () => {
    const root = await tempRoot('ebook-faults-')
    await mkdir(join(root, 'broken'))
    await writeFile(join(root, 'bad.pdf'), '')
    faults.set(root, 'EACCES')
    await expect(scanLibrary(root, 10)).rejects.toThrow('EACCES')
    faults.clear()
    faults.set(join(root, 'broken'), 'EIO')
    await expect(scanLibrary(root, 10)).rejects.toThrow('EIO')
    faults.clear()
    faults.set(join(root, 'bad.pdf'), 'EIO')
    await expect(scanLibrary(root, 10)).rejects.toThrow('EIO')
  })
})

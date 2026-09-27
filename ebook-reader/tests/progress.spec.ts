import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bookIdForPath } from '../src/library.ts'
import { parsePosition, parseProgressUpdate, ProgressStore } from '../src/progress.ts'
import { tempRoot } from './fixtures.ts'

const BOOK = bookIdForPath('三体.epub')

describe('reading progress', () => {
  it('validates positions and updates from untrusted JSON', () => {
    expect(parsePosition({ section: 3, offset: 120 })).toEqual({ section: 3, offset: 120 })
    expect(parsePosition({ section: -1, offset: 0 })).toBeUndefined()
    expect(parsePosition({ section: 1.5, offset: 0 })).toBeUndefined()
    expect(parsePosition(null)).toBeUndefined()
    expect(parsePosition([1, 2])).toBeUndefined()
    expect(parseProgressUpdate({ position: { section: 0, offset: 0 }, fraction: 0.25 }))
      .toEqual({ position: { section: 0, offset: 0 }, fraction: 0.25 })
    expect(parseProgressUpdate({ position: { section: 0, offset: 0 }, fraction: 1.5 })).toBeUndefined()
    expect(parseProgressUpdate({ position: { section: 0, offset: 0 }, fraction: Number.NaN })).toBeUndefined()
    expect(parseProgressUpdate({ position: { section: 0 }, fraction: 0 })).toBeUndefined()
    expect(parseProgressUpdate('progress')).toBeUndefined()
  })

  it('stores one private record per book and reads it back', async () => {
    const root = await tempRoot('ebook-progress-')
    const store = new ProgressStore(root)
    expect(await store.read(BOOK)).toBeUndefined()
    const saved = await store.write(BOOK, '三体.epub', { position: { section: 2, offset: 40 }, fraction: 0.3 }, new Date('2026-09-19T08:00:00Z'))
    expect(saved).toEqual({ position: { section: 2, offset: 40 }, fraction: 0.3, updatedAt: '2026-09-19T08:00:00.000Z' })
    expect(await store.read(BOOK)).toEqual(saved)
    const file = join(root, 'progress', `${BOOK}.json`)
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1, path: '三体.epub' })
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('reads a torn, foreign, or invalid record as no progress', async () => {
    const root = await tempRoot('ebook-progress-')
    const store = new ProgressStore(root)
    const file = join(root, 'progress', `${BOOK}.json`)
    await mkdir(join(root, 'progress'))
    for (const text of [
      '{"version":1,',
      JSON.stringify({ version: 2, position: { section: 0, offset: 0 }, fraction: 0, updatedAt: '2026-09-19T08:00:00Z' }),
      JSON.stringify({ version: 1, position: { section: 0, offset: 0 }, fraction: 0, updatedAt: 'yesterday' }),
      JSON.stringify({ version: 1, position: { section: 0, offset: 0 }, fraction: 2, updatedAt: '2026-09-19T08:00:00Z' }),
      JSON.stringify({ version: 1, fraction: 0 }),
      '[]',
    ]) {
      await writeFile(file, text)
      expect(await store.read(BOOK)).toBeUndefined()
    }
  })

  it('surfaces read errors other than absence', async () => {
    const root = await tempRoot('ebook-progress-')
    await mkdir(join(root, 'progress', `${BOOK}.json`), { recursive: true })
    await expect(new ProgressStore(root).read(BOOK)).rejects.toThrow()
  })
})

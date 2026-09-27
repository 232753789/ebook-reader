/** Durable per-book reading progress, one private JSON file per book. */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { BookId, ReadingPosition, ReadingProgress, ReadingProgressUpdate } from './types.ts'

const PRIVATE_FILE = { mode: 0o600, dirMode: 0o700 } as const
/** On-disk record version; a record of another version is ignored. */
const RECORD_VERSION = 1

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Validate an untrusted reading position.
 * @param value - parsed JSON from a request body or a progress file.
 * @returns the position, or undefined when the value is not one.
 */
export function parsePosition(value: unknown): ReadingPosition | undefined {
  if (!isObject(value) || !isNonNegativeInteger(value.section) || !isNonNegativeInteger(value.offset)) return undefined
  return { section: value.section, offset: value.offset }
}

/**
 * Validate an untrusted progress update body.
 * @param value - parsed JSON request body.
 * @returns the update, or undefined when the value is not one.
 */
export function parseProgressUpdate(value: unknown): ReadingProgressUpdate | undefined {
  if (!isObject(value)) return undefined
  const position = parsePosition(value.position)
  const fraction = value.fraction
  if (position === undefined || typeof fraction !== 'number' || !(fraction >= 0 && fraction <= 1)) return undefined
  return { position, fraction }
}

function parseRecord(value: unknown): ReadingProgress | undefined {
  if (!isObject(value) || value.version !== RECORD_VERSION || typeof value.updatedAt !== 'string') return undefined
  const update = parseProgressUpdate(value)
  if (update === undefined || !Number.isFinite(Date.parse(value.updatedAt))) return undefined
  return { ...update, updatedAt: value.updatedAt }
}

/** Reads and writes reading progress under `<storageRoot>/progress`. */
export class ProgressStore {
  private readonly directory: string

  /** @param storageRoot - the plugin's private storage directory. */
  constructor(storageRoot: string) {
    this.directory = join(storageRoot, 'progress')
  }

  private file(id: BookId): string {
    return join(this.directory, `${id}.json`)
  }

  /**
   * Read one book's progress.
   * @param id - validated book id.
   * @returns the saved progress, or undefined when none is saved or the record is unreadable.
   */
  async read(id: BookId): Promise<ReadingProgress | undefined> {
    let text: string
    try {
      text = await readFile(this.file(id), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    try {
      return parseRecord(JSON.parse(text))
    } catch {
      // A torn or foreign file reads as no progress; the next save replaces it atomically.
      return undefined
    }
  }

  /**
   * Replace one book's progress.
   * @param id - validated book id.
   * @param path - the book's library-relative path, recorded for inspection.
   * @param update - validated position and fraction.
   * @param now - save instant.
   * @returns the stored progress.
   */
  async write(id: BookId, path: string, update: ReadingProgressUpdate, now: Date): Promise<ReadingProgress> {
    const progress: ReadingProgress = { ...update, updatedAt: now.toISOString() }
    const record = { version: RECORD_VERSION, path, ...progress }
    await writeFileAtomic(this.file(id), `${JSON.stringify(record, null, 2)}\n`, PRIVATE_FILE)
    return progress
  }
}

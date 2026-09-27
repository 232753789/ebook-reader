/** A value source for the slot renderer's hooks compartment. */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Holds one immutable snapshot and notifies subscribers when a different snapshot is published.
 * The snapshot keeps its identity until `set` publishes another.
 */
export class Observable<T> implements HostObservable<T> {
  private readonly listeners = new Set<() => void>()

  /** @param value - the initial snapshot. */
  constructor(private value: T) {}

  /** @returns the current snapshot. */
  getSnapshot = (): T => this.value

  /**
   * @param fn - called after each published change.
   * @returns the unsubscribe function.
   */
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  /**
   * Publish a snapshot; an identical snapshot notifies nobody.
   * @param next - the new snapshot.
   */
  set(next: T): void {
    if (Object.is(next, this.value)) return
    this.value = next
    for (const listener of [...this.listeners]) listener()
  }
}

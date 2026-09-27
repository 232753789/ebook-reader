/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-ebook-reader`.
 * @module @deepseek-ai/dsh-ebook-reader/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-ebook-reader'

/** Cordis companion plugin name. */
export const name = 'ebook-reader-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package reads library files, writes private progress and audio
 * files, and owns one TTS subprocess, whose teardown its lifecycle tests assert. It emits no
 * session events and holds no Host state another package observes.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */

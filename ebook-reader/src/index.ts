/**
 * Ebook-reader Host plugin: lists PDF and EPUB files under a local library directory, serves them
 * and the PDF.js distribution to the browser, stores per-book reading progress, and synthesizes
 * read-aloud audio with a local Qwen3-TTS CustomVoice worker.
 * @module @deepseek-ai/dsh-ebook-reader
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-subprocess'
import { Config, resolveConfig } from './config.ts'
import { EbookHttpController } from './http.ts'
import { EBOOK_API_PREFIX, EbookReaderRuntime } from './runtime.ts'
import { LocalSpeechWorker } from './speech.ts'

export { Config, EBOOK_API_PREFIX, resolveConfig }
export type { ResolvedConfig, ResolvedSpeechConfig, SpeechDevice } from './config.ts'
export type {
  BookEntry,
  BookFormat,
  BookId,
  BookList,
  ReaderCapabilities,
  ReadingPosition,
  ReadingProgress,
  ReadingProgressUpdate,
  SpeechCapabilities,
  SpeechRequest,
  SpeechVoice,
} from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'ebook-reader'
/** Required Host services; this optional bundle is valid only above the Web bundle. */
export const inject = ['webServer', 'subprocess']

/**
 * Resolve the configuration, then register the route family over one runtime. Resolution fails
 * the plugin load when read-aloud is enabled over an incomplete or non-CustomVoice model.
 * @param ctx - plugin context owning the route registration and the TTS process.
 * @param config - Loader-validated composition values.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.effect(() => {
    const engine = resolved.speech === undefined ? undefined : new LocalSpeechWorker(ctx, resolved.speech)
    const runtime = new EbookReaderRuntime(resolved, engine, ctx.logger.warn.bind(ctx.logger))
    const http = new EbookHttpController(runtime)
    const disposeRoute = ctx.webServer.register({ kind: 'prefix', path: EBOOK_API_PREFIX, handler: http.handle })
    return async () => {
      disposeRoute()
      await http.dispose()
      await runtime.dispose()
    }
  }, 'ebook-reader: routes and read-aloud runtime')
}

/** Host test fixtures: a Qwen3-TTS model directory, a scripted TTS worker process, and temp roots. */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'

/** The files `inspectSpeechModel` requires besides `config.json`. */
const MODEL_FILES = [
  'generation_config.json',
  'model.safetensors',
  'preprocessor_config.json',
  'tokenizer_config.json',
  'vocab.json',
  'merges.txt',
  'speech_tokenizer/config.json',
  'speech_tokenizer/model.safetensors',
  'speech_tokenizer/preprocessor_config.json',
] as const

/** The speaker, dialect, and language tables of the released 1.7B CustomVoice checkpoint. */
export const CUSTOM_VOICE_CONFIG = {
  tts_model_type: 'custom_voice',
  talker_config: {
    spk_id: { Serena: 3066, Vivian: 3065, Uncle_Fu: 3010, Eric: 2875 },
    spk_is_dialect: { Serena: false, Vivian: false, Uncle_Fu: false, Eric: 'sichuan_dialect' },
    codec_language_id: { chinese: 2055, english: 2050, sichuan_dialect: 2062 },
  },
}

/**
 * @param prefix - temp directory name prefix.
 * @returns a fresh temp directory.
 */
export function tempRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

async function writeCheckpoint(model: string, config: unknown): Promise<string> {
  for (const file of MODEL_FILES) {
    await mkdir(dirname(join(model, file)), { recursive: true })
    await writeFile(join(model, file), '')
  }
  await writeFile(join(model, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config))
  return model
}

/**
 * Write a model directory holding every required file.
 * @param root - parent directory.
 * @param config - the `config.json` value, or raw text written verbatim.
 * @returns the model directory.
 */
export function modelDirectory(root: string, config: unknown = CUSTOM_VOICE_CONFIG): Promise<string> {
  return writeCheckpoint(join(root, 'model'), config)
}

/**
 * Write a Hugging Face cache directory holding one checkpoint per revision.
 * @param root - parent directory.
 * @param revisions - revision ids, each written under `snapshots/`.
 * @param head - revision named in `refs/main`; omitted writes no `refs/main`.
 * @returns the cache directory.
 */
export async function cacheDirectory(root: string, revisions: readonly string[], head?: string): Promise<string> {
  const cache = join(root, 'models--Qwen--Qwen3-TTS-12Hz-1.7B-CustomVoice')
  await mkdir(join(cache, 'snapshots'), { recursive: true })
  for (const revision of revisions) await writeCheckpoint(join(cache, 'snapshots', revision), CUSTOM_VOICE_CONFIG)
  // Every cache directory also carries the blobs the snapshots link to.
  await mkdir(join(cache, 'blobs'), { recursive: true })
  if (head !== undefined) {
    await mkdir(join(cache, 'refs'), { recursive: true })
    await writeFile(join(cache, 'refs', 'main'), `${head}\n`)
  }
  return cache
}

/** One JSON request line the fake worker received. */
export interface WorkerRequest {
  readonly id: number
  readonly language: string
  readonly instruct: string
  /** The segments this request generates in one model call. */
  readonly segments: readonly { readonly text: string; readonly speaker: string; readonly output: string }[]
}

/** A scripted TTS worker process; `manual` holds each request until the test answers it. */
export class FakeWorkerProcess {
  readonly pid = 4242
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = undefined
  readonly collected = { stderr: undefined } as unknown as SubprocessHandle['collected']
  readonly done: Promise<SubprocessOutcome>
  readonly received: WorkerRequest[] = []
  terminated = false
  private settle!: (outcome: SubprocessOutcome) => void

  /** @param manual - hold requests instead of answering them at once. */
  constructor(private readonly manual = false) {
    this.done = new Promise<SubprocessOutcome>((resolve) => { this.settle = resolve })
    this.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim() === '') continue
        const request = JSON.parse(line) as WorkerRequest
        this.received.push(request)
        if (!this.manual) this.answer(request.id)
      }
    })
  }

  /**
   * Write one response line.
   * @param id - request id.
   * @param error - failure message, or undefined for success.
   */
  answer(id: number, error?: string): void {
    this.stdout.write(`${JSON.stringify(error === undefined ? { id, ok: true, seconds: 1 } : { id, ok: false, error })}\n`)
  }

  /** @param line - a raw stdout line. */
  write(line: string): void {
    this.stdout.write(`${line}\n`)
  }

  terminate(): void {
    this.terminated = true
    this.settle({ exitCode: null, signal: 'SIGTERM' })
  }

  waitForExit(): Promise<boolean> {
    return Promise.resolve(true)
  }
}

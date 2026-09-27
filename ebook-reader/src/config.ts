/** Configuration validation, Qwen3-TTS model inspection, and explicit runtime default resolution. */

import { createHash } from 'node:crypto'
import { accessSync, constants as fsConstants, readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { dshHomePath, expandHomePath } from '@deepseek-ai/dsh-home-paths'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { SpeechVoice } from './types.ts'

/** Local inference device; auto tries CUDA, then MPS, then CPU. */
export type SpeechDevice = 'auto' | 'cuda' | 'mps' | 'cpu'

/**
 * Which of the checkpoint's two decoders sample.
 *
 * `talker-sampled` turns off sampling in the sub-talker alone, which fixes the codebook detail
 * of each frame while the talker keeps sampling the prosody and the stop token. `fully-sampled`
 * leaves the checkpoint's own `generation_config.json` in charge, which samples in both.
 *
 * The talker has to keep sampling: decoded greedily it fails to emit the stop token on a large
 * share of ordinary sentences and runs to `max_new_tokens`, which the checkpoint sets to 8192.
 */
export type SpeechDecoding = 'talker-sampled' | 'fully-sampled'

/**
 * One voice's acoustic anchor: reference speech the model conditions every segment on.
 *
 * Without one, a voice is conditioned by its `spk_id` embedding alone and nothing ties one
 * sentence's timbre to the next, so a long reading drifts. The reference codes prefix each
 * generation instead, which holds the voice steady across segments.
 */
export interface SpeechVoicePrompt {
  /** Voice id from the model's `talker_config.spk_id` table, matched without case. */
  voice: string
  /** Reference audio file; a clean single-speaker recording of `text`, a few seconds long. */
  audio: string
  /** Exact transcript of `audio`; the model conditions on the pair, so a wrong transcript misleads it. */
  text: string
}

/** One voice's resolved anchor. */
export interface ResolvedVoicePrompt {
  readonly audio: string
  readonly text: string
  /** Digest of the reference audio and transcript; part of the cache key of every segment it anchors. */
  readonly digest: string
}

/** Host plugin configuration. */
export interface Config {
  /** Directory scanned recursively for `.pdf` and `.epub` files. */
  libraryRoot?: string
  /** Private directory holding reading progress and synthesized audio. */
  storageRoot?: string
  /** Most books one listing returns. */
  listMaxBooks?: number
  /** `local` runs Qwen3-TTS in a Python worker; `off` hides read-aloud. */
  speechMode?: 'off' | 'local'
  /** Qwen3-TTS CustomVoice checkpoint directory, or the Hugging Face cache directory holding it. */
  speechModelPath?: string
  /** Python executable with the `qwen-tts` package installed. */
  pythonExecutable?: string
  /** Local inference device. */
  speechDevice?: SpeechDevice
  /** Qwen3-TTS language name, or `Auto` for per-text language adaptation. */
  speechLanguage?: string
  /** Speaker used until the reader picks another; omitted means the model's first speaker. */
  defaultVoice?: string
  /** Longest text one segment may carry; the browser splits sentences to fit. */
  speechMaxSegmentChars?: number
  /** Paragraphs the browser synthesizes ahead of the one playing. */
  speechPrefetchParagraphs?: number
  /** Most segments one request may carry; the browser splits a longer paragraph to fit. */
  speechMaxRequestSegments?: number
  /** Which of the checkpoint's two decoders sample. */
  speechDecoding?: SpeechDecoding
  /** Reference speech each listed voice is anchored on; a voice without an entry is read from its `spk_id` alone. */
  speechVoicePrompts?: SpeechVoicePrompt[]
  /** Silence the browser holds between one segment's audio and the next. */
  speechSegmentGapMs?: number
  /** Deadline for one synthesis request, including a model load. */
  speechRequestTimeoutMs?: number
  /** Idle time after which the resident TTS process is stopped; the next request starts it again. */
  speechIdleShutdownMs?: number
  /** Size above which the oldest cached audio files are deleted. */
  speechCacheMaxBytes?: number
}

/** Resolved read-aloud settings when speech is enabled. */
export interface ResolvedSpeechConfig {
  readonly modelPath: string
  readonly pythonExecutable: string
  readonly device: SpeechDevice
  readonly language: string
  readonly voices: readonly SpeechVoice[]
  /** Voice id to the exact `talker_config.spk_id` key the model answers to. */
  readonly speakers: Readonly<Record<string, string>>
  readonly defaultVoice: string
  readonly maxSegmentChars: number
  readonly prefetchParagraphs: number
  readonly maxRequestSegments: number
  readonly decoding: SpeechDecoding
  /** Anchors by voice id; a voice absent from the map has none. */
  readonly voicePrompts: ReadonlyMap<string, ResolvedVoicePrompt>
  readonly segmentGapMs: number
  readonly requestTimeoutMs: number
  readonly idleShutdownMs: number
  readonly cacheMaxBytes: number
}

/** Fully resolved immutable runtime settings. */
export interface ResolvedConfig {
  readonly libraryRoot: string
  readonly storageRoot: string
  readonly listMaxBooks: number
  /** Absent when `speechMode` is `off`. */
  readonly speech?: ResolvedSpeechConfig
}

/** Files a Qwen3-TTS 12Hz CustomVoice checkpoint needs besides its speaker table. */
const REQUIRED_MODEL_FILES = [
  'config.json',
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

const DEFAULT_LIBRARY_ROOT = '~/Documents/Books'
const DEFAULT_MODEL_DIRECTORY = 'Qwen3-TTS-12Hz-1.7B-CustomVoice'

/** Schemastery declaration for profile composition. */
export const Config: any = z.object({
  libraryRoot: z.string().default(DEFAULT_LIBRARY_ROOT),
  storageRoot: z.string(),
  listMaxBooks: z.number().step(1).min(1).default(2_000),
  speechMode: z.union(['off', 'local'] as const).default('off'),
  speechModelPath: z.string(),
  pythonExecutable: z.string().default('python3'),
  speechDevice: z.union(['auto', 'cuda', 'mps', 'cpu'] as const).default('auto'),
  speechLanguage: z.string().default('Auto'),
  defaultVoice: z.string(),
  speechMaxSegmentChars: z.number().step(1).min(8).default(120),
  speechPrefetchParagraphs: z.number().step(1).min(0).default(1),
  speechMaxRequestSegments: z.number().step(1).min(1).default(24),
  speechDecoding: z.union(['talker-sampled', 'fully-sampled'] as const).default('talker-sampled'),
  speechVoicePrompts: z.array(z.object({
    voice: z.string().required(),
    audio: z.string().required(),
    text: z.string().required(),
  })).default([]),
  speechSegmentGapMs: z.number().step(1).min(0).max(MAX_TIMER_DELAY_MS).default(300),
  speechRequestTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(300_000),
  speechIdleShutdownMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(600_000),
  speechCacheMaxBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(1_073_741_824),
})

function requiredString(name: string, value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new Error(`ebook-reader: ${name} must be a non-empty string`)
  return trimmed
}

function integerInRange(name: string, value: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`ebook-reader: ${name} must be an integer from ${String(minimum)} to ${String(maximum)}`)
  }
  return value
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** What the model directory's `config.json` declares about speakers and languages. */
export interface SpeechModelFacts {
  readonly voices: readonly SpeechVoice[]
  /** Voice id to the exact `talker_config.spk_id` key, which carries the table's own casing. */
  readonly speakers: Readonly<Record<string, string>>
  /** The first speaker of the table, the default voice when none is configured. */
  readonly firstVoice: string
  /** Language names from `talker_config.codec_language_id`, lower case. */
  readonly languages: readonly string[]
}

/**
 * Resolve a Hugging Face cache directory (`refs/`, `snapshots/<revision>/`) to the checkpoint it holds.
 *
 * A `huggingface-cli download` or `snapshot_download` target keeps the files one revision deep, so the
 * configured path names the cache directory rather than the checkpoint. Any other directory, including a
 * checkout of the repository itself, is already the checkpoint.
 * @param modelPath - absolute configured directory.
 * @returns the directory holding `config.json`.
 */
export function resolveModelDirectory(modelPath: string): string {
  const snapshots = resolve(modelPath, 'snapshots')
  let revisions: string[]
  try {
    revisions = readdirSync(snapshots, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    // Not a Hugging Face cache directory; inspectSpeechModel reports whatever this path is missing.
    return modelPath
  }
  let head: string | undefined
  try {
    head = readFileSync(resolve(modelPath, 'refs', 'main'), 'utf8').trim()
  } catch {
    // A cache directory downloaded by revision has no `refs/main`; the sole snapshot below answers instead.
  }
  if (head !== undefined) {
    if (!revisions.includes(head)) {
      throw new Error(`ebook-reader: ${modelPath} names revision ${head} in refs/main, which snapshots/ does not hold`)
    }
    return resolve(snapshots, head)
  }
  const [only] = revisions
  if (only === undefined) {
    throw new Error(`ebook-reader: ${modelPath} is a Hugging Face cache whose snapshots/ holds no revision`)
  }
  if (revisions.length > 1) {
    throw new Error(
      `ebook-reader: ${modelPath} is a Hugging Face cache holding ${String(revisions.length)} revisions and no refs/main;`
      + ' set speechModelPath to one snapshots/<revision> directory',
    )
  }
  return resolve(snapshots, only)
}

/**
 * Verify that a directory holds a complete Qwen3-TTS CustomVoice checkpoint and read its speakers.
 * @param modelPath - absolute candidate model directory.
 * @returns the speakers in the model's table order and the supported language names.
 */
export function inspectSpeechModel(modelPath: string): SpeechModelFacts {
  let directory = false
  try {
    directory = statSync(modelPath).isDirectory()
  } catch {
    // The diagnostic below owns the missing-path case and names the directory.
  }
  if (!directory) throw new Error(`ebook-reader: speechModelPath is not a directory: ${modelPath}`)
  const missing = REQUIRED_MODEL_FILES.filter((filename) => {
    try {
      accessSync(resolve(modelPath, filename), fsConstants.R_OK)
      return false
    } catch {
      return true
    }
  })
  if (missing.length > 0) {
    throw new Error(`ebook-reader: Qwen3-TTS model is incomplete at ${modelPath}; missing ${missing.join(', ')}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(resolve(modelPath, 'config.json'), 'utf8'))
  } catch (error) {
    throw new Error(`ebook-reader: cannot read ${resolve(modelPath, 'config.json')}: ${String(error)}`)
  }
  if (!isObject(parsed) || parsed.tts_model_type !== 'custom_voice') {
    throw new Error(`ebook-reader: ${modelPath} is not a Qwen3-TTS CustomVoice model (tts_model_type must be custom_voice)`)
  }
  const talker = parsed.talker_config
  const speakerTable = isObject(talker) ? talker.spk_id : undefined
  const ids = isObject(speakerTable) ? Object.keys(speakerTable) : []
  const [first] = ids
  if (first === undefined) {
    throw new Error(`ebook-reader: ${modelPath} declares no speakers in talker_config.spk_id`)
  }
  const dialects = isObject(talker) && isObject(talker.spk_is_dialect) ? talker.spk_is_dialect : {}
  const voices = ids.map((id): SpeechVoice => {
    const dialect = dialects[id]
    return typeof dialect === 'string' ? { id: id.toLowerCase(), dialect } : { id: id.toLowerCase() }
  })
  // The model answers to its own key, so the lower-case id the browser and the cache use maps back to it.
  const speakers = Object.fromEntries(ids.map(id => [id.toLowerCase(), id]))
  if (Object.keys(speakers).length !== ids.length) {
    throw new Error(`ebook-reader: ${modelPath} declares speakers that differ only in case: ${ids.join(', ')}`)
  }
  const languageTable = isObject(talker) && isObject(talker.codec_language_id) ? talker.codec_language_id : {}
  return {
    voices,
    speakers,
    firstVoice: first.toLowerCase(),
    languages: Object.keys(languageTable).map(language => language.toLowerCase()),
  }
}

/**
 * Resolve each configured anchor against the model's voice table and the files on disk.
 * @param prompts - configured entries, in profile order.
 * @param voices - voice ids the model declares.
 * @returns anchors by voice id.
 */
function resolveVoicePrompts(
  prompts: readonly SpeechVoicePrompt[], voices: readonly SpeechVoice[],
): ReadonlyMap<string, ResolvedVoicePrompt> {
  const resolved = new Map<string, ResolvedVoicePrompt>()
  for (const prompt of prompts) {
    const voice = requiredString('speechVoicePrompts[].voice', prompt.voice).toLowerCase()
    if (!voices.some(entry => entry.id === voice)) {
      throw new Error(`ebook-reader: speechVoicePrompts names voice ${voice}, which is not one of ${voices.map(entry => entry.id).join(', ')}`)
    }
    if (resolved.has(voice)) {
      throw new Error(`ebook-reader: speechVoicePrompts names voice ${voice} twice`)
    }
    const text = requiredString(`speechVoicePrompts[${voice}].text`, prompt.text)
    const audio = resolve(expandHomePath(requiredString(`speechVoicePrompts[${voice}].audio`, prompt.audio)))
    let bytes: Buffer
    try {
      bytes = readFileSync(audio)
    } catch (error) {
      throw new Error(`ebook-reader: speechVoicePrompts[${voice}].audio cannot be read at ${audio}: ${String(error)}`)
    }
    // The digest covers both halves of the anchor, so replacing either re-synthesizes what it anchored.
    const digest = createHash('sha256').update(bytes).update(text, 'utf8').digest('hex')
    resolved.set(voice, { audio, text, digest })
  }
  return resolved
}

function resolveSpeech(config: Config): ResolvedSpeechConfig {
  const configured = resolve(expandHomePath(config.speechModelPath ?? dshHomePath('models', DEFAULT_MODEL_DIRECTORY)))
  const modelPath = resolveModelDirectory(configured)
  const facts = inspectSpeechModel(modelPath)
  const language = requiredString('speechLanguage', config.speechLanguage ?? 'Auto')
  if (language.toLowerCase() !== 'auto' && !facts.languages.includes(language.toLowerCase())) {
    throw new Error(`ebook-reader: speechLanguage ${language} is not one of Auto, ${facts.languages.join(', ')}`)
  }
  // The first speaker of the model's own table is the explicit default when none is configured.
  const defaultVoice = (config.defaultVoice ?? facts.firstVoice).trim().toLowerCase()
  if (!facts.voices.some(voice => voice.id === defaultVoice)) {
    throw new Error(`ebook-reader: defaultVoice ${defaultVoice} is not one of ${facts.voices.map(voice => voice.id).join(', ')}`)
  }
  return {
    modelPath,
    pythonExecutable: requiredString('pythonExecutable', config.pythonExecutable ?? 'python3'),
    device: config.speechDevice ?? 'auto',
    language,
    voices: facts.voices,
    speakers: facts.speakers,
    defaultVoice,
    maxSegmentChars: integerInRange('speechMaxSegmentChars', config.speechMaxSegmentChars ?? 120, 8),
    prefetchParagraphs: integerInRange('speechPrefetchParagraphs', config.speechPrefetchParagraphs ?? 1, 0),
    maxRequestSegments: integerInRange('speechMaxRequestSegments', config.speechMaxRequestSegments ?? 24, 1),
    decoding: config.speechDecoding ?? 'talker-sampled',
    voicePrompts: resolveVoicePrompts(config.speechVoicePrompts ?? [], facts.voices),
    segmentGapMs: integerInRange('speechSegmentGapMs', config.speechSegmentGapMs ?? 300, 0, MAX_TIMER_DELAY_MS),
    requestTimeoutMs: integerInRange('speechRequestTimeoutMs', config.speechRequestTimeoutMs ?? 300_000, 1, MAX_TIMER_DELAY_MS),
    idleShutdownMs: integerInRange('speechIdleShutdownMs', config.speechIdleShutdownMs ?? 600_000, 1, MAX_TIMER_DELAY_MS),
    cacheMaxBytes: integerInRange('speechCacheMaxBytes', config.speechCacheMaxBytes ?? 1_073_741_824, 1),
  }
}

/**
 * Resolve defaults once and reject configuration errors before routes are registered.
 * @param config - Loader-validated composition values or a programmatic equivalent.
 * @returns the immutable runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const libraryRoot = resolve(expandHomePath(requiredString('libraryRoot', config.libraryRoot ?? DEFAULT_LIBRARY_ROOT)))
  const storageRoot = resolve(expandHomePath(config.storageRoot ?? dshHomePath('ebook-reader')))
  const listMaxBooks = integerInRange('listMaxBooks', config.listMaxBooks ?? 2_000, 1)
  const speechMode = config.speechMode ?? 'off'
  return speechMode === 'local'
    ? { libraryRoot, storageRoot, listMaxBooks, speech: resolveSpeech(config) }
    : { libraryRoot, storageRoot, listMaxBooks }
}

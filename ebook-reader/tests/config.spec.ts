import { rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config, inspectSpeechModel, resolveConfig, resolveModelDirectory } from '../src/config.ts'
import { cacheDirectory, CUSTOM_VOICE_CONFIG, modelDirectory, tempRoot } from './fixtures.ts'

afterEach(() => { vi.unstubAllEnvs() })

describe('ebook-reader configuration', () => {
  it('looks for the model under the harness home when no path is configured', async () => {
    const home = await tempRoot('ebook-home-')
    vi.stubEnv('DSH_HOME', home)
    expect(() => resolveConfig({ speechMode: 'local' }))
      .toThrow(`speechModelPath is not a directory: ${join(home, 'models', 'Qwen3-TTS-12Hz-1.7B-CustomVoice')}`)
  })

  it('resolves the documented defaults with read-aloud off', () => {
    expect(resolveConfig({})).toEqual({
      libraryRoot: join(homedir(), 'Documents', 'Books'),
      storageRoot: dshHomePath('ebook-reader'),
      listMaxBooks: 2_000,
    })
  })

  it('applies the schema defaults the Loader validates', () => {
    expect(Config({})).toMatchObject({
      libraryRoot: '~/Documents/Books',
      listMaxBooks: 2_000,
      speechMode: 'off',
      pythonExecutable: 'python3',
      speechDevice: 'auto',
      speechLanguage: 'Auto',
      speechMaxSegmentChars: 120,
      speechPrefetchParagraphs: 1,
      speechMaxRequestSegments: 24,
      speechDecoding: 'talker-sampled',
    })
  })

  it('rejects an empty library directory and out-of-range integers', () => {
    expect(() => resolveConfig({ libraryRoot: '  ' })).toThrow('libraryRoot must be a non-empty string')
    expect(() => resolveConfig({ listMaxBooks: 0 })).toThrow('listMaxBooks must be an integer from 1')
    expect(() => resolveConfig({ listMaxBooks: 1.5 })).toThrow('listMaxBooks must be an integer')
  })

  it('reads speakers, dialects, and languages from a CustomVoice model', async () => {
    const root = await tempRoot('ebook-config-')
    const model = await modelDirectory(root)
    expect(inspectSpeechModel(model)).toEqual({
      voices: [{ id: 'serena' }, { id: 'vivian' }, { id: 'uncle_fu' }, { id: 'eric', dialect: 'sichuan_dialect' }],
      // The voice ids are lower case; each one maps back to the key the model answers to.
      speakers: { serena: 'Serena', vivian: 'Vivian', uncle_fu: 'Uncle_Fu', eric: 'Eric' },
      firstVoice: 'serena',
      languages: ['chinese', 'english', 'sichuan_dialect'],
    })
  })

  it('resolves read-aloud with the model table first speaker as the default voice', async () => {
    const root = await tempRoot('ebook-config-')
    const model = await modelDirectory(root)
    const resolved = resolveConfig({ speechMode: 'local', speechModelPath: model, storageRoot: root })
    expect(resolved.speech).toEqual({
      modelPath: model,
      pythonExecutable: 'python3',
      device: 'auto',
      language: 'Auto',
      voices: inspectSpeechModel(model).voices,
      speakers: inspectSpeechModel(model).speakers,
      defaultVoice: 'serena',
      maxSegmentChars: 120,
      prefetchParagraphs: 1,
      maxRequestSegments: 24,
      decoding: 'talker-sampled',
      voicePrompts: new Map(),
      segmentGapMs: 300,
      requestTimeoutMs: 300_000,
      idleShutdownMs: 600_000,
      cacheMaxBytes: 1_073_741_824,
    })
  })

  it('accepts a configured voice and language case-insensitively', async () => {
    const root = await tempRoot('ebook-config-')
    const model = await modelDirectory(root)
    const resolved = resolveConfig({
      speechMode: 'local',
      speechModelPath: model,
      defaultVoice: ' Vivian ',
      speechLanguage: 'Chinese',
      speechDevice: 'mps',
    })
    expect(resolved.speech).toMatchObject({ defaultVoice: 'vivian', language: 'Chinese', device: 'mps' })
  })

  it('fails loud for an unknown voice or language', async () => {
    const root = await tempRoot('ebook-config-')
    const model = await modelDirectory(root)
    expect(() => resolveConfig({ speechMode: 'local', speechModelPath: model, defaultVoice: 'nobody' }))
      .toThrow('defaultVoice nobody is not one of serena, vivian, uncle_fu, eric')
    expect(() => resolveConfig({ speechMode: 'local', speechModelPath: model, speechLanguage: 'Klingon' }))
      .toThrow('speechLanguage Klingon is not one of Auto, chinese, english, sichuan_dialect')
  })

  it('resolves a voice anchor against the model table, the file, and a digest of both halves', async () => {
    const root = await tempRoot('ebook-config-')
    const model = await modelDirectory(root)
    const audio = join(root, 'serena-2.wav')
    await writeFile(audio, 'reference audio bytes')
    const resolved = resolveConfig({
      speechMode: 'local',
      speechModelPath: model,
      speechVoicePrompts: [{ voice: ' Serena ', audio, text: '参考文本。' }],
    })
    const anchor = resolved.speech!.voicePrompts.get('serena')!
    expect(anchor).toMatchObject({ audio, text: '参考文本。' })
    expect(anchor.digest).toMatch(/^[0-9a-f]{64}$/)
    // Either half of the anchor changes the digest, which is what re-synthesizes what it anchored.
    const other = resolveConfig({
      speechMode: 'local',
      speechModelPath: model,
      speechVoicePrompts: [{ voice: 'serena', audio, text: '另一段参考文本。' }],
    }).speech!.voicePrompts.get('serena')!
    expect(other.digest).not.toBe(anchor.digest)
  })

  it('fails loud for an anchor naming an unknown voice, one voice twice, or an unreadable file', async () => {
    const root = await tempRoot('ebook-config-')
    const model = await modelDirectory(root)
    const audio = join(root, 'serena-2.wav')
    await writeFile(audio, 'reference audio bytes')
    const speech = { speechMode: 'local', speechModelPath: model } as const
    expect(() => resolveConfig({ ...speech, speechVoicePrompts: [{ voice: 'nobody', audio, text: '参考' }] }))
      .toThrow('speechVoicePrompts names voice nobody, which is not one of serena, vivian, uncle_fu, eric')
    expect(() => resolveConfig({
      ...speech,
      speechVoicePrompts: [{ voice: 'serena', audio, text: '参考' }, { voice: 'Serena', audio, text: '参考' }],
    })).toThrow('speechVoicePrompts names voice serena twice')
    expect(() => resolveConfig({ ...speech, speechVoicePrompts: [{ voice: 'serena', audio, text: '  ' }] }))
      .toThrow('speechVoicePrompts[serena].text must be a non-empty string')
    expect(() => resolveConfig({
      ...speech,
      speechVoicePrompts: [{ voice: 'serena', audio: join(root, 'absent.wav'), text: '参考' }],
    })).toThrow(`speechVoicePrompts[serena].audio cannot be read at ${join(root, 'absent.wav')}`)
    expect(() => resolveConfig({ ...speech, speechVoicePrompts: [{ voice: ' ', audio, text: '参考' }] }))
      .toThrow('speechVoicePrompts[].voice must be a non-empty string')
  })

  it('resolves a Hugging Face cache directory to the revision refs/main names, or to its only revision', async () => {
    const root = await tempRoot('ebook-config-')
    const named = await cacheDirectory(root, ['aaa111', 'bbb222'], 'bbb222')
    expect(resolveModelDirectory(named)).toBe(join(named, 'snapshots', 'bbb222'))
    expect(resolveConfig({ speechMode: 'local', speechModelPath: named }).speech?.modelPath)
      .toBe(join(named, 'snapshots', 'bbb222'))
    const sole = await cacheDirectory(await tempRoot('ebook-config-'), ['ccc333'])
    expect(resolveModelDirectory(sole)).toBe(join(sole, 'snapshots', 'ccc333'))
    const plain = await modelDirectory(await tempRoot('ebook-config-'))
    expect(resolveModelDirectory(plain)).toBe(plain)
  })

  it('rejects a cache directory whose revision is ambiguous or absent', async () => {
    const stale = await cacheDirectory(await tempRoot('ebook-config-'), ['aaa111'], 'ddd444')
    expect(() => resolveModelDirectory(stale)).toThrow('names revision ddd444 in refs/main, which snapshots/ does not hold')
    const ambiguous = await cacheDirectory(await tempRoot('ebook-config-'), ['aaa111', 'bbb222'])
    expect(() => resolveModelDirectory(ambiguous))
      .toThrow('is a Hugging Face cache holding 2 revisions and no refs/main; set speechModelPath to one snapshots/<revision> directory')
    const bare = await cacheDirectory(await tempRoot('ebook-config-'), [])
    expect(() => resolveModelDirectory(bare)).toThrow('is a Hugging Face cache whose snapshots/ holds no revision')
  })

  it('rejects a missing directory, missing files, and an unreadable config', async () => {
    const root = await tempRoot('ebook-config-')
    expect(() => inspectSpeechModel(join(root, 'absent'))).toThrow('speechModelPath is not a directory')
    const model = await modelDirectory(root)
    await rm(join(model, 'speech_tokenizer', 'model.safetensors'))
    expect(() => inspectSpeechModel(model)).toThrow('missing speech_tokenizer/model.safetensors')
    const broken = await modelDirectory(await tempRoot('ebook-config-'), '{not json')
    expect(() => inspectSpeechModel(broken)).toThrow('cannot read')
  })

  it('rejects a checkpoint that is not a CustomVoice model or declares no speakers', async () => {
    const base = await modelDirectory(await tempRoot('ebook-config-'), { ...CUSTOM_VOICE_CONFIG, tts_model_type: 'base' })
    expect(() => inspectSpeechModel(base)).toThrow('is not a Qwen3-TTS CustomVoice model')
    const array = await modelDirectory(await tempRoot('ebook-config-'), [])
    expect(() => inspectSpeechModel(array)).toThrow('is not a Qwen3-TTS CustomVoice model')
    const silent = await modelDirectory(await tempRoot('ebook-config-'), { tts_model_type: 'custom_voice' })
    expect(() => inspectSpeechModel(silent)).toThrow('declares no speakers')
    const empty = await modelDirectory(await tempRoot('ebook-config-'), { tts_model_type: 'custom_voice', talker_config: { spk_id: {} } })
    expect(() => inspectSpeechModel(empty)).toThrow('declares no speakers')
  })

  it('treats a model without a language table as Auto-only', async () => {
    const model = await modelDirectory(await tempRoot('ebook-config-'), {
      tts_model_type: 'custom_voice',
      talker_config: { spk_id: { Ryan: 1 } },
    })
    expect(inspectSpeechModel(model)).toEqual({ voices: [{ id: 'ryan' }], speakers: { ryan: 'Ryan' }, firstVoice: 'ryan', languages: [] })
    expect(resolveConfig({ speechMode: 'local', speechModelPath: model }).speech?.language).toBe('Auto')
  })

  it('rejects a speaker table whose keys differ only in case', async () => {
    const model = await modelDirectory(await tempRoot('ebook-config-'), {
      tts_model_type: 'custom_voice',
      talker_config: { spk_id: { Ryan: 1, ryan: 2 } },
    })
    expect(() => inspectSpeechModel(model)).toThrow('declares speakers that differ only in case: Ryan, ryan')
  })

  it('rejects out-of-range speech integers and an empty Python executable', async () => {
    const model = await modelDirectory(await tempRoot('ebook-config-'))
    const local = { speechMode: 'local', speechModelPath: model } as const
    expect(() => resolveConfig({ ...local, speechMaxSegmentChars: 4 })).toThrow('speechMaxSegmentChars must be an integer from 8')
    expect(() => resolveConfig({ ...local, speechPrefetchParagraphs: -1 })).toThrow('speechPrefetchParagraphs')
    expect(() => resolveConfig({ ...local, speechMaxRequestSegments: 0 })).toThrow('speechMaxRequestSegments must be an integer from 1')
    expect(() => resolveConfig({ ...local, speechRequestTimeoutMs: 0 })).toThrow('speechRequestTimeoutMs')
    expect(() => resolveConfig({ ...local, pythonExecutable: '' })).toThrow('pythonExecutable must be a non-empty string')
  })
})

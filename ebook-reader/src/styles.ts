/** Reading styles: the book categories the reader chooses between, and the instruction each sends. */

import type { SpeechStyle } from './types.ts'

/**
 * The categories the voice menu offers, in menu order.
 *
 * `instruct` is a Qwen3-TTS CustomVoice style instruction: it directs delivery on top of the
 * chosen speaker rather than describing a voice, so it names pace, tone, and pauses. The empty
 * instruction of `none` sends none at all, which is what a book without a category reads with.
 *
 * The table is fixed rather than configurable because a category is a product vocabulary the
 * browser's menu and the reader's saved choice both name; a deployment that needs other wording
 * changes this table.
 */
export const SPEECH_STYLES: readonly SpeechStyle[] = [
  { id: 'none', instruct: '' },
  { id: 'technical', instruct: '用清晰平稳的讲解语气朗读，语速稍慢，术语和英文词读清楚' },
  { id: 'paper', instruct: '用严谨正式的语气朗读，语速平缓，停顿分明' },
  { id: 'popular-science', instruct: '用轻松平实的讲述语气朗读，自然流畅' },
  { id: 'humanities', instruct: '用从容舒缓的叙述语气朗读，娓娓道来' },
  { id: 'fiction', instruct: '用自然的叙事语气朗读，情绪克制不夸张' },
  {
    id: 'loli',
    instruct: '体现撒娇稚嫩的萝莉女声，音调偏高且起伏明显，营造出黏人、做作又刻意卖萌的听觉效果。',
  },
] as const

/** The category a book reads with until the reader picks another. */
export const DEFAULT_SPEECH_STYLE = 'none'

/**
 * Resolve a category to the instruction it sends.
 * @param id - category id from the browser.
 * @returns the instruction, or undefined when no category has that id.
 */
export function instructFor(id: string): string | undefined {
  return SPEECH_STYLES.find(style => style.id === id)?.instruct
}

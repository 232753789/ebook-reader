/** Reading-text spans: line lookup, read-aloud segmentation, and the text each segment speaks. */

/** A half-open UTF-16 range of a section's reading text. */
export interface TextSpan {
  readonly start: number
  readonly end: number
}

/** Han, kana, Hangul, CJK punctuation, and full-width forms: scripts written without spaces. */
const CJK = /[\u1100-\u11FF\u2E80-\u2FDF\u3000-\u30FF\u3130-\u318F\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/u
/** A segment is read only when it holds a letter; a bare page number or rule of dashes is skipped. */
const SPEAKABLE = /\p{L}/u
/** Characters that end a sentence wherever they appear. */
const TERMINATORS = new Set(['。', '！', '？', '!', '?', '；', ';', '…'])
/** Closing marks that belong to the sentence they follow. */
const CLOSERS = new Set(['"', '\'', '”', '’', '」', '』', '）', ')', ']', '】', '》', '〉'])
/** Places a sentence longer than one segment is preferably split after. */
const SOFT_BREAKS = new Set(['，', ',', '、', '：', ':', '—', '–'])

/**
 * The text one segment speaks: whitespace collapsed to one space, removed between CJK characters,
 * and a Latin word hyphenated across a line break joined again.
 * @param raw - a slice of a section's reading text.
 * @returns the text sent to the synthesizer, possibly empty.
 */
export function speechText(raw: string): string {
  const joined = raw.replace(/([A-Za-z])-[ \t]*\n\s*([a-z])/g, '$1$2')
  return joined.replace(/\s+/g, (space: string, index: number, whole: string) => {
    const before = whole[index - 1]
    const after = whole[index + space.length]
    return before !== undefined && after !== undefined && CJK.test(before) && CJK.test(after) ? '' : ' '
  }).trim()
}

/**
 * Whether a character at `index` ends a sentence.
 * @param text - the reading text.
 * @param index - position of the candidate character.
 * @returns true for a terminator, or a period that is not inside a number.
 */
function endsSentence(text: string, index: number): boolean {
  const char = text.charAt(index)
  if (TERMINATORS.has(char)) return true
  if (char !== '.' && char !== '．') return false
  const next = text[index + 1]
  return next === undefined || /\s/.test(next) || CLOSERS.has(next)
}

/** Split one sentence that exceeds `maxChars` at soft breaks, then at spaces, then anywhere. */
function splitLong(text: string, span: TextSpan, maxChars: number): TextSpan[] {
  const pieces: TextSpan[] = []
  let start = span.start
  while (span.end - start > maxChars) {
    const limit = start + maxChars
    let cut = -1
    for (let index = limit - 1; index > start; index -= 1) {
      if (SOFT_BREAKS.has(text.charAt(index))) { cut = index + 1; break }
    }
    if (cut === -1) {
      for (let index = limit - 1; index > start; index -= 1) {
        if (/\s/.test(text.charAt(index))) { cut = index + 1; break }
      }
    }
    if (cut === -1) cut = limit
    pieces.push({ start, end: cut })
    start = cut
  }
  pieces.push({ start, end: span.end })
  return pieces
}

/**
 * Segment a section's reading text for read-aloud, from the sentence holding `from`.
 *
 * A segment is one sentence, cut at `breaks` (the starts of block elements) and split further so
 * no segment's reading text exceeds `maxChars`. Reading starts at the beginning of the sentence
 * `from` falls in, never mid-sentence. Leading whitespace is excluded from each span, and spans
 * without a letter (page numbers, rules, lone punctuation) are dropped. A span of `skip`, which
 * is what the section reports as something other than body prose, both cuts the sentences around
 * it and drops what falls inside it.
 * @param text - the section's reading text.
 * @param from - offset reading starts at.
 * @param maxChars - longest span, in UTF-16 units of the reading text.
 * @param breaks - ascending offsets where a new block starts.
 * @param skip - spans that are not body prose, in ascending order.
 * @returns the segments in reading order.
 */
export function speechSegments(
  text: string,
  from: number,
  maxChars: number,
  breaks: readonly number[] = [],
  skip: readonly TextSpan[] = [],
): TextSpan[] {
  const sentences: TextSpan[] = []
  // A skipped span's edges cut sentences too, so prose is never dropped for touching one.
  const hardBreaks = new Set([...breaks, ...skip.flatMap(span => [span.start, span.end])])
  const begin = Math.max(0, Math.min(from, text.length))
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    if (index > start && hardBreaks.has(index)) {
      sentences.push({ start, end: index })
      start = index
    }
    if (!endsSentence(text, index)) continue
    let end = index + 1
    while (end < text.length && (CLOSERS.has(text.charAt(end)) || TERMINATORS.has(text.charAt(end)))) end += 1
    sentences.push({ start, end })
    start = end
    index = end - 1
  }
  if (start < text.length) sentences.push({ start, end: text.length })
  const segments: TextSpan[] = []
  for (const sentence of sentences.filter(span => span.end > begin)) {
    for (const piece of splitLong(text, sentence, maxChars)) {
      let pieceStart = piece.start
      while (pieceStart < piece.end && /\s/.test(text.charAt(pieceStart))) pieceStart += 1
      if (skip.some(span => pieceStart < span.end && span.start < piece.end)) continue
      if (SPEAKABLE.test(text.slice(pieceStart, piece.end))) segments.push({ start: pieceStart, end: piece.end })
    }
  }
  return segments
}

/**
 * Group a section's segments into the paragraphs they came from.
 *
 * A paragraph is the run of segments between two block starts, which is the unit read-aloud sends
 * to the Host: its sentences are generated in one model call. A paragraph longer than
 * `maxSegments` is cut into consecutive groups of that size, because one request carries no more.
 * @param segments - the section's segments in reading order.
 * @param breaks - ascending offsets where a new block starts.
 * @param maxSegments - most segments one group may hold.
 * @returns the groups in reading order; every segment appears in exactly one.
 */
export function speechGroups(
  segments: readonly TextSpan[],
  breaks: readonly number[] = [],
  maxSegments = Number.MAX_SAFE_INTEGER,
): TextSpan[][] {
  const groups: TextSpan[][] = []
  let current: TextSpan[] = []
  let cursor = 0
  let previousEnd = -1
  for (const segment of segments) {
    // A segment's span excludes the whitespace before it, so a block start shows up in the gap
    // between the previous segment's end and this one's start rather than at its start exactly.
    let block = breaks[cursor]
    while (block !== undefined && block < previousEnd) {
      cursor += 1
      block = breaks[cursor]
    }
    const startsBlock = previousEnd >= 0 && block !== undefined && block <= segment.start
    if (current.length > 0 && (startsBlock || current.length >= maxSegments)) {
      groups.push(current)
      current = []
    }
    current.push(segment)
    previousEnd = segment.end
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/**
 * Find the line holding a reading-text offset.
 * @param lines - a section's lines in order.
 * @param offset - reading-text offset.
 * @returns the index of the last line starting at or before the offset, or -1 before the first line.
 */
export function lineAt(lines: readonly TextSpan[], offset: number): number {
  return lines.findLastIndex(line => line.start <= offset)
}

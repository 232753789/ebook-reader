import { describe, expect, it } from 'vitest'
import { lineAt, speechGroups, speechSegments, speechText } from '../src/client/reading-text.ts'

const slices = (text: string, spans: readonly { start: number; end: number }[]): string[] =>
  spans.map(span => text.slice(span.start, span.end))

describe('speech text', () => {
  it('collapses whitespace, drops it between CJK characters, and rejoins hyphenated words', () => {
    expect(speechText('  天色\n  已晚，\n他回家了。 ')).toBe('天色已晚，他回家了。')
    expect(speechText('The quick\n brown fox')).toBe('The quick brown fox')
    expect(speechText('an exam-\nple of hyphen-\n  ation')).toBe('an example of hyphenation')
    expect(speechText('中文 English 中文')).toBe('中文 English 中文')
    expect(speechText(' \n ')).toBe('')
  })
})

describe('speech segments', () => {
  it('splits at sentence terminators and keeps closing marks with their sentence', () => {
    const text = '他说：“走吧！”她没回答。Really? Yes. 3.14 is pi…'
    expect(slices(text, speechSegments(text, 0, 100))).toEqual([
      '他说：“走吧！”',
      '她没回答。',
      'Really?',
      'Yes.',
      '3.14 is pi…',
    ])
  })

  it('starts at the sentence holding the offset and clamps an offset past the end', () => {
    const text = '第一句话。第二句话。'
    expect(slices(text, speechSegments(text, 2, 100))).toEqual(['第一句话。', '第二句话。'])
    expect(slices(text, speechSegments(text, 5, 100))).toEqual(['第二句话。'])
    expect(speechSegments(text, 99, 100)).toEqual([])
    expect(slices(text, speechSegments(text, -5, 100))).toEqual(['第一句话。', '第二句话。'])
  })

  it('cuts at block starts and drops spans without a letter', () => {
    const text = '第一章\n  他醒了\n……\n32\n天亮了。'
    const breaks = [text.indexOf('他'), text.indexOf('…'), text.indexOf('32'), text.indexOf('天')]
    expect(slices(text, speechSegments(text, 0, 100, breaks))).toEqual(['第一章\n  ', '他醒了\n', '天亮了。'])
  })

  it('splits a long sentence at soft breaks, then spaces, then anywhere', () => {
    const soft = '甲乙丙丁，戊己庚辛，壬癸子丑。'
    expect(slices(soft, speechSegments(soft, 0, 8))).toEqual(['甲乙丙丁，', '戊己庚辛，', '壬癸子丑。'])
    const spaced = 'alpha beta gamma delta.'
    expect(slices(spaced, speechSegments(spaced, 0, 8))).toEqual(['alpha ', 'beta ', 'gamma ', 'delta.'])
    const solid = '一二三四五六七八九十'
    expect(slices(solid, speechSegments(solid, 0, 4))).toEqual(['一二三四', '五六七八', '九十'])
    const tail = 'abcdefghij'
    expect(slices(tail, speechSegments(tail, 0, 4))).toEqual(['abcd', 'efgh', 'ij'])
  })

})

describe('line lookup', () => {
  it('finds the last line starting at or before an offset', () => {
    const lines = [{ start: 0, end: 5 }, { start: 6, end: 10 }, { start: 11, end: 20 }]
    expect(lineAt(lines, 0)).toBe(0)
    expect(lineAt(lines, 5)).toBe(0)
    expect(lineAt(lines, 6)).toBe(1)
    expect(lineAt(lines, 99)).toBe(2)
    expect(lineAt([{ start: 3, end: 5 }], 1)).toBe(-1)
    expect(lineAt([], 0)).toBe(-1)
  })
})

describe('speech segments outside the body', () => {
  it('drops a segment meeting a span the section reports as something other than prose', () => {
    const text = '开头一句。31 def main():32 return 1收尾一句。'
    const skip = [{ start: 5, end: 30 }]
    expect(slices(text, speechSegments(text, 0, 50, [], skip))).toEqual(['开头一句。', '收尾一句。'])
    // Without the skip the listing is read like any other sentence.
    expect(slices(text, speechSegments(text, 0, 50))).toHaveLength(2)
  })
})

describe('speech groups', () => {
  it('groups a section\'s segments by the paragraph they came from', () => {
    const text = '第一句。第二句。\n第二段第一句。第二段第二句。\n第三段。'
    const breaks = [0, 8, 24]
    const segments = speechSegments(text, 0, 50, breaks)
    expect(segments.map(span => text.slice(span.start, span.end))).toEqual([
      '第一句。', '第二句。', '第二段第一句。', '第二段第二句。', '第三段。',
    ])
    expect(speechGroups(segments, breaks).map(group => group.map(span => text.slice(span.start, span.end)))).toEqual([
      ['第一句。', '第二句。'],
      ['第二段第一句。', '第二段第二句。'],
      ['第三段。'],
    ])
  })

  it('cuts a paragraph longer than one request into consecutive groups', () => {
    const text = '一。二。三。四。五。'
    const segments = speechSegments(text, 0, 50)
    expect(speechGroups(segments, [], 2).map(group => group.length)).toEqual([2, 2, 1])
    // Without block starts the whole section is one paragraph.
    expect(speechGroups(segments)).toHaveLength(1)
    expect(speechGroups([])).toEqual([])
  })

  it('starts a group at a block whose text begins with whitespace', () => {
    const text = '第一句。\n   第二段。'
    const breaks = [0, 5]
    const segments = speechSegments(text, 0, 50, breaks)
    expect(speechGroups(segments, breaks).map(group => group.length)).toEqual([1, 1])
  })
})

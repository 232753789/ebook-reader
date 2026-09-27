import { describe, expect, it } from 'vitest'
import { groupPdfLines, type PdfTextItem } from '../src/client/pdf-lines.ts'

/** A text item at baseline (x, y) of font size `size`, advancing `width`. */
function item(str: string, x: number, y: number, width: number, size = 10, hasEOL = false): PdfTextItem {
  return { str, transform: [size, 0, 0, size, x, y], width, hasEOL }
}

/** A page 800 points tall at scale 1: flip y, keep x. */
const flip = ([x1, y1, x2, y2]: [number, number, number, number]): number[] => [x1, 800 - y1, x2, 800 - y2]

describe('PDF line grouping', () => {
  it('joins items on one baseline and starts a line when the baseline moves', () => {
    const page = groupPdfLines([
      item('Hello', 50, 700, 25),
      item('world', 78, 700, 25),
      item('第二', 50, 685, 20),
      item('行', 70, 685, 10),
    ], flip)
    expect(page.text).toBe('Hello world\n第二行')
    expect(page.lines.map(line => page.text.slice(line.start, line.end))).toEqual(['Hello world', '第二行'])
    const box = page.lines[0]!.box
    expect([box.left, box.top, box.width, box.height].map(value => Math.round(value * 10) / 10)).toEqual([50, 91.2, 53, 11.2])
  })

  it('honors end-of-line marks, whitespace items, and a gap that is part of the line', () => {
    const page = groupPdfLines([
      item('one', 50, 700, 15, 10, true),
      item('two', 70, 700, 15),
      item(' ', 85, 700, 3),
      item('three', 88, 700, 25),
      item('', 0, 0, 0, 10, true),
      item('four', 50, 690, 20),
      item('   ', 70, 690, 5, 10, true),
      item('five', 50, 680, 20),
    ], flip)
    expect(page.text).toBe('one\ntwo three\nfour\nfive')
  })

  it('starts a line at a jump back to the left or across a column gutter', () => {
    const page = groupPdfLines([
      item('left column', 50, 700, 60),
      item('right column', 300, 700, 60),
      item('back', 40, 700, 20),
    ], flip)
    expect(page.lines.map(line => page.text.slice(line.start, line.end))).toEqual(['left column', 'right column', 'back'])
  })

  it('keeps neighbouring CJK runs unspaced and a trailing or leading space single', () => {
    const page = groupPdfLines([
      item('中文', 50, 700, 20),
      item('继续', 75, 700, 20),
      item('end ', 95, 700, 20),
      item('word', 125, 700, 20),
      item('x', 150, 700, 5),
      item(' y', 160, 700, 10),
    ], flip)
    expect(page.text).toBe('中文继续end word x y')
  })

  it('drops lines that are only whitespace and defaults a degenerate font size', () => {
    const page = groupPdfLines([
      { str: 'tiny', transform: [0, 0, 0, 0, 10, 10], width: 4, hasEOL: false },
    ], rect => rect)
    expect(page.lines).toHaveLength(1)
    expect(groupPdfLines([item('   ', 0, 0, 3)], flip)).toEqual({ text: '', lines: [], skip: [] })
  })

  it('tolerates a conversion that returns fewer coordinates', () => {
    const page = groupPdfLines([item('a', 1, 1, 1)], () => [])
    expect(page.lines[0]!.box).toEqual({ left: 0, top: 0, width: 0, height: 0 })
  })
})

describe('non-body lines', () => {
  /** Build a page of lines at 12pt spacing, `head`/`foot` placed in the margins. */
  const page = (texts: readonly string[], options: { head?: string; foot?: string } = {}) => {
    const items = []
    let y = 800
    if (options.head !== undefined) { items.push(item(options.head, 0, y, 10)); y -= 36 }
    for (const text of texts) { items.push(item(text, 0, y, 10)); y -= 12 }
    if (options.foot !== undefined) { y -= 36; items.push(item(options.foot, 0, y, 10)) }
    return groupPdfLines(items, flip)
  }
  const skipped = (grouped: ReturnType<typeof groupPdfLines>) =>
    grouped.skip.map(span => grouped.text.slice(span.start, span.end))

  it('skips a head printed as a title beside the page number, which the row is judged by', () => {
    const prose = ['提示链是一种把复杂任务拆开的范式。', '每一步的输出作为下一步的输入。', '这样更容易调试。']
    // The title and the page number sit on one row, far enough apart to group as separate lines.
    const grouped = groupPdfLines([
      item('实战代码示例', 0, 800, 10), item('25', 500, 800, 10),
      ...prose.map((text, at) => item(text, 0, 764 - at * 12, 10)),
    ], flip)
    expect(skipped(grouped)).toEqual(['实战代码示例', '25'])
  })

  it('skips a running head set apart from the text block, and one carrying the page number', () => {
    const prose = ['提示链模式概述', '提示链是一种把复杂任务拆开的范式。', '每一步的输出作为下一步的输入。', '这样更容易调试。']
    expect(skipped(page(prose, { head: '第 1 章：提示链' }))).toEqual(['第 1 章：提示链'])
    // A head that does not stand apart is still recognised by the page number it carries.
    expect(skipped(groupPdfLines(
      [item('14 第 1 章：提示链', 0, 800, 10), ...prose.map((text, at) => item(text, 0, 788 - at * 12, 10))],
      flip,
    ))).toEqual(['14 第 1 章：提示链'])
    // Body prose alone keeps every line.
    expect(skipped(groupPdfLines(prose.map((text, at) => item(text, 0, 800 - at * 12, 10)), flip))).toEqual([])
  })

  it('skips a running foot, and reads a lone line that carries no page number', () => {
    const prose = ['提示链模式概述', '提示链是一种把复杂任务拆开的范式。', '每一步的输出作为下一步的输入。', '这样更容易调试。']
    expect(skipped(page(prose, { foot: '第 1 章 12' }))).toEqual(['第 1 章 12'])
    // A page that is one printed row has no text block for a head to sit outside of.
    expect(skipped(groupPdfLines([item('提示链模式概述', 0, 800, 10)], flip))).toEqual([])
    expect(skipped(groupPdfLines([item('12 提示链模式概述', 0, 800, 10)], flip))).toEqual([])
  })

  it('skips a numbered listing and the wrapped lines inside it, but not a short numbered passage', () => {
    const grouped = page([
      '如上，代码演示了路由。',
      '31 def handler(request: str) -> str:',
      '32 print("委托给信息处理器")',
      '33 return f"已处理：{request}"',
      'unclear_handler(x["request"])),',
      '34 coordinator = Agent(',
      '这段代码定义了一个协调者。',
    ])
    expect(skipped(grouped)).toEqual([
      '31 def handler(request: str) -> str:',
      '32 print("委托给信息处理器")',
      '33 return f"已处理：{request}"',
      'unclear_handler(x["request"])),',
      '34 coordinator = Agent(',
    ])
    // Two runs that do not continue each other each need their own three lines.
    expect(skipped(page([
      '开头一句。', '10 alpha()', '11 beta()', '20 gamma()', '21 delta()', '22 epsilon()', '收尾一句。',
    ]))).toEqual(['20 gamma()', '21 delta()', '22 epsilon()'])
    // Two consecutive numbers are an ordinary passage, and a numbered list keeps its punctuation.
    expect(skipped(page(['1 第一点说明。', '2 第二点说明。', '收尾一句。', '另起一句。']))).toEqual([])
    expect(skipped(page(['1. 信息处理流程', '2. 复杂问答', '3. 数据提取与转换', '4. 内容生成流程']))).toEqual([])
  })
})

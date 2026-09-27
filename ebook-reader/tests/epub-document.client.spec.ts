// @vitest-environment jsdom
import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chapterText, openEpub, resolveArchivePath } from '../src/client/epub-document.ts'

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`

function packageDocument(options: { nav?: boolean; title?: string; spineToc?: boolean } = {}): string {
  return `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">${options.title === undefined ? '' : `<dc:title>${options.title}</dc:title>`}</metadata>
  <manifest>
    ${options.nav === false ? '' : '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'}
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="c1" href="text/chapter%201.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="lost" href="text/lost.xhtml" media-type="application/xhtml+xml"/>
    <item href="orphan.xhtml"/>
    <item id="escape" href="../../outside.xhtml"/>
    <item id="cover" href="images/cover.png" media-type="image/png"/>
    <item id="nohref"/>
    <item id="bare" href="text/bare.xhtml"/>
  </manifest>
  <spine${options.spineToc === false ? '' : ' toc="ncx"'}><itemref idref="c1"/><itemref idref="c2"/><itemref idref="lost"/><itemref idref="missing"/><itemref/><itemref idref="bare"/></spine>
</package>`
}

const NAV = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
  <nav epub:type="landmarks"><ol><li><a href="text/chapter2.xhtml">Landmark</a></li></ol></nav>
  <nav epub:type="toc"><ol>
    <li><a href="text/chapter%201.xhtml">第一章
      开端</a>
      <ol><li><a href="text/chapter2.xhtml#sec">第一节</a></li><li><span>无链接</span></li></ol>
    </li>
    <li><a href="https://example.com/">外部</a></li>
    <li><a href="text/absent.xhtml">不存在</a></li>
    <li><a href="text/chapter2.xhtml#">空锚点</a></li>
    <li><a href="../../../escape.xhtml">越界</a></li>
  </ol></nav>
</body></html>`

const NCX = `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>
  <navPoint><navLabel><text>NCX 第一章</text></navLabel><content src="text/chapter%201.xhtml"/>
    <navPoint><navLabel><text></text></navLabel><content src="text/chapter2.xhtml#sec"/></navPoint>
  </navPoint>
  <navPoint><navLabel><text>无目标</text></navLabel></navPoint>
  <navPoint><content src="text/bare.xhtml"/></navPoint>
  <navPoint><navLabel><text>书外</text></navLabel><content src="elsewhere.xhtml"/></navPoint>
</navMap></ncx>`

const CHAPTER_ONE = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink"><head><style>p{color:red}</style></head><body>
<h1 id="top" class="title" style="color:red">开端</h1>
<p>天色<b>已晚</b>。<a href="chapter2.xhtml#sec">下一节</a><a href="https://example.com">外链</a></p>
<img src="../images/cover.png"/><img src="../images/missing.png"/><img src="https://example.com/x.png"/><img/>
<svg><image xlink:href="../images/cover.png"/><image href="../images/nothing.png"/><image/><image href="https://example.com/i.png"/></svg>
<script>alert(1)</script><form><input/></form>
</body></html>`

const CHAPTER_TWO = '<html><body><p id="sec">第二章 <br>不是规范的 XHTML</p>'

function epub(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])))
}

function fullBook(options: Parameters<typeof packageDocument>[0] = {}): Record<string, string> {
  return {
    'META-INF/container.xml': CONTAINER,
    'OEBPS/content.opf': packageDocument(options),
    'OEBPS/nav.xhtml': NAV,
    'OEBPS/toc.ncx': NCX,
    'OEBPS/text/chapter 1.xhtml': CHAPTER_ONE,
    'OEBPS/text/chapter2.xhtml': CHAPTER_TWO,
    'OEBPS/text/bare.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><head/></html>',
    'OEBPS/images/cover.png': 'png',
    'outside.xhtml': 'escaped',
  }
}

let urls = 0
const revokeObjectURL = vi.fn<(url: string) => void>()
beforeEach(() => {
  urls = 0
  revokeObjectURL.mockClear()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => `blob:ebook/${String(++urls)}`) })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
})
afterEach(() => { vi.restoreAllMocks() })

describe('EPUB parsing', () => {
  it('reads the package title, the spine, and the EPUB 3 navigation document', () => {
    const book = openEpub(epub(fullBook({ title: '  暮色  ' })), 'fallback')
    expect(book.format).toBe('epub')
    expect(book.title).toBe('暮色')
    expect(book.sectionCount).toBe(3)
    expect(book.toc).toEqual([
      { label: '第一章 开端', depth: 0, section: 0 },
      { label: '第一节', depth: 1, section: 1, fragment: 'sec' },
      { label: '空锚点', depth: 0, section: 1 },
    ])
  })

  it('falls back to the library title and to the NCX table of contents', () => {
    const book = openEpub(epub(fullBook({ nav: false })), '备用书名')
    expect(book.title).toBe('备用书名')
    expect(book.toc).toEqual([
      { label: 'NCX 第一章', depth: 0, section: 0 },
      { label: '—', depth: 1, section: 1, fragment: 'sec' },
      { label: '—', depth: 0, section: 2 },
    ])
  })

  it('finds the NCX by media type when the spine names none, and reads a package at the archive root', () => {
    const files = { ...fullBook({ nav: false, spineToc: false }) }
    expect(openEpub(epub(files), 'x').toc.map(entry => entry.label)).toEqual(['NCX 第一章', '—', '—'])
    const rooted = {
      'META-INF/container.xml': CONTAINER.replace('OEBPS/content.opf', 'content.opf'),
      'content.opf': '<package><manifest><item id="a" href="a.xhtml"/></manifest><spine><itemref idref="a"/></spine></package>',
      'a.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>根目录</p></body></html>',
    }
    const book = openEpub(epub(rooted), 'x')
    expect(book.resolveHref(0, 'a.xhtml#p')).toEqual({ section: 0, fragment: 'p' })
  })

  it('sanitizes a chapter, turns archive images into object URLs, and marks external links', async () => {
    const book = openEpub(epub(fullBook()), 'book')
    const chapter = await book.section(0)
    const holder = document.createElement('div')
    holder.innerHTML = chapter.html
    expect(holder.querySelector('script, style, form, input')).toBeNull()
    expect(holder.querySelector('[style], [class]')).toBeNull()
    const images = [...holder.querySelectorAll('img')].map(image => image.getAttribute('src'))
    expect(images).toEqual(['blob:ebook/1', null, null, null])
    const svgImages = [...holder.querySelectorAll('image')].map(image => image.getAttribute('href'))
    expect(svgImages).toEqual(['blob:ebook/1', null, null, null])
    const links = [...holder.querySelectorAll('a')]
    expect(links.map(link => [link.getAttribute('href'), link.getAttribute('target')])).toEqual([
      ['chapter2.xhtml#sec', null],
      ['https://example.com', '_blank'],
    ])
    expect(chapter.text).toContain('开端')
    expect(chapter.text).toContain('天色已晚。下一节外链')
    expect(chapter.anchors).toEqual({ top: chapter.text.indexOf('开端') })
    expect(await book.section(0)).toBe(chapter)
    book.dispose()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:ebook/1')
  })

  it('parses a chapter that is not well-formed XHTML as HTML', async () => {
    const book = openEpub(epub(fullBook()), 'book')
    const chapter = await book.section(1)
    expect(chapter.text).toBe('第二章 不是规范的 XHTML')
    expect(chapter.anchors).toEqual({ sec: 0 })
    expect(chapter.breaks).toEqual([4])
  })

  it('reads a chapter without a body as empty', async () => {
    const book = openEpub(epub(fullBook()), 'book')
    expect(await book.section(2)).toMatchObject({ html: '', text: '', breaks: [], anchors: {} })
  })

  it('rejects a section index outside the spine', async () => {
    const book = openEpub(epub(fullBook()), 'book')
    await expect(book.section(7)).rejects.toThrow('ebook-reader: the EPUB has no section 7')
  })

  it('resolves links within the book and leaves external ones alone', () => {
    const book = openEpub(epub(fullBook()), 'book')
    expect(book.resolveHref(0, 'chapter2.xhtml#sec')).toEqual({ section: 1, fragment: 'sec' })
    expect(book.resolveHref(1, '#sec')).toEqual({ section: 1, fragment: 'sec' })
    expect(book.resolveHref(1, 'chapter%201.xhtml')).toEqual({ section: 0 })
    expect(book.resolveHref(0, 'https://example.com')).toBeUndefined()
    expect(book.resolveHref(9, '#sec')).toBeUndefined()
    expect(book.resolveHref(0, 'nowhere.xhtml')).toBeUndefined()
    expect(book.resolveHref(0, '../../../escape.xhtml')).toBeUndefined()
  })

  it('fails loud on a malformed archive', () => {
    expect(() => openEpub(epub({ 'mimetype': 'application/epub+zip' }), 'x')).toThrow('the EPUB has no META-INF/container.xml')
    expect(() => openEpub(epub({ 'META-INF/container.xml': '<container' }), 'x')).toThrow('container is not well-formed XML')
    expect(() => openEpub(epub({ 'META-INF/container.xml': '<container/>' }), 'x')).toThrow('names no package document')
    expect(() => openEpub(epub({ 'META-INF/container.xml': CONTAINER, 'OEBPS/content.opf': '<package' }), 'x'))
      .toThrow('package document is not well-formed XML')
    expect(() => openEpub(epub({ 'META-INF/container.xml': CONTAINER, 'OEBPS/content.opf': '<package><spine/></package>' }), 'x'))
      .toThrow('spine lists no readable chapter')
  })

  it('tolerates a navigation document that is not XML and one without a list', () => {
    const broken = { ...fullBook(), 'OEBPS/nav.xhtml': '<html><nav>' }
    expect(openEpub(epub(broken), 'x').toc.map(entry => entry.label)).toEqual(['NCX 第一章', '—', '—'])
    const listless = { ...fullBook(), 'OEBPS/nav.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><body><nav/></body></html>' }
    expect(openEpub(epub(listless), 'x').toc.map(entry => entry.label)).toEqual(['NCX 第一章', '—', '—'])
    const navless = { ...fullBook(), 'OEBPS/nav.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>' }
    expect(openEpub(epub(navless), 'x').toc).toHaveLength(3)
    const { 'OEBPS/toc.ncx': _ncx, 'OEBPS/nav.xhtml': _nav, ...bare } = fullBook()
    expect(openEpub(epub(bare), 'x').toc).toEqual([])
    const badNcx = { ...fullBook({ nav: false }), 'OEBPS/toc.ncx': '<ncx' }
    expect(openEpub(epub(badNcx), 'x').toc).toEqual([])
  })
})

describe('EPUB helpers', () => {
  it('resolves archive paths, decoding percent escapes and refusing to climb above the root', () => {
    expect(resolveArchivePath('OEBPS/text/', '../images/a%20b.png')).toBe('OEBPS/images/a b.png')
    expect(resolveArchivePath('', './a/./b')).toBe('a/b')
    expect(resolveArchivePath('OEBPS/', '%E0%A4%A')).toBe('OEBPS/%E0%A4%A')
    expect(resolveArchivePath('', '../a')).toBeUndefined()
  })

  it('computes reading text, block starts, and first element-id offsets', () => {
    const text = chapterText('<h2 id="h">标题</h2><p id="p">段落<span id="h">重复</span></p><p></p><div><p>嵌套</p></div>')
    expect(text.text).toBe('标题段落重复嵌套')
    expect(text.breaks).toEqual([2, 6])
    expect(text.anchors).toEqual({ h: 0, p: 2 })
    expect(text.skip).toEqual([])
  })

  it('marks the text of code elements so read-aloud skips it', () => {
    // The listing holds two text nodes around an inline element, which join into one span.
    const text = chapterText('<p>如下所示<code>invoke()</code>返回结果。</p><pre>def <b>main</b>():</pre><p>说明。</p>')
    expect(text.text).toBe('如下所示invoke()返回结果。def main():说明。')
    // Adjacent text nodes of one element join into a single span.
    expect(text.skip).toEqual([{ start: 4, end: 12 }, { start: 17, end: 28 }])
    expect(text.skip.map(span => text.text.slice(span.start, span.end))).toEqual(['invoke()', 'def main():'])
  })
})

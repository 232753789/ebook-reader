/** EPUB 2/3 documents: container and package parsing, table of contents, and sanitized chapters. */

import DOMPurify from 'dompurify'
import { strFromU8, unzipSync } from 'fflate/browser'
import type { EpubBook, EpubSection, TocEntry } from './book.ts'
import type { TextSpan } from './reading-text.ts'

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
}

/** Elements whose text starts a new block: read-aloud never joins text across their start. */
/** Elements whose text is code rather than prose; read-aloud skips what they hold. */
const CODE_SELECTOR = 'code, kbd, pre, samp, var'

const BLOCK_ELEMENTS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table',
  'td', 'th', 'tr', 'ul',
])

/** Markup the reader never renders: scripts, forms, embedded documents, and publisher styling. */
const FORBID_TAGS = ['script', 'style', 'link', 'meta', 'form', 'input', 'button', 'select', 'textarea', 'iframe', 'object', 'embed', 'audio', 'video']
const FORBID_ATTR = ['style', 'class', 'width', 'height']

const XLINK = 'http://www.w3.org/1999/xlink'
const EPUB_OPS = 'http://www.idpf.org/2007/ops'

interface ManifestItem {
  readonly href: string
  readonly mediaType: string
  readonly properties: readonly string[]
}

function parseXml(text: string, type: DOMParserSupportedType): Document | undefined {
  const document = new DOMParser().parseFromString(text, type)
  return document.getElementsByTagName('parsererror').length > 0 ? undefined : document
}

function requireXml(text: string, what: string): Document {
  const document = parseXml(text, 'application/xml')
  if (document === undefined) throw new Error(`ebook-reader: the EPUB ${what} is not well-formed XML`)
  return document
}

/** Elements by local name, ignoring namespace prefixes (`dc:title`, `opf:item`). */
function byLocalName(root: Document | Element, name: string): Element[] {
  return [...root.getElementsByTagName('*')].filter(element => element.localName === name)
}

function directoryOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash + 1)
}

/**
 * Resolve a relative reference against a directory inside the archive.
 * @param directory - archive directory ending in `/`, or empty for the root.
 * @param reference - relative URL path, percent-encoded as in the markup.
 * @returns the archive path, or undefined when the reference climbs above the root.
 */
export function resolveArchivePath(directory: string, reference: string): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(reference)
  } catch {
    decoded = reference
  }
  const parts: string[] = []
  for (const part of `${directory}${decoded}`.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.pop() === undefined) return undefined
      continue
    }
    parts.push(part)
  }
  return parts.join('/')
}

function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href)
}

function splitHref(href: string): { path: string; fragment?: string } {
  const hash = href.indexOf('#')
  if (hash === -1) return { path: href }
  const fragment = href.slice(hash + 1)
  return fragment === '' ? { path: href.slice(0, hash) } : { path: href.slice(0, hash), fragment }
}

/**
 * Compute the reading text of sanitized chapter markup the way the view's text-node walk sees it.
 * @param html - sanitized body markup.
 * @returns the text, block starts, and element-id offsets.
 */
export function chapterText(html: string): Pick<EpubSection, 'text' | 'breaks' | 'anchors' | 'skip'> {
  const container = document.implementation.createHTMLDocument('').createElement('div')
  container.innerHTML = html
  let text = ''
  const breaks: number[] = []
  const anchors: Record<string, number> = {}
  const skip: TextSpan[] = []
  const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      const data = (node as Text).data
      if (node.parentElement?.closest(CODE_SELECTOR) != null) {
        const previous = skip.at(-1)
        const span = { start: text.length, end: text.length + data.length }
        // Text nodes of one code element are adjacent, so their spans join into one.
        if (previous !== undefined && previous.end === span.start) skip[skip.length - 1] = { start: previous.start, end: span.end }
        else skip.push(span)
      }
      text += data
      continue
    }
    const element = node as Element
    if (BLOCK_ELEMENTS.has(element.localName) && text.length > 0 && breaks.at(-1) !== text.length) breaks.push(text.length)
    if (element.id !== '' && anchors[element.id] === undefined) anchors[element.id] = text.length
  }
  return { text, breaks, anchors, skip }
}

/**
 * Parse an EPUB archive.
 * @param bytes - the complete `.epub` file.
 * @param title - the library title, used when the package names none.
 * @returns the opened book.
 */
export function openEpub(bytes: Uint8Array, title: string): EpubBook {
  const files = unzipSync(bytes)
  const read = (path: string): Uint8Array => {
    const file = files[path]
    if (file === undefined) throw new Error(`ebook-reader: the EPUB has no ${path}`)
    return file
  }
  const container = requireXml(strFromU8(read('META-INF/container.xml')), 'container')
  const packagePath = byLocalName(container, 'rootfile')[0]?.getAttribute('full-path')
  if (packagePath === undefined || packagePath === null || packagePath === '') {
    throw new Error('ebook-reader: the EPUB container names no package document')
  }
  const opf = requireXml(strFromU8(read(packagePath)), 'package document')
  const packageDirectory = directoryOf(packagePath)
  const manifest = new Map<string, ManifestItem>()
  for (const item of byLocalName(opf, 'item')) {
    const id = item.getAttribute('id')
    const href = item.getAttribute('href')
    const path = href === null ? undefined : resolveArchivePath(packageDirectory, href)
    if (id === null || path === undefined) continue
    manifest.set(id, {
      href: path,
      mediaType: item.getAttribute('media-type') ?? '',
      properties: (item.getAttribute('properties') ?? '').split(/\s+/).filter(Boolean),
    })
  }
  const spineElement = byLocalName(opf, 'spine')[0]
  const spine = byLocalName(opf, 'itemref')
    .map(reference => manifest.get(reference.getAttribute('idref') ?? ''))
    .filter((item): item is ManifestItem => item !== undefined && files[item.href] !== undefined)
  if (spine.length === 0) throw new Error('ebook-reader: the EPUB spine lists no readable chapter')
  const sectionOfPath = new Map(spine.map((item, index) => [item.href, index]))
  const packageTitle = byLocalName(opf, 'title')[0]?.textContent.trim()

  const tocTarget = (base: string, href: string, label: string, depth: number): TocEntry | undefined => {
    const { path, fragment } = splitHref(href)
    const resolved = resolveArchivePath(base, path)
    const section = resolved === undefined ? undefined : sectionOfPath.get(resolved)
    if (section === undefined) return undefined
    const entry = { label: label.replace(/\s+/g, ' ').trim() || '—', depth, section }
    return fragment === undefined ? entry : { ...entry, fragment }
  }

  const toc: TocEntry[] = []
  const navItem = [...manifest.values()].find(item => item.properties.includes('nav'))
  const navFile = navItem === undefined ? undefined : files[navItem.href]
  const navDocument = navFile === undefined ? undefined : parseXml(strFromU8(navFile), 'application/xhtml+xml')
  if (navItem !== undefined && navDocument !== undefined) {
    const navs = byLocalName(navDocument, 'nav')
    const tocNav = navs.find(nav => (nav.getAttributeNS(EPUB_OPS, 'type') ?? nav.getAttribute('epub:type') ?? '').split(/\s+/).includes('toc')) ?? navs[0]
    const walk = (list: Element, depth: number): void => {
      for (const item of [...list.children].filter(child => child.localName === 'li')) {
        const anchor = [...item.children].find(child => child.localName === 'a' || child.localName === 'span')
        const href = anchor?.getAttribute('href')
        if (anchor !== undefined && href !== null && href !== undefined) {
          // An element's textContent is always a string.
          const entry = tocTarget(directoryOf(navItem.href), href, anchor.textContent, depth)
          if (entry !== undefined) toc.push(entry)
        }
        const nested = [...item.children].find(child => child.localName === 'ol')
        if (nested !== undefined) walk(nested, depth + 1)
      }
    }
    const root = tocNav === undefined ? undefined : [...tocNav.children].find(child => child.localName === 'ol')
    if (root !== undefined) walk(root, 0)
  }
  const ncxItem = manifest.get(spineElement?.getAttribute('toc') ?? '')
    ?? [...manifest.values()].find(item => item.mediaType === 'application/x-dtbncx+xml')
  const ncxFile = ncxItem === undefined ? undefined : files[ncxItem.href]
  if (toc.length === 0 && ncxItem !== undefined && ncxFile !== undefined) {
    const ncx = parseXml(strFromU8(ncxFile), 'application/xml')
    const walk = (parent: Element, depth: number): void => {
      for (const point of [...parent.children].filter(child => child.localName === 'navPoint')) {
        const label = byLocalName(point, 'text')[0]?.textContent ?? ''
        const src = [...point.children].find(child => child.localName === 'content')?.getAttribute('src')
        if (src !== null && src !== undefined) {
          const entry = tocTarget(directoryOf(ncxItem.href), src, label, depth)
          if (entry !== undefined) toc.push(entry)
        }
        walk(point, depth + 1)
      }
    }
    const navMap = ncx === undefined ? undefined : byLocalName(ncx, 'navMap')[0]
    if (navMap !== undefined) walk(navMap, 0)
  }

  const objectUrls = new Map<string, string>()
  const objectUrl = (path: string): string | undefined => {
    const known = objectUrls.get(path)
    if (known !== undefined) return known
    const file = files[path]
    const media = MEDIA_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()]
    if (file === undefined || media === undefined) return undefined
    const url = URL.createObjectURL(new Blob([file], { type: media }))
    objectUrls.set(path, url)
    return url
  }

  const sections = new Map<number, EpubSection>()
  const loadSection = (index: number): EpubSection => {
    const item = spine[index]
    // A saved position can outlive the chapter list of a book that was replaced on disk.
    if (item === undefined) throw new Error(`ebook-reader: the EPUB has no section ${String(index)}`)
    const source = strFromU8(read(item.href))
    const parsed = parseXml(source, 'application/xhtml+xml') ?? new DOMParser().parseFromString(source, 'text/html')
    const body = parsed.getElementsByTagName('body')[0]
    // SVG 2 `href` replaces `xlink:href`, whose prefix does not survive serializing the body alone.
    for (const image of body?.getElementsByTagName('image') ?? []) {
      const href = image.getAttributeNS(XLINK, 'href')
      if (href === null) continue
      image.removeAttributeNS(XLINK, 'href')
      image.setAttribute('href', href)
    }
    const fragment = DOMPurify.sanitize(body?.innerHTML ?? '', {
      USE_PROFILES: { html: true, svg: true },
      FORBID_TAGS,
      FORBID_ATTR,
      RETURN_DOM_FRAGMENT: true,
    })
    const chapterDirectory = directoryOf(item.href)
    // Sanitizing first keeps the archive-relative references; only then do they become blob URLs.
    for (const image of fragment.querySelectorAll('img')) {
      const src = image.getAttribute('src')
      const path = src === null || isExternal(src) ? undefined : resolveArchivePath(chapterDirectory, src)
      const url = path === undefined ? undefined : objectUrl(path)
      if (url === undefined) image.removeAttribute('src')
      else image.setAttribute('src', url)
    }
    for (const image of fragment.querySelectorAll('image')) {
      const href = image.getAttribute('href')
      const path = href === null || isExternal(href) ? undefined : resolveArchivePath(chapterDirectory, href)
      const url = path === undefined ? undefined : objectUrl(path)
      if (url === undefined) image.removeAttribute('href')
      else image.setAttribute('href', url)
    }
    for (const anchor of fragment.querySelectorAll('a[href]')) {
      const href = anchor.getAttribute('href')
      if (href !== null && isExternal(href)) {
        anchor.setAttribute('target', '_blank')
        anchor.setAttribute('rel', 'noopener noreferrer')
      }
    }
    const holder = document.createElement('div')
    holder.append(fragment)
    const html = holder.innerHTML
    return { kind: 'epub', html, ...chapterText(html) }
  }

  return {
    format: 'epub',
    title: packageTitle === undefined || packageTitle === '' ? title : packageTitle,
    sectionCount: spine.length,
    toc,
    // Parsing runs inside the promise chain, so a malformed chapter rejects instead of throwing.
    section: index => Promise.resolve().then(() => {
      let section = sections.get(index)
      if (section === undefined) {
        section = loadSection(index)
        sections.set(index, section)
      }
      return section
    }),
    resolveHref: (from, href) => {
      const origin = spine[from]
      if (origin === undefined || isExternal(href)) return undefined
      const { path, fragment } = splitHref(href)
      const section = path === ''
        ? from
        : sectionOfPath.get(resolveArchivePath(directoryOf(origin.href), path) ?? '')
      if (section === undefined) return undefined
      return fragment === undefined ? { section } : { section, fragment }
    },
    dispose: () => {
      for (const url of objectUrls.values()) URL.revokeObjectURL(url)
      objectUrls.clear()
    },
  }
}

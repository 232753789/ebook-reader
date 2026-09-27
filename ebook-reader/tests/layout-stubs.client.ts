/**
 * A minimal layout for jsdom: observer stubs driven by the test, a sized scroller, and page offsets
 * derived from inline heights, so the PDF and EPUB views can be exercised without a browser.
 */

import { vi } from 'vitest'

/** Live ResizeObserver callbacks. */
const resizeObservers = new Set<() => void>()
/** Live IntersectionObserver instances and the elements each observes. */
const intersectionObservers = new Set<{ callback: IntersectionObserverCallback; observed: Set<Element> }>()

class ResizeObserverStub {
  private readonly run: () => void
  constructor(callback: ResizeObserverCallback) {
    this.run = () => { callback([], this) }
  }

  observe(): void { resizeObservers.add(this.run) }
  unobserve(): void {}
  disconnect(): void { resizeObservers.delete(this.run) }
}

class IntersectionObserverStub {
  private readonly entry: { callback: IntersectionObserverCallback; observed: Set<Element> }
  constructor(callback: IntersectionObserverCallback) {
    this.entry = { callback, observed: new Set() }
    intersectionObservers.add(this.entry)
  }

  observe(element: Element): void { this.entry.observed.add(element) }
  unobserve(): void {}
  disconnect(): void { intersectionObservers.delete(this.entry) }
}

/**
 * Report which observed elements intersect.
 * @param visible - decides for each observed element.
 */
export function intersect(visible: (element: HTMLElement) => boolean): void {
  for (const { callback, observed } of intersectionObservers) {
    const entries = [...observed].map(target => ({ target, isIntersecting: visible(target as HTMLElement) }))
    callback(entries as unknown as IntersectionObserverEntry[], {} as IntersectionObserver)
  }
}

/** Fire every live ResizeObserver. */
export function resize(): void {
  for (const run of [...resizeObservers]) run()
}

const scrollTops = new WeakMap<Element, number>()
/** Every `scrollTo` call, in order. */
export const scrolls: { element: Element; top: number; behavior: string | undefined }[] = []
/** Scroller box size in CSS pixels. */
export const viewport = { width: 648, height: 600 }
/** Vertical gap between PDF pages, matching `margin-bottom` of `.page`. */
const PAGE_GAP = 16

function isScroller(element: Element): boolean {
  return element.getAttribute('data-testid') === 'pdf-view' || element.getAttribute('data-testid') === 'epub-view'
}

const STUBBED = ['clientWidth', 'clientHeight', 'offsetHeight', 'offsetTop', 'scrollTop', 'scrollTo'] as const
const originals = new Map<string, PropertyDescriptor | undefined>()

/** Install the stubs; call from `beforeEach`. */
export function installLayout(): void {
  for (const name of STUBBED) originals.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name))
  resizeObservers.clear()
  intersectionObservers.clear()
  scrolls.length = 0
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => { callback(0) }, 0) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => { clearTimeout(handle) })
  const define = (name: string, get: (this: HTMLElement) => number, set?: (this: HTMLElement, value: number) => void) => {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get, ...set === undefined ? {} : { set } })
  }
  define('clientWidth', function () { return isScroller(this) ? viewport.width : 0 })
  define('clientHeight', function () { return isScroller(this) ? viewport.height : 0 })
  define('offsetHeight', function () { return Number.parseFloat(this.style.height) || 0 })
  define('offsetTop', function () {
    if (this.dataset.page !== undefined) {
      let top = 0
      let sibling = this.previousElementSibling as HTMLElement | null
      for (; sibling !== null; sibling = sibling.previousElementSibling as HTMLElement | null) {
        top += (Number.parseFloat(sibling.style.height) || 0) + PAGE_GAP
      }
      return top
    }
    return Number(this.dataset.offsetTop ?? 0)
  })
  define('scrollTop', function () { return scrollTops.get(this) ?? 0 }, function (value) { scrollTops.set(this, value) })
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value(this: HTMLElement, options: ScrollToOptions) {
      scrolls.push({ element: this, top: options.top!, behavior: options.behavior })
      scrollTops.set(this, options.top!)
    },
  })
}

/** Restore jsdom's own properties; call from `afterEach`. */
export function removeLayout(): void {
  vi.unstubAllGlobals()
  for (const name of STUBBED) {
    const original = originals.get(name)
    if (original === undefined) Reflect.deleteProperty(HTMLElement.prototype, name)
    else Object.defineProperty(HTMLElement.prototype, name, original)
  }
}

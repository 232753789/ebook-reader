import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as EbookReader from '../src/index.ts'
import type { BookList, ReaderCapabilities } from '../src/types.ts'
import { modelDirectory, tempRoot } from './fixtures.ts'

class SubprocessFixture extends Service {
  constructor(ctx: Context) {
    super(ctx, 'subprocess')
  }
}

async function boot(directory: string, configPath: string): Promise<Context> {
  const booted = new Context()
  booted.baseUrl = pathToFileURL(directory).href + '/'
  await booted.plugin(Loader)
  booted.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@test/subprocess', SubprocessFixture],
    ['@deepseek-ai/dsh-ebook-reader', EbookReader],
  ])
  booted.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof booted.loader.internal>
  await booted.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await booted.loader.await()
  return booted
}

let root: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('ebook-reader real Loader composition', () => {
  it('boots the Host plugin from cordis.yml, lists the library, and releases its route on disposal', async () => {
    root = await tempRoot('ebook-reader-loader-')
    await mkdir(join(root, 'books'))
    await writeFile(join(root, 'books', '朝花夕拾.epub'), 'epub')
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-host-webserver'",
      '  config:',
      '    host: 127.0.0.1',
      '    port: 0',
      "- name: '@test/subprocess'",
      "- name: '@deepseek-ai/dsh-ebook-reader'",
      '  config:',
      `    libraryRoot: ${JSON.stringify(join(root, 'books'))}`,
      `    storageRoot: ${JSON.stringify(join(root, 'storage'))}`,
      '',
    ].join('\n'))

    ctx = await boot(root, configPath)
    expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])

    const url = `http://127.0.0.1:${String(ctx.webServer.port)}/ebook-reader/api/books`
    const listing = await (await fetch(url)).json() as BookList
    expect(listing.books.map(book => book.title)).toEqual(['朝花夕拾'])

    await ctx.fiber.dispose()
    ctx = undefined
    await expect(fetch(url)).rejects.toThrow()
  })

  it('advertises read-aloud when composed over a complete CustomVoice model', async () => {
    root = await tempRoot('ebook-reader-loader-')
    const model = await modelDirectory(root)
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-host-webserver'",
      '  config:',
      '    host: 127.0.0.1',
      '    port: 0',
      "- name: '@test/subprocess'",
      "- name: '@deepseek-ai/dsh-ebook-reader'",
      '  config:',
      `    libraryRoot: ${JSON.stringify(join(root, 'books'))}`,
      `    storageRoot: ${JSON.stringify(join(root, 'storage'))}`,
      '    speechMode: local',
      `    speechModelPath: ${JSON.stringify(model)}`,
      '',
    ].join('\n'))
    ctx = await boot(root, configPath)
    const capabilities = await (await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}/ebook-reader/api/capabilities`)).json() as ReaderCapabilities
    expect(capabilities.speech).toMatchObject({ enabled: true, defaultVoice: 'serena' })
  })

  it('fails the load when read-aloud points at a missing model', () => {
    expect(() => { EbookReader.apply({} as Context, { speechMode: 'local', speechModelPath: '/nonexistent/qwen3-tts' }) })
      .toThrow('speechModelPath is not a directory: /nonexistent/qwen3-tts')
  })
})

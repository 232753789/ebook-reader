# ebook-reader

**Read local PDF / EPUB books inside the DSH Web GUI, with line-by-line tracking and read-aloud from a local Qwen3-TTS model.**

English | [中文](README.zh.md)

ebook-reader is an optional plugin for the Web GUI of [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). Once installed, a **Library** tab appears beside **Sessions** in the sidebar. It lists the PDF and EPUB files in a local directory; clicking a book opens it in the center column in place of the conversation (which stays mounted in the background). The reader keeps a highlighted reading line, remembers each book's position, and can read the book aloud with a Qwen3-TTS model running on your own machine, boxing each sentence as it plays.

Everything stays local: book files, reading progress, and synthesized audio never leave the machine, and nothing is sent to a large-model request. The plugin depends on no other optional plugin.

## Features

- **Local library** — recursively scans a directory (default `~/Documents/Books`) for `.pdf` and `.epub` files, skips hidden entries and symbolic links, sorts by path in Chinese collation, and shows each book's progress.
- **PDF reading** — renders pages with PDF.js, supports zoom (50%–300% of fit-to-width), page jumps, and the document outline.
- **EPUB reading** — renders chapters as sanitized markup (DOMPurify), supports text-size adjustment, chapter navigation, and the table of contents.
- **Line tracking** — click a line or use `↓`/`j` and `↑`/`k` to move the reading line, crossing page and chapter edges; when scrolling stops the reading line follows the first visible line.
- **Per-book progress** — the position is saved automatically one second after it last moved and when the page is hidden, so the next open resumes where you left off.
- **Local read-aloud** — synthesizes sentence by sentence with [Qwen3-TTS-12Hz-1.7B-CustomVoice](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice); pick any speaker the model declares, a reading style (Technical, Paper, Popular science, Humanities, Fiction, …), and a speed of 0.75×–2×.
- **Smart text extraction** — reads body prose only: skips code blocks in EPUBs, and uses heuristics to recognise running heads/feet and line-numbered code listings in PDFs.
- **Smooth playback** — prefetches upcoming paragraphs, starts the first request with a single sentence to cut the wait, plays in text order whatever order audio arrives in, and caches synthesized audio as FLAC.
- **Stable timbre** — optionally anchors a voice on a reference recording and its transcript (`speechVoicePrompts`) so consecutive sentences don't drift in timbre.
- **Bilingual UI** — ships Chinese and English copy.

## How it works

```text
┌──────────────────────────── Browser (Web GUI) ────────────────────────────┐
│  Library sidebar tab ─┬─ Reader main view (PdfView / EpubView)            │
│                       └─ SpeechPlayer (sentence split, prefetch, playback) │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │  /ebook-reader/api (loopback, same-origin only)
┌───────────────────────────────┴────── Host (Node) ─────────────────────────┐
│  Library scan · book file serving (byte ranges) · PDF.js distribution      │
│  Reading-progress storage · speech cache (LRU pruning)                      │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │  NDJSON over stdin/stdout
┌───────────────────────────────┴──── Python TTS worker ─────────────────────┐
│  qwen-tts + Qwen3-TTS CustomVoice · CUDA → MPS → CPU · idle shutdown        │
└────────────────────────────────────────────────────────────────────────────┘
```

- **Browser half** (`src/client/`): React components and controllers; registers a `sidebar.tab` entry and a `main.view` entry.
- **Host half** (`src/`): a Cordis plugin that registers the `/ebook-reader/api` route family on the Web server and manages the TTS subprocess.
- **TTS worker** (`python/tts_worker.py`): a persistent process that loads the model on the first request and exits after a period without requests.

## Quick start

### Requirements

- A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) checkout with its Web GUI
- Node.js and pnpm
- (Read-aloud only) Python 3, a Qwen3-TTS model directory, and preferably a CUDA or Apple Silicon (MPS) accelerator

### 1. Build the plugin

```bash
cd ebook-reader
pnpm install
pnpm run build
```

### 2. Register it into the Web profile

From the DeepSeek Harness repository:

```bash
pnpm dsh plugin --profile web add <path-to-this-repo>/ebook-reader
pnpm dsh web
```

Open the Web GUI and click the Library tab in the sidebar. To uninstall:

```bash
pnpm dsh plugin --profile web remove @deepseek-ai/dsh-ebook-reader
```

### 3. (Optional) Enable read-aloud

Read-aloud is off by default. Create a separate Python environment for `qwen-tts` (it pins its own `transformers`) and download the model:

```bash
python3 -m venv ~/.dsh/venvs/ebook-reader
~/.dsh/venvs/ebook-reader/bin/python -m pip install -U qwen-tts soundfile
hf download Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice \
  --local-dir ~/.dsh/models/Qwen3-TTS-12Hz-1.7B-CustomVoice
```

Then enable it in `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- id: ebook-reader
  config:
    libraryRoot: ~/Documents/Books
    speechMode: local
    pythonExecutable: ~/.dsh/venvs/ebook-reader/bin/python
    speechLanguage: Chinese
    defaultVoice: serena
```

> A profile override replaces the row's complete `config`; see [`cordis.patch.yml`](ebook-reader/cordis.patch.yml) for the defaults of every field.

With `speechMode: local`, the Host validates the model directory at startup (`tts_model_type` must be `custom_voice`, and the weights, tokenizer, and `speech_tokenizer/` files must be complete) and fails the plugin load if anything is missing.

## Main settings

| Setting | Default | Description |
|---|---|---|
| `libraryRoot` | `~/Documents/Books` | Library directory |
| `storageRoot` | `$DSH_HOME/ebook-reader` | Storage for progress and the speech cache |
| `listMaxBooks` | `2000` | Maximum number of books listed |
| `speechMode` | `off` | `off` or `local` |
| `speechModelPath` | `$DSH_HOME/models/Qwen3-TTS-12Hz-1.7B-CustomVoice` | Model directory, or the Hugging Face cache directory |
| `pythonExecutable` | `python3` | Python interpreter that runs the TTS worker |
| `speechDevice` | `auto` | `auto` / `cuda` / `mps` / `cpu` |
| `speechLanguage` | `Auto` | Synthesis language |
| `defaultVoice` | first speaker of the model | Default speaker |
| `speechDecoding` | `talker-sampled` | Decoding mode; `fully-sampled` varies more between generations |
| `speechVoicePrompts` | — | Reference recording and transcript that anchor a voice's timbre |
| `speechCacheMaxBytes` | 1 GiB | Speech cache limit, pruned least-recently-used first |
| `speechIdleShutdownMs` | 10 minutes | Idle time before the worker exits |

For every setting, the read-aloud pipeline, the HTTP API, and measured data, see the [package README](ebook-reader/README.md).

## Repository layout

```text
.
├── README.md / README.zh.md          # this page
└── ebook-reader/                     # plugin package @deepseek-ai/dsh-ebook-reader
    ├── README.md / README.zh.md      # full package documentation
    ├── cordis.patch.yml              # default configuration of the bundle
    ├── src/                          # Host half: config, library scan, progress, HTTP routes, speech scheduling
    │   └── client/                   # Browser half: library panel, PDF/EPUB views, speech player
    ├── python/tts_worker.py          # Qwen3-TTS NDJSON worker
    ├── tests/                        # Vitest specs (Host and client)
    └── tsdown.config.ts              # build config for the Host ESM and client bundles
```

## Development

- `pnpm run build` — type-check the Host and client, then bundle into `lib/` with tsdown
- `pnpm run watch` — rebuild on change
- TypeScript specs live in `ebook-reader/tests/` and run under Vitest
- Python worker tests need neither torch nor the model weights: `python3 -m pytest ebook-reader/python`

## Known limitations

- Scanned PDFs have no text layer and cannot be read aloud or highlighted (no OCR).
- PDF lines follow the content-stream order; complex layouts may read out of order.
- EPUB publisher styling is not applied; fixed-layout and vertical-writing layouts are not supported.
- The highlight is sentence-granular and does not follow the voice word by word.
- Progress is keyed by file path, so moving or renaming a book starts it over.
- Only loopback (localhost) access is supported; a Web GUI reached through a LAN address cannot use this plugin.

See the [package README](ebook-reader/README.md#known-limitations-and-deferred-work) for the full list.

## License

[MIT](ebook-reader/package.json)

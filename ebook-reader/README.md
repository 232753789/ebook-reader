# @deepseek-ai/dsh-ebook-reader

English | [中文](README.zh.md)

Optional Web profile bundle for reading local ebooks. The browser half adds a Library tab beside Sessions in the sidebar and a reader in the center column: the tab lists the `.pdf` and `.epub` files under a local directory with each book's progress, and clicking a book opens it in place of the conversation. The reader renders PDF pages with PDF.js and EPUB chapters as sanitized markup, highlights the line being read, and saves the position of every book. Read-aloud synthesizes the text sentence by sentence with a local Qwen3-TTS CustomVoice model, lets the reader choose any speaker the model declares, and boxes each sentence as it plays. The Host half lists the library, serves book files and the PDF.js distribution, stores progress, and runs the TTS worker. This package does not change `agent-loop`, sends nothing to a model, and is not added to the shipped Web profile.

## Build this plugin on its own

This package is a self-contained plugin project. Two TypeScript project builds and one bundle produce everything a profile install needs.

```bash
pnpm install
pnpm run build
```

The sidebar tab and the center-column view use the `sidebar.tab` slot of `@deepseek-ai/dsh-client-ui-sidebar` and the `main.view` slot of `@deepseek-ai/dsh-client-ui-layout`; the DSH Web app carries both.

## Register it into a profile

Run these from a DeepSeek Harness checkout, pointing at this package directory:

```bash
pnpm dsh plugin --profile web add <path-to-this-repo>/ebook-reader
pnpm dsh web
```

Remove the row with `pnpm dsh plugin --profile web remove @deepseek-ai/dsh-ebook-reader`. Configure the plugin in `$DSH_HOME/profiles/web/cordis.patch.yml`; that patch overrides the rows this bundle contributes.

## Reading

Selecting the Library tab shows the reader in the center column; selecting Sessions, New Session, or the wordmark returns to the conversation, which stays mounted meanwhile. The tab scans `libraryRoot` recursively on first use and on each refresh; opening a book added since the last scan scans again. Hidden entries and symbolic links are skipped, and books are sorted by path in Chinese collation. A book's progress is keyed by its path relative to `libraryRoot`.

| Control | Effect |
|---|---|
| Click a line, `↓`/`j`, `↑`/`k` | Move the reading line; the keys cross page and chapter edges |
| Page field, `‹` `›` | Go to a PDF page or the neighbouring EPUB chapter |
| Contents | List the PDF outline or the EPUB navigation document; the row being read is marked |
| `−`/`+`, `A−`/`A+` | Step the PDF zoom (50%–300% of fit-to-width) or the EPUB text size |
| Voice, category, speed, play, pause, stop | Read aloud from the sentence holding the reading line, with the chosen speaker and reading style at 0.75×–2× |

Scrolling moves the reading line to the first visible line once scrolling stops, unless read-aloud is playing. The position is saved one second after it last moved and when the page is hidden. The voice, speed, zoom, text size, and contents panel are remembered in this browser's local storage, and the category is remembered per book.

## Read-aloud

Read-aloud needs a Python environment with [`qwen-tts`](https://github.com/QwenLM/Qwen3-TTS) and a complete [Qwen3-TTS-12Hz-1.7B-CustomVoice](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice) directory. `qwen-tts` pins its own `transformers`, so give it a separate environment:

```bash
python3 -m venv ~/.dsh/venvs/ebook-reader
~/.dsh/venvs/ebook-reader/bin/python -m pip install -U qwen-tts soundfile
hf download Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice --local-dir ~/.dsh/models/Qwen3-TTS-12Hz-1.7B-CustomVoice
```

With `speechMode: local`, the Host checks the model directory before registering any route: `config.json` must declare `tts_model_type: custom_voice` and a non-empty `talker_config.spk_id` table, and the weights, tokenizer files, and `speech_tokenizer/` files must be present. The speaker table becomes the voice list, and `speechLanguage` and `defaultVoice` must name a language and speaker the model declares. The worker loads the model on the first request, picks CUDA, then MPS, then CPU under `speechDevice: auto`, and stops after `speechIdleShutdownMs` without requests (ten minutes by default); the next request starts it again. Once a batch's response is written, the worker releases what that batch allocated: it collects the tensors still held through reference cycles, then empties the CUDA or MPS caching allocator, which otherwise keeps every block it has handed out and leaves the process resident at the largest batch it has ever run.

The browser reads body prose only. An EPUB's `pre`, `code`, `kbd`, `samp`, and `var` elements are skipped, which the markup states exactly. A PDF states neither, so two heuristics over what the page draws apply: the printed row at the top or the bottom is the running head or foot when a gap wider than the page's usual line spacing separates it from the text block, or when it carries the page number at one end and closes no sentence; and three or more lines whose leading integers step by one are a printed code listing, along with the wrapped lines inside that run. A listing printed without line numbers is read as prose. The browser then splits what remains into sentences, cut at EPUB block starts and at the edges of what it skips, and split further to fit `speechMaxSegmentChars`; segments without a letter, such as page numbers, are skipped. Reading starts at the beginning of the sentence the reading line falls in, never mid-sentence. One request carries one paragraph, whose sentences the worker generates in a single model call; a paragraph past `speechMaxRequestSegments` sentences is cut into consecutive requests. `speechPrefetchParagraphs` paragraphs are requested ahead of the one playing, and the run's first request carries only its first sentence so reading starts without waiting for the whole paragraph. Whatever order the audio arrives in, the sentences are played in text order, with `speechSegmentGapMs` of silence between one sentence and the next; pausing during that silence holds it, and resuming moves straight on to the next sentence. The sentence being played is boxed row by row, as a text selection would show it, and the reading position follows it and is saved like any other move. Navigating during read-aloud continues reading from the new position.

## Configuration

The bundle defaults are in [`cordis.patch.yml`](cordis.patch.yml); read-aloud is off by default. A profile override replaces the row's complete `config`:

```yaml
- id: ebook-reader
  config:
    libraryRoot: ~/Documents/Books
    storageRoot: /private/ebook-reader
    listMaxBooks: 2000
    speechMode: local
    speechModelPath: /models/Qwen3-TTS-12Hz-1.7B-CustomVoice
    pythonExecutable: /path/to/venv/bin/python
    speechDevice: auto
    speechLanguage: Chinese
    defaultVoice: serena
    speechMaxSegmentChars: 120
    speechPrefetchParagraphs: 1
    speechMaxRequestSegments: 24
    speechDecoding: talker-sampled
    speechVoicePrompts:
      - voice: serena
        audio: /models/wav/serena.wav
        text: 参考录音的逐字文本。
    speechSegmentGapMs: 300
    speechRequestTimeoutMs: 300000
    speechIdleShutdownMs: 600000
    speechCacheMaxBytes: 1073741824
```

`storageRoot` defaults to `$DSH_HOME/ebook-reader` and `speechModelPath` to `$DSH_HOME/models/Qwen3-TTS-12Hz-1.7B-CustomVoice`. `speechModelPath` takes either the checkpoint directory or the Hugging Face cache directory (`models--Qwen--Qwen3-TTS-12Hz-1.7B-CustomVoice`) a download leaves behind, which resolves to the revision `refs/main` names, or to its only revision. `speechLanguage` is `Auto` or a language from the model's `codec_language_id` table, matched without case. An omitted `defaultVoice` is the first speaker of the model's table; a voice is named without case, and the Host sends the model its own `spk_id` key. `speechVoicePrompts` anchors a voice on reference speech: every segment read with that voice is conditioned on the recording and its transcript, so consecutive sentences keep one timbre instead of drifting. A voice without an entry is conditioned by its `spk_id` embedding alone. Measured on this checkpoint over four consecutive sentences, the mean timbre distance between sentences fell from 0.0037 to 0.0016 for `serena`, 0.0061 to 0.0012 for `vivian`, and 0.0053 to 0.0014 for `uncle_fu`, at the same synthesis cost. The reference is a clean single-speaker recording a few seconds long, and `text` must be its exact transcript, because the model is conditioned on the pair. Changing either half changes the cache key of every segment that voice anchored.

`speechDecoding` chooses which of the checkpoint's two decoders sample. `talker-sampled`, the default, turns sampling off in the sub-talker alone, which fixes each frame's codebook detail while the talker keeps sampling the prosody and the stop token. `fully-sampled` leaves the checkpoint's `generation_config.json` in charge, which samples in both, so the same sentence varies more between generations — measured on this checkpoint, one sentence ran 6.96 s to 9.12 s across four generations, against a 0.48 s median difference between two `talker-sampled` generations of the same sentence. The talker samples under both modes because greedy decoding there fails to emit the stop token: on twenty consecutive sentences of one book, eight ran to `max_new_tokens`, which this checkpoint sets to 8192 — around eleven minutes for one segment, past `speechRequestTimeoutMs`, which stops the worker. `speechMaxRequestSegments` bounds how many sentences one request and one model call carry. `speechSegmentGapMs` is the silence held between sentences, `0` playing them back to back. The worker never runs two calls at once, because one model instance on one device does not support it.

## Files and HTTP access

```text
<storageRoot>/
├── progress/<book-id>.json   # position, fraction, updatedAt, and the library-relative path
└── speech/<sha256>.flac      # synthesized segments, least recently used pruned past speechCacheMaxBytes
```

Files and directories are created with owner-only permissions. A segment's cache key covers the model directory, language, instruction, speaker, and text. Concurrent requests for one segment share a synthesis, and groups reach the worker in request order, one model call at a time; a segment whose every requester left is left out of its group, while one already generating completes and stays cached.

The reading category chosen beside the voice names a style instruction the Host holds; the browser sends the category id, never instruction text. The categories are Unset, Technical, Paper, Popular science, Humanities, Fiction, and Loli voice. The instruction is part of the cache key, so changing a book's category re-synthesizes it.

The route family is `/ebook-reader/api`. It accepts only loopback Host values and same-origin browser requests.

| Method and path | Purpose |
|---|---|
| `GET /capabilities` | Read-aloud settings and voices, or `{ enabled: false }`, and the versioned PDF.js directory |
| `GET /books` | Library listing with each book's saved progress |
| `GET\|HEAD /books/<id>/file` | The book file, with byte ranges |
| `PUT /books/<id>/progress` | Store `{ position: { section, offset }, fraction }` |
| `POST /speech` | Synthesize `{ text, voice }` and return FLAC audio |
| `GET\|HEAD /pdfjs/<version>/<dir>/<file>` | PDF.js module, worker, CMaps, standard fonts, and decoders from the installed `pdfjs-dist` |

## Model Experience

None, as the reader and read-aloud run outside the Agent; no book text, progress, or audio reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Scanned PDFs have no lines** — a page without a text layer shows a notice, cannot be read aloud, and gets no highlight; there is no OCR.
- **PDF reading order follows the content stream** — lines are grouped by baseline and split at column gutters, so a layout whose stream order differs from reading order is read in stream order, and running headers are read with the page.
- **EPUB publisher styling is not applied** — chapters render with the reader's typography; fixed-layout and vertical-writing EPUBs are not laid out as designed.
- **The highlight is sentence-granular** — it does not follow the voice within a sentence, so a long sentence stays boxed until the next one starts.
- **Progress follows the file path** — moving or renaming a book inside the library starts it over.
- **Loopback browser only** — like the other loopback-fenced routes, a Web GUI reached through a LAN address cannot use this plugin.
- **Local accelerator variance** — Qwen3-TTS speed and precision support vary across CUDA, MPS, and CPU; the package validates files and reports runtime failures but cannot guarantee real-time synthesis.
- **A sentence does not read identically twice** — the talker samples under both decoding modes, so a segment served from the cache and one generated after a prune differ in pace and intonation; the greedy sub-talker and a voice anchor narrow the difference without removing it, and no mode reproduces a text byte for byte.
- **Anchoring reaches past the qwen-tts public API** — `create_voice_clone_prompt` and `generate_voice_clone` refuse a CustomVoice checkpoint, and this one ships no speaker encoder, so the worker builds the prompt itself and calls the talker's `generate` through non-public helpers. A qwen-tts upgrade can move them; the anchored path is pinned by the package tests only as far as the process arguments, not through the model.

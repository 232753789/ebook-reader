# @deepseek-ai/dsh-ebook-reader

[English](README.md) | 中文

用于阅读本地电子书的可选 Web profile 组合包。浏览器端在侧边栏的「会话」旁增加「书库」tab，并在中间栏提供阅读器：tab 列出本地目录下的 `.pdf` 与 `.epub` 文件及每本书的进度，点击一本书即在中间栏替代对话显示它。阅读器用 PDF.js 渲染 PDF 页面、把 EPUB 章节渲染为清洗后的标记，高亮当前阅读的行，并保存每本书的位置。朗读用本地 Qwen3-TTS CustomVoice 模型逐句合成，读者可以选择模型声明的任一音色，播放时逐句高亮。Host 端负责列出书库、提供书籍文件与 PDF.js 发行文件、保存进度并运行 TTS worker。本包不修改 `agent-loop`，不向模型发送任何内容，也不会自动加入随附的 Web profile。

## 单独编译本插件

本包是一个自成一体的插件项目。两次 TypeScript 项目构建加一次打包，即可产出 profile 安装所需的全部文件。

```bash
pnpm install
pnpm run build
```

侧边栏 tab 与中间栏视图分别使用 `@deepseek-ai/dsh-client-ui-sidebar` 的 `sidebar.tab` slot 和 `@deepseek-ai/dsh-client-ui-layout` 的 `main.view` slot；DSH Web 应用两者都具备。

## 注册进 profile

在 DeepSeek Harness 仓库中执行，路径指向本包目录：

```bash
pnpm dsh plugin --profile web add <本仓库路径>/ebook-reader
pnpm dsh web
```

用 `pnpm dsh plugin --profile web remove @deepseek-ai/dsh-ebook-reader` 移除该行。插件配置写在 `$DSH_HOME/profiles/web/cordis.patch.yml` 中，它会覆盖本组合包提供的配置行。

## 阅读

选中「书库」tab 时中间栏显示阅读器；选中「会话」、点击「新会话」或字标时回到对话，对话在此期间保持挂载。tab 在首次使用和每次刷新时递归扫描 `libraryRoot`；打开上次扫描后新加入的书会再扫描一次。隐藏条目与符号链接会被跳过，书按路径以中文排序规则排序。一本书的进度以它相对 `libraryRoot` 的路径为键。

| 操作 | 效果 |
|---|---|
| 点击某一行、`↓`/`j`、`↑`/`k` | 移动当前阅读行；按键可跨越页面和章节边界 |
| 页码输入框、`‹` `›` | 跳到 PDF 的某一页或 EPUB 的相邻章节 |
| 目录 | 列出 PDF 书签或 EPUB 导航文档，并标出正在阅读的条目 |
| `−`/`+`、`A−`/`A+` | 逐档调整 PDF 缩放（适应宽度的 50%–300%）或 EPUB 字号 |
| 音色、语速、播放、暂停、停止 | 以所选音色、0.75×–2× 语速，从当前阅读行所在的句子开始朗读 |

滚动停止后，阅读行会移到第一条可见的行；朗读播放期间除外。位置在最后一次移动一秒后保存，页面隐藏时也会保存。音色、语速、缩放、字号和目录面板的开关记在本浏览器的 local storage 中。

## 朗读

朗读需要一个装有 [`qwen-tts`](https://github.com/QwenLM/Qwen3-TTS) 的 Python 环境，以及完整的 [Qwen3-TTS-12Hz-1.7B-CustomVoice](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice) 目录。`qwen-tts` 固定了自己的 `transformers` 版本，因此请为它单独建环境：

```bash
python3 -m venv ~/.dsh/venvs/ebook-reader
~/.dsh/venvs/ebook-reader/bin/python -m pip install -U qwen-tts soundfile
hf download Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice --local-dir ~/.dsh/models/Qwen3-TTS-12Hz-1.7B-CustomVoice
```

`speechMode: local` 时，Host 在注册任何路由前检查模型目录：`config.json` 必须声明 `tts_model_type: custom_voice` 和非空的 `talker_config.spk_id` 表，权重、分词器文件和 `speech_tokenizer/` 下的文件必须齐全。音色表即音色列表，`speechLanguage` 和 `defaultVoice` 必须是模型声明的语言和音色。worker 在第一次请求时加载模型，`speechDevice: auto` 下依次尝试 CUDA、MPS、CPU，并在 `speechIdleShutdownMs` 内没有请求时停止（默认十分钟）；下一次请求会再次启动它。每个批次的响应写出后，worker 会释放该批次分配的内存：先回收仍被引用环持有的张量，再清空 CUDA 或 MPS 的缓存分配器——否则它会保留自己发放过的每一个块，让进程常驻在历史上最大那个批次的占用上。

浏览器只朗读正文。EPUB 的 `pre`、`code`、`kbd`、`samp`、`var` 元素会被跳过，这由标记本身精确给出。PDF 两者都不标注，因此对页面绘制的内容采用两条启发式规则：顶部或底部的那一整行，若与正文块之间的空白大于本页常规行距，或其一端带有页码且不以句末标点结尾，则判为页眉页脚；连续三行及以上、行首整数依次加一的，判为印刷的代码清单，该区间内的折行也一并计入。没有行号的代码清单会被当作正文朗读。随后浏览器把剩下的文本切成句子，在 EPUB 块元素起点和被跳过内容的边界处断开，并进一步切分以满足 `speechMaxSegmentChars`；不含字母或汉字的片段（例如页码）会被跳过。朗读从当前阅读行所在句子的开头开始，不会从句子中间起读。一次请求承载一个段落，worker 用一次模型调用生成这个段落的所有句子；超过 `speechMaxRequestSegments` 句的段落会被切成连续的多次请求。正在播放的段落之外，另有 `speechPrefetchParagraphs` 个段落提前请求；每次朗读的第一次请求只带第一句，因此起播无需等待整段生成完。无论音频以什么顺序返回，播放都严格按文本顺序进行；每句之间停顿 `speechSegmentGapMs` 毫秒，停顿期间暂停会保持这段停顿，继续播放则直接进入下一句。正在播放的句子按行逐段加框，就像文本选区一样；阅读位置跟随它，并像其他移动一样被保存。朗读期间跳转到别处，会从新位置继续朗读。

## 配置

组合包的默认值见 [`cordis.patch.yml`](cordis.patch.yml)，默认关闭朗读。profile 覆盖会替换该行的完整 `config`：

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

`storageRoot` 默认为 `$DSH_HOME/ebook-reader`，`speechModelPath` 默认为 `$DSH_HOME/models/Qwen3-TTS-12Hz-1.7B-CustomVoice`。`speechModelPath` 既可以指向模型目录本身，也可以指向下载得到的 HuggingFace 缓存目录（`models--Qwen--Qwen3-TTS-12Hz-1.7B-CustomVoice`），后者解析为 `refs/main` 指定的版本，没有该文件时解析为其唯一版本。`speechLanguage` 取 `Auto` 或模型 `codec_language_id` 表中的语言，不区分大小写。省略 `defaultVoice` 时取模型音色表中的第一个音色；音色名不区分大小写，Host 向模型发送的是模型 `spk_id` 表中的原始键。`speechVoicePrompts` 用参考语音为音色设定声学锚点：用该音色朗读的每个片段都以这段录音及其逐字文本为条件，因此连续句子保持同一音色，不会逐句漂移。没有配置条目的音色仍只由 `spk_id` embedding 决定。在这个检查点上以连续四句实测，句间音色距离的均值从 0.0037 降到 0.0016（`serena`）、从 0.0061 降到 0.0012（`vivian`）、从 0.0053 降到 0.0014（`uncle_fu`），合成开销不变。参考音频应当是几秒长、单说话人的干净录音，`text` 必须是它的逐字文本，因为模型以两者成对为条件。改动其中任何一半，都会改变该音色所锚定的全部片段的缓存键。

`speechDecoding` 选择检查点的两个解码器中哪些采样。默认的 `talker-sampled` 只关闭子解码器的采样，固定每一帧的码本细节，主解码器仍然采样韵律和停止符。`fully-sampled` 交由检查点的 `generation_config.json` 决定，即两者都采样，同一句话在多次生成之间变化更大——在这个检查点上实测，同一句四次生成的时长从 6.96 秒到 9.12 秒，而 `talker-sampled` 下同一句两次生成的时长差中位数为 0.48 秒。两种模式下主解码器都采样，因为它一旦贪心解码就不吐停止符：在同一本书连续二十句上实测，有八句一直解码到 `max_new_tokens`，而这个检查点把它设为 8192——单个片段约十一分钟，超过 `speechRequestTimeoutMs`，worker 会因此被停掉。`speechMaxRequestSegments` 限定一次请求、一次模型调用最多承载多少句。`speechSegmentGapMs` 为句与句之间的停顿时长，取 `0` 表示连续播放。worker 不会同时发起两次调用：单设备上的一个模型实例不支持这样做。

## 文件与 HTTP 访问

```text
<storageRoot>/
├── progress/<book-id>.json   # position, fraction, updatedAt, and the library-relative path
└── speech/<sha256>.flac      # synthesized segments, least recently used pruned past speechCacheMaxBytes
```

文件和目录以仅属主可访问的权限创建。片段的缓存键包含模型目录、语言、指令、音色和文本。同一片段的并发请求共享一次合成，各组按请求顺序进入 worker，同一时刻只有一次模型调用；所有请求方都已离开的片段不会进入它所在的组，已开始生成的则会完成并留在缓存中。

音色旁边选择的书籍分类，对应 Host 内置的一条风格指令；浏览器只发送分类 id，不发送指令文本。分类为：不指定、技术 / 教程、论文、科普、人文 / 通识、小说 / 文学、萝莉音。指令参与缓存键，因此改变一本书的分类会重新合成。

路由族为 `/ebook-reader/api`，只接受 loopback Host 值和同源浏览器请求。

| 方法与路径 | 用途 |
|---|---|
| `GET /capabilities` | 朗读设置与音色（或 `{ enabled: false }`）以及带版本号的 PDF.js 目录 |
| `GET /books` | 书库列表及每本书已保存的进度 |
| `GET\|HEAD /books/<id>/file` | 书籍文件，支持字节范围 |
| `PUT /books/<id>/progress` | 保存 `{ position: { section, offset }, fraction }` |
| `POST /speech` | 合成 `{ text, voice }` 并返回 FLAC 音频 |
| `GET\|HEAD /pdfjs/<version>/<dir>/<file>` | 来自已安装 `pdfjs-dist` 的 PDF.js 模块、worker、CMap、标准字体与解码器 |

## 模型体验

无。阅读器与朗读都在 Agent 之外运行，书籍文本、进度和音频都不会进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **扫描版 PDF 没有文本行** — 没有文字层的页面会显示提示，既不能朗读也没有高亮；本包不做 OCR。
- **PDF 阅读顺序跟随内容流** — 行按基线分组并在栏间空白处断开，因此内容流顺序与阅读顺序不同的版式按内容流朗读，页眉也会随页面朗读。
- **不应用 EPUB 出版方样式** — 章节以阅读器自己的排版显示；固定版式和竖排 EPUB 不会按原设计排版。
- **高亮以句子为单位** — 它不会在一句话内部跟随语音移动，因此长句会一直加框到下一句开始。
- **进度跟随文件路径** — 在书库内移动或重命名一本书，会从头开始。
- **仅限 loopback 浏览器** — 与其他受 loopback 限制的路由一样，通过局域网地址访问的 Web GUI 无法使用本插件。
- **本地加速器差异** — Qwen3-TTS 的速度和精度支持在 CUDA、MPS、CPU 之间各不相同；本包会校验文件并报告运行时失败，但不能保证实时合成。
- **同一句话不会读得完全一样** — 两种解码模式下主解码器都采样，因此缓存里的片段与清理后重新生成的片段在语速和语调上有差异；贪心的子解码器和音色锚点只能缩小这个差异，不能消除它，没有任何模式能逐字节复现一段文本。
- **锚定越过了 qwen-tts 的公开接口** — `create_voice_clone_prompt` 和 `generate_voice_clone` 拒绝 CustomVoice 检查点，而这个检查点也没有说话人编码器，因此 worker 自行构造 prompt，并通过非公开辅助方法调用主解码器的 `generate`。qwen-tts 升级可能移动这些方法；包内测试只固定到进程参数为止，不经过模型。

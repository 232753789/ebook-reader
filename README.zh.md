# ebook-reader

**在 DSH Web GUI 里阅读本地 PDF / EPUB 电子书，逐行跟读，并用本地 Qwen3-TTS 模型朗读。**

[English](README.md) | 中文

ebook-reader 是 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) Web GUI 的一个可选插件。安装后，侧边栏的「会话」旁会多出一个「书库」tab：它列出本地目录中的 PDF 与 EPUB 文件，点击一本书即在中间栏打开阅读，替代对话视图（对话在后台保持挂载）。阅读器会高亮当前阅读行、记住每本书的阅读位置，并可调用运行在本机的 Qwen3-TTS 模型朗读全书，朗读时逐句框出正在播放的句子。

一切都在本地完成：书籍文件、阅读进度和合成的音频都不离开本机，也不会进入任何大模型请求。插件不依赖其他可选插件。

## 功能特性

- **本地书库** — 递归扫描指定目录（默认 `~/Documents/Books`）下的 `.pdf` 与 `.epub`，跳过隐藏条目和符号链接，按路径的中文排序展示，并显示每本书的阅读进度。
- **PDF 阅读** — 基于 PDF.js 渲染页面，支持缩放（适应宽度的 50%–300%）、页码跳转和文档大纲。
- **EPUB 阅读** — 将章节渲染为经过净化（DOMPurify）的标记，支持字号调节、章节切换和目录导航。
- **逐行跟读** — 点击某一行，或用 `↓`/`j`、`↑`/`k` 移动阅读行，可跨页、跨章节；滚动停止后阅读行自动跟随到首个可见行。
- **进度记忆** — 阅读位置在最后一次移动一秒后以及页面隐藏时自动保存，下次打开从上次的位置继续。
- **本地朗读** — 使用 [Qwen3-TTS-12Hz-1.7B-CustomVoice](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice) 逐句合成；可选择模型声明的任一音色、朗读风格（技术、论文、科普、人文、小说等）和 0.75×–2× 语速。
- **智能取文** — 只朗读正文：跳过 EPUB 中的代码块，并用启发式规则识别 PDF 的页眉页脚和带行号的代码清单。
- **流畅播放** — 预取后续段落，首个请求只带一句以缩短等待，无论音频以何种顺序返回都按文本顺序播放，合成结果以 FLAC 缓存。
- **音色稳定** — 可为音色配置参考录音及其逐字文本（`speechVoicePrompts`），让连续句子的音色不漂移。
- **中英双语界面** — 内置中文与英文文案。

## 工作原理

```text
┌──────────────────────────── 浏览器（Web GUI）─────────────────────────────┐
│  书库侧边栏 tab ─┬─ 阅读器主视图（PdfView / EpubView）                     │
│                  └─ SpeechPlayer（分句、预取、按序播放）                    │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │  /ebook-reader/api（仅限回环地址、同源请求）
┌───────────────────────────────┴────── Host（Node）─────────────────────────┐
│  书库扫描 · 书籍文件服务（支持字节范围） · PDF.js 分发                      │
│  阅读进度存储 · 语音缓存（LRU 清理）                                        │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │  经 stdin/stdout 的 NDJSON
┌───────────────────────────────┴──── Python TTS worker ─────────────────────┐
│  qwen-tts + Qwen3-TTS CustomVoice · CUDA → MPS → CPU · 空闲自动退出         │
└────────────────────────────────────────────────────────────────────────────┘
```

- **浏览器端**（`src/client/`）：React 组件与控制器，注册一个 `sidebar.tab` 条目和一个 `main.view` 条目。
- **Host 端**（`src/`）：Cordis 插件，在 Web 服务器上注册 `/ebook-reader/api` 路由族，并管理 TTS 子进程。
- **TTS worker**（`python/tts_worker.py`）：常驻进程，首次请求时加载模型，一段时间无请求后退出。

## 快速开始

### 前置条件

- 一份带 Web GUI 的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 检出
- Node.js 与 pnpm
- （仅朗读需要）Python 3、Qwen3-TTS 模型目录，最好有 CUDA 或 Apple Silicon（MPS）加速

### 1. 构建插件

```bash
cd ebook-reader
pnpm install
pnpm run build
```

### 2. 注册到 Web profile

在 DeepSeek Harness 仓库中执行：

```bash
pnpm dsh plugin --profile web add <本仓库路径>/ebook-reader
pnpm dsh web
```

打开 Web GUI，点击侧边栏的「书库」tab 即可。卸载：

```bash
pnpm dsh plugin --profile web remove @deepseek-ai/dsh-ebook-reader
```

### 3.（可选）启用朗读

朗读默认关闭。为 `qwen-tts` 单独建一个 Python 环境（它会固定自己的 `transformers` 版本），并下载模型：

```bash
python3 -m venv ~/.dsh/venvs/ebook-reader
~/.dsh/venvs/ebook-reader/bin/python -m pip install -U qwen-tts soundfile
hf download Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice \
  --local-dir ~/.dsh/models/Qwen3-TTS-12Hz-1.7B-CustomVoice
```

然后在 `$DSH_HOME/profiles/web/cordis.patch.yml` 中开启：

```yaml
- id: ebook-reader
  config:
    libraryRoot: ~/Documents/Books
    speechMode: local
    pythonExecutable: ~/.dsh/venvs/ebook-reader/bin/python
    speechLanguage: Chinese
    defaultVoice: serena
```

> profile 覆盖会替换该行的完整 `config`；各字段的默认值见 [`cordis.patch.yml`](ebook-reader/cordis.patch.yml)。

`speechMode: local` 时，Host 会在启动时校验模型目录（`tts_model_type` 须为 `custom_voice`，权重、分词器与 `speech_tokenizer/` 文件须完整），缺失即令插件加载失败。

## 主要配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `libraryRoot` | `~/Documents/Books` | 书库目录 |
| `storageRoot` | `$DSH_HOME/ebook-reader` | 进度与语音缓存的存储目录 |
| `listMaxBooks` | `2000` | 书库列表的最大书目数 |
| `speechMode` | `off` | `off` 或 `local` |
| `speechModelPath` | `$DSH_HOME/models/Qwen3-TTS-12Hz-1.7B-CustomVoice` | 模型目录，也可为 Hugging Face 缓存目录 |
| `pythonExecutable` | `python3` | 运行 TTS worker 的 Python 解释器 |
| `speechDevice` | `auto` | `auto` / `cuda` / `mps` / `cpu` |
| `speechLanguage` | `Auto` | 合成语言 |
| `defaultVoice` | 模型的第一个音色 | 默认音色 |
| `speechDecoding` | `talker-sampled` | 解码模式；`fully-sampled` 每次生成的差异更大 |
| `speechVoicePrompts` | — | 锚定音色的参考录音与逐字文本 |
| `speechCacheMaxBytes` | 1 GiB | 语音缓存上限，按最近最少使用清理 |
| `speechIdleShutdownMs` | 10 分钟 | worker 空闲多久后退出 |

全部配置项、朗读流程、HTTP API 与实测数据，见[包 README](ebook-reader/README.zh.md)。

## 仓库结构

```text
.
├── README.md / README.zh.md          # 本页
└── ebook-reader/                     # 插件包 @deepseek-ai/dsh-ebook-reader
    ├── README.md / README.zh.md      # 完整的包文档
    ├── cordis.patch.yml              # 组合包的默认配置
    ├── src/                          # Host 端：配置、书库扫描、进度、HTTP 路由、语音调度
    │   └── client/                   # 浏览器端：书库面板、PDF/EPUB 视图、朗读播放器
    ├── python/tts_worker.py          # Qwen3-TTS NDJSON worker
    ├── tests/                        # Vitest 测试（Host 与客户端）
    └── tsdown.config.ts              # Host ESM 与客户端组合包的构建配置
```

## 开发

- `pnpm run build` — 对 Host 与客户端做类型检查，再用 tsdown 打包到 `lib/`
- `pnpm run watch` — 修改后自动重新构建
- TypeScript 测试位于 `ebook-reader/tests/`，在 Vitest 下运行
- Python worker 的测试不需要 torch 和模型权重：`python3 -m pytest ebook-reader/python`

## 已知限制

- 扫描版 PDF 没有文本层，无法朗读和高亮（不含 OCR）。
- PDF 按内容流顺序分行，复杂版式的朗读顺序可能与阅读顺序不同。
- 不应用 EPUB 出版商样式，不支持固定版式与竖排。
- 高亮以句为单位，不会逐字跟随语音。
- 进度按文件路径记录，移动或重命名书籍会从头开始。
- 仅支持回环地址（localhost）访问，通过局域网地址打开的 Web GUI 无法使用本插件。

完整列表见[包 README](ebook-reader/README.zh.md#已知限制与暂缓事项)。

## 许可证

[MIT](ebook-reader/package.json)

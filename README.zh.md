# ebook-reader/ — 带逐行跟读的本地电子书

[English](README.md) | 中文

一个自成一体的可选插件项目：一个可安装的 Web profile 组合包。它在侧边栏的「会话」旁增加「书库」tab，在中间栏阅读本地目录中的 PDF 与 EPUB 文件，记录每本书的阅读进度，并用本地 Qwen3-TTS CustomVoice 模型朗读，朗读时高亮当前行。它不依赖任何其他插件。

| 包 | 职责 | ctx key |
|---|---|---|
| [`ebook-reader/`](ebook-reader/README.md) | 书库列表、PDF/EPUB 阅读器、阅读进度与 Qwen3-TTS 朗读 | 注册 Web 路由、一个 `sidebar.tab` 条目和一个 `main.view` 条目 |

构建组合包并注册进 profile 的命令见[包 README](ebook-reader/README.md#build-this-plugin-on-its-own)。

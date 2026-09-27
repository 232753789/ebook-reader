# ebook-reader/ — local ebooks with line-tracked read-aloud

English | [中文](README.zh.md)

A self-contained optional plugin project: one installable Web profile bundle that adds a Library tab beside Sessions in the sidebar, reads PDF and EPUB files from a local directory in the center column, keeps per-book reading progress, and reads the book aloud with a local Qwen3-TTS CustomVoice model while the current line stays highlighted. It depends on no other plugin.

| Package | Role | ctx key |
|---|---|---|
| [`ebook-reader/`](ebook-reader/README.md) | Library listing, PDF/EPUB reader, reading progress, and Qwen3-TTS read-aloud | registers Web routes, a `sidebar.tab` entry, and a `main.view` entry |

Build the bundle and register it into a profile with the commands in [the package README](ebook-reader/README.md#build-this-plugin-on-its-own).

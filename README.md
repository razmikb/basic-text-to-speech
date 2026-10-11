# Basic Text-to-Speech

A Firefox add-on that reads web articles aloud with a natural voice that runs on your own
computer, highlighting each sentence as it is read.

![The add-on reading a Wikipedia article: the current sentence is highlighted and the
playback bar sits in the corner](docs/screenshot.png)

<sub>Page shown: the Wikipedia article
[Userkare](https://en.wikipedia.org/wiki/Userkare), CC BY-SA 4.0.</sub>

- **Private by design.** The voice is [Piper](https://github.com/rhasspy/piper), a neural
  text-to-speech model, running inside the add-on. Page text never leaves your machine; no
  account, no cloud, no tracking.
- **Reads the article, not the clutter.** Menus, ads, sidebars, share buttons and reference
  lists are skipped. Reading stops at a login or paywall box.
- **Follow along.** The sentence being read is highlighted and the page scrolls with it.
- **Controls on the page.** A small bar to pause, skip, change speed (0.5x to 3x) and close.
  Drag it anywhere; it fades while reading.
- **Right-click** "Read selection aloud" or "Read from here".
- **Six English voices**, chosen in the add-on's settings.

The first read downloads the chosen voice (about 60 MB) once from Hugging Face; Firefox
keeps it. PDFs cannot be read, because Firefox does not allow add-ons inside its PDF viewer.

Requires Firefox 140 or later.

## Development

Plain JavaScript (ES modules), Manifest V3, no bundler. Node 22 is used only for the checks.

```bash
npm ci
npm run check    # lint + tests
npx web-ext run --source-dir src
```

The extractor tests also run against saved copies of real web pages. Those are other
people's articles, so they are not in this repository, and the tests that need them are
skipped here.

Third-party code in `src/vendor/` is listed, with sources and versions, in
[src/vendor/VENDORED.md](src/vendor/VENDORED.md); `npm run vendor` rebuilds it.

## Licence

GPL-3.0-or-later — see [LICENSE](LICENSE). The add-on includes eSpeak NG (GPL-3.0) for
pronunciation. Each voice carries its own licence; they are listed on the add-on's settings
page under "Credits and licences".

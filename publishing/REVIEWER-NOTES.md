# Notes for the addons.mozilla.org reviewer

The box on the upload form has a character limit, so the version actually submitted for
0.1.0 (2026-10-11) is the short one directly below. The longer original further down keeps
the full file table for reference.

## As submitted (0.1.0)

Reads the current article aloud with a Piper neural voice that runs entirely inside the add-on, highlighting each sentence. No page text leaves the browser.

How to test: open a Wikipedia article and click the toolbar button. The first time, the "Amy" voice (~60 MB) downloads once from huggingface.co. Right-click for "Read selection aloud" / "Read from here".

Network: only downloads voice model data (.onnx + .onnx.json) from huggingface.co/diffusionstudio/piper-voices. No telemetry. wasm-unsafe-eval is needed for WebAssembly (ONNX Runtime, eSpeak NG); no JS eval.

Third-party files are in src/vendor/ (checksums in src/vendor/VENDORED.md): onnxruntime-web@1.18.0 and @diffusionstudio/vits-web@1.0.3 from npm, piper_phonemize from @diffusionstudio/piper-wasm@1.0.0. All unmodified except vits-web.js, patched only to load these local copies instead of CDNs and to use 1 thread.

Source/build: no build step; src/ is the source as written, not minified. Public repo: github.com/razmikb/basic-text-to-speech. To reproduce src/vendor/ byte-identically: any OS (built on Linux), Node 22+ with npm, internet access; clone, "npm ci", "npm run vendor".

Linter warnings: "Unsafe call to import" in content.js loads the add-on's own modules via runtime.getURL with fixed paths. "Unexpected Callee" is the linter failing to parse Microsoft's unmodified minified ort.wasm.min.mjs. The Android warning doesn't apply: desktop only.

A source archive (`git archive HEAD`) was uploaded alongside, as AMO asks for one when
third-party code is minified or produced by a script.

## Longer original

**What it does.** Reads the article on the current page aloud with a neural voice (Piper)
that runs entirely inside the add-on, highlights each sentence as it is read, and shows a
small control bar on the page. No page text ever leaves the browser.

**How to test.** Open any article (for example a Wikipedia page) and click the toolbar
button. The first time, the default voice ("Amy", about 60 MB) is downloaded once from
huggingface.co and kept in the add-on's storage; reading starts when it is ready. Clicking
the button again stops. Right-click a selection for "Read selection aloud", or right-click
in the article for "Read from here". Settings (voice choice, credits) are on the add-on's
options page.

**Network access.** The only network requests are downloads of voice model files (`.onnx`
weights and their `.onnx.json` config) from
`https://huggingface.co/diffusionstudio/piper-voices/` — data, not code. Nothing is sent
anywhere else, and there is no analytics or telemetry.

**`wasm-unsafe-eval` in the CSP** is needed to run WebAssembly: ONNX Runtime (runs the
voice model) and eSpeak NG (turns text into phonemes). No JavaScript `eval` is used.

**Third-party files** are all in `src/vendor/`, produced by `tools/vendor-piper.mjs` from
pinned versions. `src/vendor/VENDORED.md` lists each file with its SHA-256.

| File                                                                         | Origin                                                                                                                                                                                | Modified?                        |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `vendor/onnxruntime/ort.wasm.min.mjs`, `ort-wasm.wasm`, `ort-wasm-simd.wasm` | npm `onnxruntime-web@1.18.0`, `dist/`                                                                                                                                                 | No                               |
| `vendor/piper/piper-DeOu3H9E.js`                                             | npm `@diffusionstudio/vits-web@1.0.3`, `dist/`                                                                                                                                        | No                               |
| `vendor/piper/vits-web.js`                                                   | npm `@diffusionstudio/vits-web@1.0.3`, `dist/vits-web.js`                                                                                                                             | **Yes, 4 small patches** (below) |
| `vendor/piper/piper_phonemize.wasm`, `piper_phonemize.data`                  | `https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/` (source: github.com/diffusion-studio/piper-wasm — Emscripten build of rhasspy/piper-phonemize with eSpeak NG) | No                               |

The patches to `vits-web.js` only stop it from reaching CDNs: (1) the ONNX Runtime URL and
(2) the phonemizer URL point at the add-on's own copies via `runtime.getURL`; (3) a bare
`import("onnxruntime-web")` becomes a relative path; (4) the thread count is pinned to 1.

**Source code** is attached and is also public at https://github.com/razmikb/basic-text-to-speech
(GPL-3.0-or-later). There is no build step: `src/` is the add-on as uploaded. To
reproduce the vendored files: Node 22+, then `npm ci && npm run vendor` — the output is
byte-identical to `src/vendor/`.

**Linter warnings, explained.**

- `UNSAFE_VAR_ASSIGNMENT: Unsafe call to import` in `content.js` — the content script
  loads the add-on's own modules with `import(browser.runtime.getURL('lib/…'))`, because
  content scripts cannot use static imports. Every path is a fixed string inside the add-on.
- `UNSAFE_VAR_ASSIGNMENT … Unexpected Callee` in `vendor/onnxruntime/ort.wasm.min.mjs` —
  the linter failing to parse Microsoft's unmodified minified file.
- `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION` — the add-on targets Firefox desktop only.

# Vendored files — copied in, not written here

Everything in this folder is **someone else's code**, copied into the add-on by
`npm run vendor` (see `tools/vendor-piper.mjs`). Do not edit these files by hand: the
next vendor run overwrites them. To change how they are patched, change the script.

They are committed to the repository on purpose, so that a fresh checkout can be loaded
straight into Firefox with no build step.

## Where it came from

| Package | Version | Licence |
| --- | --- | --- |
| `@diffusionstudio/vits-web` | 1.0.3 | MIT |
| `onnxruntime-web` | 1.18.0 | MIT |
| `@diffusionstudio/piper-wasm` | 1.0.0 | **GPL-3.0-or-later** in practice (see below) |

## What was changed, and why

`vits-web.js` is patched in four places. Each patch fails the build if it stops matching,
so a library update cannot silently reintroduce a CDN call:

1. **ONNX runtime address** → `../onnxruntime/`. The library ships pointing at a CDN.
2. **Pronunciation engine address** → `./piper_phonemize`. Same reason.
3. **`import("onnxruntime-web")`** → a relative path. Browsers cannot resolve bare names;
   this only worked on the test page because the CDN rewrote it.
4. **Thread count** → `1`. Multi-threading needs cross-origin isolation, which extension
   pages do not have. The runtime falls back anyway; pinning makes it deliberate.

**Deliberately NOT changed:** the address voice models are downloaded from. The library
decides whether a model is already on this machine by checking that its address contains
`huggingface.co`. Repoint it and that check fails silently — it would re-download 60MB
every time it spoke.

## Licence note

`piper_phonemize.wasm` has eSpeak NG compiled into it, and `piper_phonemize.data` is
eSpeak NG's pronunciation data. eSpeak NG is **GPL-3.0-or-later**. (The npm package
labels itself MIT; that label is wrong for these two files.) Shipping them makes the
whole published add-on GPL-3.0 — **decided 2026-09-30: accept that** (see PROGRESS.md,
"Licences").

The voice models are **not** all MIT, despite the MIT tag on the Hugging Face
collection: each voice's own `MODEL_CARD` decides. They are not in this folder — each
listener's Firefox downloads them from Hugging Face — but which ones we offer is still
our choice. See `PIPER_VOICE_LIST` in `src/lib/config.js`.

## Files

| File | Size | SHA-256 |
| --- | --- | --- |
| `piper/piper-DeOu3H9E.js` | 127.5 KB | `e2701cb8c73580ab…` |
| `piper/piper_phonemize.data` | 17.2 MB | `29f1025eb23a5b5c…` |
| `piper/piper_phonemize.wasm` | 620.3 KB | `b777cd107a91d2bc…` |
| `piper/vits-web.js` | 13.6 KB | `a1e57f40b116be43…` |
| `onnxruntime/ort-wasm-simd.wasm` | 10.1 MB | `f533b5f21790563d…` |
| `onnxruntime/ort-wasm.wasm` | 9.3 MB | `ebe7ec327f83aabc…` |
| `onnxruntime/ort.wasm.min.mjs` | 139.5 KB | `d02079ae1c4143f3…` |

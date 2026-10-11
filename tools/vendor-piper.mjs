/**
 * Copy the Piper voice library into the add-on, and patch it so it runs offline.
 *
 * Run with `npm run vendor`. This is a development tool: it never ships inside the
 * add-on, and it only needs running when a library version changes.
 *
 * WHY THIS EXISTS AT ALL. The library we use, `@diffusionstudio/vits-web`, is written for
 * an ordinary website that can fetch what it needs from a CDN as it goes. An add-on cannot
 * work that way: reaching out to a CDN every time it speaks would make the voice depend on
 * someone else's server staying up, and would leak the fact that you are reading to a third
 * party. Privacy is a feature here, so everything the voice needs is copied into the add-on
 * and the library is rewritten to look there instead.
 *
 * WHAT IT REWRITES, and why each one is necessary rather than tidy:
 *
 *   1. The ONNX runtime URL — the maths engine that actually runs the voice model. The
 *      library points it at a CDN; we point it at our copy.
 *   2. The pronunciation engine URL — works out how words are said. Same reason.
 *   3. A bare `import("onnxruntime-web")`. No browser can resolve a name like that; it
 *      only worked on the test page because the CDN quietly rewrote it. Ours becomes a
 *      real relative path.
 *   4. The thread count. The library asks for one thread per CPU core, but multi-threading
 *      needs a browser security mode we do not have. The runtime already copes by falling
 *      back to a single thread — we pin it so the behaviour is chosen, not stumbled into.
 *
 * WHAT IT DELIBERATELY DOES NOT REWRITE: the address voice models are downloaded from.
 * The library decides whether a model is already saved on this machine by checking whether
 * its address contains `huggingface.co`. Repoint it and that check silently fails, so it
 * would re-download 60MB every single time it spoke. Left alone on purpose.
 *
 * Every patch below asserts that it actually matched something. If the library changes
 * shape in a future version, this script fails loudly here rather than producing an add-on
 * that is subtly broken in a way only a human listening would notice.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'src', 'vendor');
const PIPER_DIR = path.join(VENDOR, 'piper');
const ORT_DIR = path.join(VENDOR, 'onnxruntime');

/** Pinned on purpose: a vendored dependency that drifts is worse than one that is old. */
const VITS_VERSION = '1.0.3';
const ORT_VERSION = '1.18.0';
const PIPER_WASM_VERSION = '1.0.0';

/**
 * The pronunciation engine is not on npm, so it comes from a CDN — once, here, at
 * development time. The add-on itself never fetches these.
 */
const PIPER_WASM_BASE = `https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@${PIPER_WASM_VERSION}/build/piper_phonemize`;

/**
 * A download smaller than this is a truncated file or an error page, not an asset. A
 * half-written binary fails at runtime in a way that looks exactly like a code bug, which
 * is an expensive afternoon; refusing to write it is much cheaper.
 */
const MIN_PLAUSIBLE_BYTES = 100_000;

async function main() {
  console.log('Vendoring the Piper voice library into src/vendor/ …\n');

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'ftts-vendor-'));
  try {
    fs.rmSync(VENDOR, { recursive: true, force: true });
    fs.mkdirSync(PIPER_DIR, { recursive: true });
    fs.mkdirSync(ORT_DIR, { recursive: true });

    const vits = extractPackage(staging, '@diffusionstudio/vits-web', VITS_VERSION);
    const ort = extractPackage(staging, 'onnxruntime-web', ORT_VERSION);

    vendorVitsWeb(vits);
    vendorOnnxRuntime(ort);
    await vendorPronunciationEngine();

    writeProvenance();

    console.log('\nDone. src/vendor/ now holds everything the voice needs to run offline.');
    report();
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Download a package from npm and unpack it into the staging directory. */
function extractPackage(staging, name, version) {
  console.log(`  fetching ${name}@${version} from npm …`);
  const dir = path.join(staging, name.replace(/[@/]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });

  execFileSync('npm', ['pack', `${name}@${version}`, '--silent'], {
    cwd: dir,
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: process.platform === 'win32',
  });

  const tarball = fs.readdirSync(dir).find((file) => file.endsWith('.tgz'));
  if (!tarball) throw new Error(`npm pack produced no tarball for ${name}@${version}`);

  execFileSync('tar', ['xzf', tarball], { cwd: dir, stdio: 'inherit' });
  return path.join(dir, 'package');
}

/**
 * Copy the voice library and apply the four rewrites described at the top of this file.
 */
function vendorVitsWeb(pkg) {
  console.log('  patching the voice library so it looks inside the add-on …');

  const distDir = path.join(pkg, 'dist');
  const source = read(path.join(distDir, 'vits-web.js'));

  // The emscripten glue file's name contains a build hash that changes between releases,
  // so it is discovered rather than hard-coded.
  const glueName = fs
    .readdirSync(distDir)
    .find((file) => file.startsWith('piper-') && file.endsWith('.js'));
  if (!glueName) throw new Error('could not find the piper glue file in the package');
  copy(path.join(distDir, glueName), path.join(PIPER_DIR, glueName));

  let patched = source;

  // 1. The ONNX runtime. Used as a directory prefix, so it must keep its trailing slash.
  //
  //    These two become ABSOLUTE add-on addresses rather than relative ones, and that is
  //    not fussiness. A relative address is measured from whichever file happens to be
  //    asking, and these are read by the runtime and by WebAssembly rather than by this
  //    file — so "../onnxruntime/" would be measured from the *page*, land somewhere that
  //    does not exist, and fail with nothing but a silent missing file. Asking the browser
  //    for the add-on's own address removes the guesswork entirely.
  patched = replaceOnce(
    patched,
    `"https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/${ORT_VERSION}/"`,
    'EXTENSION_URL("vendor/onnxruntime/")',
    'ONNX runtime URL'
  );

  // 2. The pronunciation engine. The library appends ".wasm" and ".data" to this.
  patched = replaceOnce(
    patched,
    `"${PIPER_WASM_BASE}"`,
    'EXTENSION_URL("vendor/piper/piper_phonemize")',
    'pronunciation engine URL'
  );

  // The helper both rewrites above rely on. Prepended so it exists before anything runs.
  patched =
    'const EXTENSION_URL = (p) => (globalThis.browser ?? globalThis.chrome).runtime.getURL(p);\n' +
    patched;

  // 3. The bare import no browser can resolve.
  patched = replaceOnce(
    patched,
    'import("onnxruntime-web")',
    'import("../onnxruntime/ort.wasm.min.mjs")',
    'bare onnxruntime-web import'
  );

  // 4. Threading. Multi-threaded WebAssembly needs cross-origin isolation, which an
  //    extension page does not get. The runtime would fall back on its own and log a
  //    warning; pinning it keeps the console clean and the behaviour deliberate.
  patched = replaceOnce(
    patched,
    'wasm.numThreads = navigator.hardwareConcurrency',
    'wasm.numThreads = 1',
    'thread count'
  );

  write(path.join(PIPER_DIR, 'vits-web.js'), patched);
}

/**
 * Copy the ONNX runtime — the maths engine that runs the voice model.
 *
 * We take the `wasm` build rather than the full one: it is a tenth of the size and the
 * only backend we can use anyway. The WebAssembly binaries ship inside the npm package,
 * so nothing is downloaded here.
 */
function vendorOnnxRuntime(pkg) {
  console.log('  copying the ONNX runtime …');

  const distDir = path.join(pkg, 'dist');

  // Renamed to .mjs so Firefox treats it as a module regardless of how it is loaded.
  copy(path.join(distDir, 'esm', 'ort.wasm.min.js'), path.join(ORT_DIR, 'ort.wasm.min.mjs'));

  // Single-threaded builds only, matching the pinned thread count above. The threaded
  // binaries would never be chosen, and each one is another 10MB in the repository.
  for (const binary of ['ort-wasm-simd.wasm', 'ort-wasm.wasm']) {
    copy(path.join(distDir, binary), path.join(ORT_DIR, binary));
  }
}

/**
 * Download the pronunciation engine.
 *
 * The 18MB data file is eSpeak NG's pronunciation dictionary. It is also the piece that
 * carries the GPL-3.0-or-later licence that makes the whole add-on GPL. See VENDORED.md.
 */
async function vendorPronunciationEngine() {
  console.log('  downloading the pronunciation engine …');
  for (const extension of ['.wasm', '.data']) {
    const url = `${PIPER_WASM_BASE}${extension}`;
    const bytes = await download(url);
    write(path.join(PIPER_DIR, `piper_phonemize${extension}`), bytes);
  }
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not download ${url} — HTTP ${response.status}`);

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < MIN_PLAUSIBLE_BYTES) {
    throw new Error(
      `${url} returned only ${bytes.length} bytes, which is too small to be the real ` +
        'asset. Refusing to write a truncated file.'
    );
  }
  return bytes;
}

/**
 * Replace exactly one known piece of text, failing if it is missing or ambiguous.
 *
 * This is the early-warning system. These strings live inside someone else's minified
 * file; if a future version renames or reshapes them, we find out here, at development
 * time, instead of shipping an add-on that quietly reaches for a CDN.
 */
function replaceOnce(source, find, replacement, description) {
  const occurrences = source.split(find).length - 1;
  if (occurrences === 0) {
    throw new Error(
      `Could not find the ${description} in vits-web.js. The library has probably ` +
        `changed since version ${VITS_VERSION}. Check the patches in this script before ` +
        'bumping the version.'
    );
  }
  if (occurrences > 1) {
    throw new Error(
      `Found the ${description} ${occurrences} times in vits-web.js; expected exactly one. ` +
        'Patching blindly could break something else.'
    );
  }
  console.log(`    ✓ ${description}`);
  return source.replace(find, replacement);
}

/** Record what was copied, from where, and what was changed. */
function writeProvenance() {
  const files = listVendored()
    .map((file) => `| \`${file.name}\` | ${file.size} | \`${file.sha256.slice(0, 16)}…\` |`)
    .join('\n');

  write(
    path.join(VENDOR, 'VENDORED.md'),
    `# Vendored files — copied in, not written here

Everything in this folder is **someone else's code**, copied into the add-on by
\`npm run vendor\` (see \`tools/vendor-piper.mjs\`). Do not edit these files by hand: the
next vendor run overwrites them. To change how they are patched, change the script.

They are committed to the repository on purpose, so that a fresh checkout can be loaded
straight into Firefox with no build step.

## Where it came from

| Package | Version | Licence |
| --- | --- | --- |
| \`@diffusionstudio/vits-web\` | ${VITS_VERSION} | MIT |
| \`onnxruntime-web\` | ${ORT_VERSION} | MIT |
| \`@diffusionstudio/piper-wasm\` | ${PIPER_WASM_VERSION} | **GPL-3.0-or-later** in practice (see below) |

## What was changed, and why

\`vits-web.js\` is patched in four places. Each patch fails the build if it stops matching,
so a library update cannot silently reintroduce a CDN call:

1. **ONNX runtime address** → \`../onnxruntime/\`. The library ships pointing at a CDN.
2. **Pronunciation engine address** → \`./piper_phonemize\`. Same reason.
3. **\`import("onnxruntime-web")\`** → a relative path. Browsers cannot resolve bare names;
   this only worked on the test page because the CDN rewrote it.
4. **Thread count** → \`1\`. Multi-threading needs cross-origin isolation, which extension
   pages do not have. The runtime falls back anyway; pinning makes it deliberate.

**Deliberately NOT changed:** the address voice models are downloaded from. The library
decides whether a model is already on this machine by checking that its address contains
\`huggingface.co\`. Repoint it and that check fails silently — it would re-download 60MB
every time it spoke.

## Licence note

\`piper_phonemize.wasm\` has eSpeak NG compiled into it, and \`piper_phonemize.data\` is
eSpeak NG's pronunciation data. eSpeak NG is **GPL-3.0-or-later**. (The npm package
labels itself MIT; that label is wrong for these two files.) Shipping them makes the
whole published add-on GPL-3.0 — **decided 2026-09-30: accept that** (see PROGRESS.md,
"Licences").

The voice models are **not** all MIT, despite the MIT tag on the Hugging Face
collection: each voice's own \`MODEL_CARD\` decides. They are not in this folder — each
listener's Firefox downloads them from Hugging Face — but which ones we offer is still
our choice. See \`PIPER_VOICE_LIST\` in \`src/lib/config.js\`.

## Files

| File | Size | SHA-256 |
| --- | --- | --- |
${files}
`
  );
}

function listVendored() {
  const files = [];
  for (const dir of [PIPER_DIR, ORT_DIR]) {
    for (const entry of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      const bytes = fs.readFileSync(full);
      files.push({
        name: `${path.basename(dir)}/${entry}`,
        size: humanSize(bytes.length),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  }
  return files;
}

function report() {
  let total = 0;
  for (const dir of [PIPER_DIR, ORT_DIR]) {
    for (const entry of fs.readdirSync(dir)) {
      total += fs.statSync(path.join(dir, entry)).size;
    }
  }
  console.log(`Vendored ${humanSize(total)} in total.`);
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

main().catch((error) => {
  console.error(`\nVendoring failed: ${error.message}`);
  process.exit(1);
});

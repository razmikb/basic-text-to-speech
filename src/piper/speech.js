/**
 * The voice, kept loaded between sentences.
 *
 * WHY THIS FILE EXISTS AT ALL — and why it repeats work the vendored library already does.
 * That library's `predict` rebuilds the entire world for every sentence it speaks: it
 * re-reads the 60MB model out of storage, hands those 60MB to the maths engine to be
 * parsed from scratch, boots a fresh 17MB pronunciation engine, and re-parses the voice's
 * configuration. Only the very last step — running the model over the sounds of one
 * sentence — is genuinely per-sentence work.
 *
 * Everything before it is identical for every sentence of every article, and it is slow.
 * Slow here is not merely a wait: the voice is WebAssembly with no worker behind it, so
 * that work blocks the page's one thread solidly, and nothing else runs while it does —
 * which is exactly why pressing pause mid-sentence appeared to do nothing. The button was
 * not ignored; the message carrying it sat in a queue behind the very work it wanted to
 * interrupt.
 *
 * So this file does the expensive things ONCE and holds on to the results. What remains
 * per sentence is the inference itself, which is a fraction of the time.
 *
 * WHY NOT PATCH THE LIBRARY INSTEAD. `src/vendor/` is someone else's code, overwritten
 * wholesale by `npm run vendor`. Anything written there would vanish on the next update
 * without a sound. The library keeps the jobs it already does well — knowing which voices
 * exist, downloading them, storing them — and this file takes over only the speaking.
 *
 * WHAT WAS COPIED, AND WHY IT HAD TO BE. Two pieces below are reimplementations of code
 * inside the vendored library, because it does not export them: the WAV header writer and
 * the way the model's inputs are assembled from its configuration. Both are marked where
 * they appear. They are small, they are pinned by tests, and the alternative was leaving
 * the slow path in place.
 */

/** Where the library keeps downloaded voices. Must match it, or we would not find them. */
const STORAGE_DIRECTORY = 'piper';

/**
 * The library's own download address, used here only to work out stored filenames.
 *
 * It must stay as it is for the same reason the vendoring script refuses to repoint it:
 * the library decides whether a voice is already on this machine by looking for
 * `huggingface.co` in the address, and files are stored under the last part of it.
 */
const HF_BASE = 'https://huggingface.co/diffusionstudio/piper-voices/resolve/main';

/**
 * Turn the model's raw output into a playable WAV.
 *
 * REIMPLEMENTED from the vendored library, which keeps this private. The model produces
 * loose floating-point samples between -1 and 1; an audio element needs a real WAV file,
 * so this writes the 44-byte header by hand and converts the samples to 16-bit.
 *
 * The magic numbers are the four-character tags every WAV file begins with, written as
 * numbers: "RIFF", "WAVE", "fmt " and "data". Pinned by a test against known bytes,
 * because a header wrong by one byte produces silence rather than an error.
 */
export function encodeWav(samples, { channels = 1, sampleRate }) {
  const HEADER_BYTES = 44;
  const view = new DataView(new ArrayBuffer(samples.length * channels * 2 + HEADER_BYTES));

  view.setUint32(0, 1179011410, true); // "RIFF"
  view.setUint32(4, view.buffer.byteLength - 8, true); // everything after this field
  view.setUint32(8, 1163280727, true); // "WAVE"
  view.setUint32(12, 544501094, true); // "fmt "
  view.setUint32(16, 16, true); // length of the format block
  view.setUint16(20, 1, true); // 1 means uncompressed
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, channels * 2 * sampleRate, true); // bytes per second
  view.setUint16(32, channels * 2, true); // bytes per sample, all channels
  view.setUint16(34, 16, true); // bits per sample
  view.setUint32(36, 1635017060, true); // "data"
  view.setUint32(40, 2 * samples.length, true);

  let at = HEADER_BYTES;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    // Clamped rather than left to wrap: a sample past the limit that wraps around becomes
    // a loud click, which is far more noticeable than a fractionally quiet peak.
    if (sample >= 1) view.setInt16(at, 32767, true);
    else if (sample <= -1) view.setInt16(at, -32768, true);
    else view.setInt16(at, (sample * 32768) | 0, true);
    at += 2;
  }

  return view.buffer;
}

/**
 * Read a voice file the library has already downloaded.
 *
 * They live in the browser's private file area under their plain filename. We read them
 * from there rather than fetching: they are on this machine already, and reaching for the
 * network to re-fetch 60MB would defeat the point of having stored it.
 */
async function readStoredFile(url) {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(STORAGE_DIRECTORY, { create: true });
  const name = url.split('/').at(-1);
  const handle = await directory.getFileHandle(name);
  return handle.getFile();
}

/**
 * Keep exactly one prepared voice, and swap it when the voice changes.
 *
 * WHY THIS IS NOT JUST A VARIABLE. Preparing takes seconds, so requests arrive while one is
 * already under way — two tabs, a reload, a voice changed in settings mid-article. Three
 * things must hold, and only the first is obvious:
 *
 *   - Two requests for the SAME voice share one preparation. Otherwise a reload pays the
 *     cost twice.
 *   - Two requests for DIFFERENT voices must NOT share one. Handing the second caller the
 *     first caller's voice would read the article in a voice nobody chose, and nothing
 *     anywhere would report a problem — it would simply sound wrong.
 *   - Only one preparation runs at a time. Two parsed models is 120MB and two blocked
 *     threads, to no purpose, since only one of them can be speaking.
 *
 * Kept here rather than in the page that uses it so it can be tested, which is how the
 * second of those was found at all.
 */
export function createVoiceHolder({ prepare }) {
  let current = null;
  let loading = null;

  return {
    /** The voice as it stands, without preparing anything. Mostly for tests. */
    get current() {
      return current;
    },

    async get(voiceId) {
      // Wait out any preparation already under way, whatever voice it is for. The loop
      // rather than a single check is because waiting is itself a gap in which things
      // change: by the time we wake, the voice we want may have been prepared by someone
      // else, or a third request may have started preparing a different one.
      while (loading) {
        const waitingFor = loading;
        await waitingFor.ready.catch(() => {});
        if (loading === waitingFor) loading = null;
        if (current && current.voiceId === voiceId) return current;
      }

      if (current && current.voiceId === voiceId) return current;

      const attempt = { voiceId };
      attempt.ready = (async () => {
        // Let the old voice go BEFORE parsing the new one. Holding both at once is 60MB
        // wasted at exactly the moment another 60MB is being asked for.
        if (current) {
          await current.release();
          current = null;
        }
        current = await prepare(voiceId);
        return current;
      })();
      // Recorded before anything is awaited, so a second caller arriving in the same turn
      // finds it and waits rather than starting its own.
      loading = attempt;

      try {
        return await attempt.ready;
      } finally {
        if (loading === attempt) loading = null;
      }
    },

    async release() {
      if (loading) await loading.ready.catch(() => {});
      if (current) await current.release();
      current = null;
      loading = null;
    },
  };
}

/**
 * Prepare a voice and keep it warm.
 *
 * Everything slow happens here, once. `generate` afterwards does only the work that
 * genuinely differs from sentence to sentence.
 *
 * The pieces it needs from the outside world arrive as arguments for one practical
 * reason: the real ones are tens of megabytes of WebAssembly that cannot run in a test.
 * The defaults are the real thing, so nothing but a test ever passes them.
 *
 * @param {object} options
 * @param {string} options.voiceId which voice, e.g. `en_US-hfc_female-medium`
 * @param {Record<string, string>} options.paths the library's voice-id to stored-path map
 */
export async function createSpeaker({
  voiceId,
  paths,
  loadRuntime = () => import('../vendor/onnxruntime/ort.wasm.min.mjs'),
  loadPhonemizer = () => import('../vendor/piper/piper-DeOu3H9E.js'),
  readFile = readStoredFile,
  wasmPaths,
  phonemizerPaths,
}) {
  const modelPath = paths?.[voiceId];
  if (!modelPath) throw new Error(`unknown voice "${voiceId}"`);

  const runtime = await loadRuntime();
  const phonemizerModule = await loadPhonemizer();

  // The same settings the library applies. `allowLocalModels` off stops the runtime going
  // looking for models on its own; the thread count is pinned because multi-threaded
  // WebAssembly needs a security mode extension pages do not get.
  runtime.env.allowLocalModels = false;
  runtime.env.wasm.numThreads = 1;
  if (wasmPaths) runtime.env.wasm.wasmPaths = wasmPaths;

  const configFile = await readFile(`${HF_BASE}/${modelPath}.json`);
  const config = JSON.parse(await configFile.text());

  // THE EXPENSIVE PART, and the whole reason this file exists: 60MB parsed once, not once
  // per sentence. Held for as long as this voice is in use.
  const modelFile = await readFile(`${HF_BASE}/${modelPath}`);
  const session = await runtime.InferenceSession.create(await modelFile.arrayBuffer());

  const sampleRate = config.audio.sample_rate;

  // REIMPLEMENTED from the vendored library: which knobs the model expects, and in what
  // order. The three scales control how much variation, how fast, and how much breathiness
  // the voice has; they are properties of the trained voice, not preferences, so they are
  // read from its configuration and passed straight through.
  const noiseScale = config.inference.noise_scale;
  const noiseW = config.inference.noise_w;

  /**
   * How long the voice takes over each sound, at its ordinary pace.
   *
   * This is a property of the trained voice rather than a preference, so speed is applied
   * by SCALING it rather than replacing it — a voice whose natural value is not 1 must
   * still sound like itself at 1x.
   */
  const baseLengthScale = config.inference.length_scale;

  /**
   * Turn a speaking rate into the model's own duration knob.
   *
   * Length is the inverse of speed: to speak 1.5x as fast, each sound lasts 1/1.5 as long.
   *
   * WHY SPEED IS APPLIED HERE RATHER THAN TO THE FINISHED SOUND. Playing samples faster
   * is the same as spinning a record too fast — it shortens the audio AND raises the
   * pitch, which the owner heard immediately as a squeak at the higher settings. Asking
   * the model to speak faster changes only the pace: the voice keeps its own pitch,
   * because it is genuinely speaking more quickly rather than being replayed faster.
   *
   * The cost is that speed is now baked in when a sentence is BUILT, so a sentence
   * already prepared at another speed has to be rebuilt. That is handled by the pipeline,
   * which discards what it has banked when the rate changes.
   */
  const lengthScaleFor = (rate) => {
    const wanted = typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : 1;
    return baseLengthScale / wanted;
  };

  // Some voices are trained on several speakers and must be told which one to use; a
  // single-speaker voice rejects the input entirely, so this is asked rather than assumed.
  const hasSpeakers = Object.keys(config.speaker_id_map ?? {}).length > 0;

  /**
   * The pronunciation engine, booted once and reused.
   *
   * Reuse is the genuinely uncertain part of this file. It is an Emscripten program driven
   * by calling its `main`, and such programs are not generally written expecting to be run
   * twice in one instance. This one looks like it tolerates it — it keeps its runtime
   * alive after `main` returns instead of tearing it down, and nothing guards a second
   * call — but "looks like" is not knowledge. So a failure to go twice drops the held
   * instance and boots a fresh one, permanently, rather than failing the sentence. That
   * fallback costs time; it does not cost the article.
   *
   * If reuse proves unreliable in practice, deleting the `held` branch in `phonemize`
   * leaves a correct, merely slower file. The large win — the 60MB above — is untouched
   * either way.
   */
  let held = null;

  function bootPhonemizer(onLine) {
    return phonemizerModule.createPiperPhonemize({
      // The engine reports its answer by "printing" it, so this is the return value
      // arriving by an unusual door rather than a log line.
      print: (line) => onLine.current?.(line),
      printErr: (line) => {
        throw new Error(line);
      },
      locateFile: (file) => {
        if (!phonemizerPaths) return file;
        if (file.endsWith('.wasm')) return `${phonemizerPaths}.wasm`;
        if (file.endsWith('.data')) return `${phonemizerPaths}.data`;
        return file;
      },
    });
  }

  /** Turn text into the numbered sounds the model actually consumes. */
  async function phonemize(text) {
    const input = JSON.stringify([{ text: text.trim() }]);
    const args = ['-l', config.espeak.voice, '--input', input, '--espeak_data', '/espeak-ng-data'];

    const run = (instance, onLine) => {
      const spoken = new Promise((resolve) => {
        onLine.current = (line) => resolve(JSON.parse(line).phoneme_ids);
      });
      instance.callMain(args);
      return spoken;
    };

    if (held) {
      try {
        return await run(held.instance, held.onLine);
      } catch {
        // It would not go twice after all. Drop it and take the slow path from here on.
        held = null;
      }
    }

    const onLine = { current: null };
    const instance = await bootPhonemizer(onLine);
    const ids = await run(instance, onLine);
    held = { instance, onLine };
    return ids;
  }

  return {
    /** Which voice this is for, so a change of voice can be noticed by the caller. */
    voiceId,

    /**
     * Turn one sentence into sound.
     *
     * WHAT THIS HANDS BACK, AND WHY IT CHANGED. This used to return a finished WAV in a
     * blob. That was the long way round: the model produces loose samples, which were
     * encoded into a WAV, wrapped in a blob, handed to an audio element, and then decoded
     * straight back into samples by the browser — work that ran on the very thread the
     * voice had been starving, which is what every `readyState=0` in the trace was.
     *
     * Raw samples skip all of it. What comes out of the model is already what the sound
     * card wants; Web Audio takes it directly. The encode, the decode, the blob, the
     * object URL and the machinery built to hide their cost are all simply gone.
     *
     * `encodeWav` above is deliberately kept, exported and tested. It is the way back if
     * Web Audio disappoints, and it costs nothing to keep.
     */
    async generate(text, { rate = 1 } = {}) {
      const ids = await phonemize(text);

      const feeds = {
        input: new runtime.Tensor('int64', ids, [1, ids.length]),
        input_lengths: new runtime.Tensor('int64', [ids.length]),
        scales: new runtime.Tensor('float32', [noiseScale, lengthScaleFor(rate), noiseW]),
      };
      if (hasSpeakers) feeds.sid = new runtime.Tensor('int64', [0]);

      const { output } = await session.run(feeds);
      // The sample rate travels WITH the samples rather than being looked up later: they
      // are meaningless apart, and a mismatch is not an error, it is a voice at the wrong
      // pitch — which sounds like a bug in the voice rather than in the plumbing.
      return { samples: output.data, sampleRate };
    },

    /**
     * Let the voice go.
     *
     * Worth doing explicitly: what is being held is 60MB of parsed model, and the browser
     * has no way of knowing we are finished with it. Called when the voice changes.
     */
    async release() {
      held = null;
      try {
        await session.release?.();
      } catch {
        // Already gone, or a runtime that does not offer release. Nothing to salvage.
      }
    },
  };
}

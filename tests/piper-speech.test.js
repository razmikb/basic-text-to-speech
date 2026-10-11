/**
 * Tests for the warm voice — the part that keeps the model loaded between sentences.
 *
 * WHAT THESE CAN AND CANNOT PROVE. The real voice is tens of megabytes of WebAssembly and
 * cannot run here, so the maths engine and the pronunciation engine are stand-ins. That is
 * enough to prove the thing this change is actually about — that the expensive preparation
 * happens once rather than once per sentence — because "how many times was it prepared" is
 * counting, not sound.
 *
 * What it cannot prove is that the audio is right. Only listening does that, which is why
 * the last step of this task is the owner playing a real article.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSpeaker, createVoiceHolder, encodeWav } from '../src/piper/speech.js';

const VOICE = 'en_US-hfc_female-medium';
const PATHS = { [VOICE]: 'en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx' };

/** A voice configuration shaped like the real ones, small enough to read. */
function config({ speakers = {}, lengthScale = 1 } = {}) {
  return {
    audio: { sample_rate: 22050 },
    espeak: { voice: 'en-us' },
    inference: { noise_scale: 0.667, length_scale: lengthScale, noise_w: 0.8 },
    speaker_id_map: speakers,
  };
}

/**
 * Stand-ins for the two heavy engines, each counting how often it was set up.
 *
 * The counts are the point: this whole change is the claim that setting up happens once.
 */
function setup({ speakers = {}, phonemizerGoesTwice = true, run, lengthScale = 1 } = {}) {
  const counts = { sessions: 0, phonemizers: 0, runs: 0, releases: 0 };

  const session = {
    run: async (feeds) => {
      counts.runs += 1;
      if (run) return run(feeds);
      return { output: { data: Float32Array.from([0, 0.5, -0.5]) } };
    },
    release: async () => {
      counts.releases += 1;
    },
  };

  const runtime = {
    env: { allowLocalModels: true, wasm: { numThreads: 8, wasmPaths: null } },
    Tensor: class {
      constructor(type, data, dims) {
        Object.assign(this, { type, data, dims });
      }
    },
    InferenceSession: {
      create: async () => {
        counts.sessions += 1;
        return session;
      },
    },
  };

  // The pronunciation engine answers by "printing" its result, so the fake does too.
  const phonemizer = {
    createPiperPhonemize: async ({ print }) => {
      counts.phonemizers += 1;
      const mine = counts.phonemizers;
      let used = false;
      return {
        callMain: () => {
          // A real Emscripten program may refuse to run a second time in one instance.
          // This fake can be told to behave either way, because which one the real thing
          // does is the open question this design has to survive either answer to.
          if (used && !phonemizerGoesTwice) throw new Error('already ran');
          used = true;
          print(JSON.stringify({ phoneme_ids: [1, 2, mine] }));
        },
      };
    },
  };

  const files = {
    async text() {
      return JSON.stringify(config({ speakers, lengthScale }));
    },
    async arrayBuffer() {
      return new ArrayBuffer(8);
    },
  };

  const create = (overrides = {}) =>
    createSpeaker({
      voiceId: VOICE,
      paths: PATHS,
      loadRuntime: async () => runtime,
      loadPhonemizer: async () => phonemizer,
      readFile: async () => files,
      ...overrides,
    });

  return { create, counts, runtime };
}

test('the model is parsed once, however many sentences are spoken', async () => {
  const { create, counts } = setup();
  const speaker = await create();

  await speaker.generate('One.');
  await speaker.generate('Two.');
  await speaker.generate('Three.');

  assert.equal(counts.runs, 3, 'each sentence still runs the model');
  assert.equal(
    counts.sessions,
    1,
    'the 60MB model must be parsed once — parsing it per sentence is the bug being fixed'
  );
});

test('the pronunciation engine is reused when it tolerates being run twice', async () => {
  const { create, counts } = setup({ phonemizerGoesTwice: true });
  const speaker = await create();

  await speaker.generate('One.');
  await speaker.generate('Two.');

  assert.equal(counts.phonemizers, 1, 'should boot the pronunciation engine once');
});

test('a pronunciation engine that refuses a second run is replaced, not fatal', async () => {
  const { create, counts } = setup({ phonemizerGoesTwice: false });
  const speaker = await create();

  const first = await speaker.generate('One.');
  const second = await speaker.generate('Two.');

  // Samples rather than a blob: generate now hands back what the model actually made,
  // for Web Audio to play directly. See the note on generate in speech.js.
  assert.ok(first.samples.length > 0, 'the first sentence still works');
  assert.ok(second.samples.length > 0, 'and so does the second, on a fresh engine');
  assert.equal(counts.phonemizers, 2, 'it should boot a new one rather than fail');
  assert.equal(counts.sessions, 1, 'and the expensive model is still held throughout');
});

test('releasing lets go of the model', async () => {
  const { create, counts } = setup();
  const speaker = await create();
  await speaker.generate('One.');

  await speaker.release();

  assert.equal(counts.releases, 1, '60MB must be handed back, not merely forgotten');
});

test('a voice that names speakers is told which one; one that does not is not', async () => {
  const withSpeakers = setup({ speakers: { alice: 0, bob: 1 } });
  const speakerVoice = await withSpeakers.create();
  let feeds = null;
  const capture = setup({
    run: (given) => {
      feeds = given;
      return { output: { data: Float32Array.from([0]) } };
    },
  });

  await speakerVoice.generate('One.');

  const plain = await capture.create();
  await plain.generate('One.');
  assert.equal(feeds.sid, undefined, 'a single-speaker voice rejects a speaker id outright');

  let multiFeeds = null;
  const multi = setup({
    speakers: { alice: 0, bob: 1 },
    run: (given) => {
      multiFeeds = given;
      return { output: { data: Float32Array.from([0]) } };
    },
  });
  const multiVoice = await multi.create();
  await multiVoice.generate('One.');
  assert.ok(multiFeeds.sid, 'a multi-speaker voice must be told which speaker to use');
});

test('the runtime is pinned to the settings an extension page can actually use', async () => {
  const { create, runtime } = setup();
  await create({ wasmPaths: 'moz-extension://x/vendor/onnxruntime/' });

  assert.equal(runtime.env.wasm.numThreads, 1, 'multi-threading needs isolation we do not have');
  assert.equal(runtime.env.allowLocalModels, false);
  assert.equal(runtime.env.wasm.wasmPaths, 'moz-extension://x/vendor/onnxruntime/');
});

test('an unknown voice fails immediately rather than half-loading', async () => {
  const { create, counts } = setup();

  await assert.rejects(() => create({ voiceId: 'no-such-voice' }), /unknown voice/);
  assert.equal(counts.sessions, 0, 'nothing expensive should have been started');
});

/**
 * The WAV header is written by hand, copied out of the vendored library. A header wrong by
 * one byte does not throw — it produces silence, which sounds exactly like a broken voice.
 * So it is pinned to known bytes.
 */
test('the WAV header says what a player needs to hear', () => {
  const wav = new DataView(encodeWav(Float32Array.from([0, 1, -1]), { sampleRate: 22050 }));
  const tag = (at) => String.fromCharCode(...[0, 1, 2, 3].map((i) => wav.getUint8(at + i)));

  assert.equal(tag(0), 'RIFF');
  assert.equal(tag(8), 'WAVE');
  assert.equal(tag(12), 'fmt ');
  assert.equal(tag(36), 'data');

  assert.equal(wav.getUint16(22, true), 1, 'one channel');
  assert.equal(wav.getUint32(24, true), 22050, 'the sample rate the voice was trained at');
  assert.equal(wav.getUint16(34, true), 16, '16 bits per sample');
  assert.equal(wav.byteLength, 44 + 3 * 2, 'header plus two bytes per sample');
  assert.equal(wav.getUint32(4, true), wav.byteLength - 8, 'the size field counts what follows it');
  assert.equal(wav.getUint32(40, true), 6, 'and the data block states its own length');
});

test('samples past the limit are clamped, because wrapping is an audible click', () => {
  const wav = new DataView(encodeWav(Float32Array.from([2, -2]), { sampleRate: 22050 }));

  assert.equal(wav.getInt16(44, true), 32767, 'too loud becomes as loud as allowed');
  assert.equal(wav.getInt16(46, true), -32768, 'not a wrap to the opposite extreme');
});

/**
 * The holder: which prepared voice is kept, and what happens when requests overlap.
 *
 * Preparing takes seconds in the real thing, so overlapping requests are ordinary rather
 * than exotic — two tabs, a reload, a voice changed mid-article. The mixup test below
 * exists because the first version of this code had exactly that bug.
 */
function voices() {
  const prepared = [];
  const holder = createVoiceHolder({
    prepare: async (voiceId) => {
      const pending = {};
      const voice = {
        voiceId,
        released: 0,
        release: async () => {
          voice.released += 1;
        },
      };
      const ready = new Promise((resolve) => {
        pending.finish = () => resolve(voice);
      });
      prepared.push({ voiceId, voice, finish: pending.finish });
      return ready;
    },
  });
  const waiting = (voiceId) => prepared.find((p) => p.voiceId === voiceId);
  return { holder, prepared, waiting };
}

/** Let queued promise work run, without waiting on real time. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

test('a voice already prepared is handed back without preparing again', async () => {
  const { holder, prepared, waiting } = voices();

  const first = holder.get(VOICE);
  await settled();
  waiting(VOICE).finish();
  await first;

  const second = await holder.get(VOICE);

  assert.equal(prepared.length, 1, 'the second request must reuse the prepared voice');
  assert.equal(second.voiceId, VOICE);
});

test('two requests for the same voice at once share one preparation', async () => {
  const { holder, prepared, waiting } = voices();

  const both = Promise.all([holder.get(VOICE), holder.get(VOICE)]);
  await settled();
  assert.equal(prepared.length, 1, 'a reload must not pay the loading cost twice');

  waiting(VOICE).finish();
  const [a, b] = await both;
  assert.equal(a, b, 'and both callers get the same voice');
});

test('a request for a different voice never receives the one being prepared', async () => {
  const { holder, waiting } = voices();

  const first = holder.get(VOICE);
  await settled();
  const second = holder.get('de_DE-thorsten-medium');

  waiting(VOICE).finish();
  await first;
  await settled();
  waiting('de_DE-thorsten-medium').finish();

  const got = await second;
  assert.equal(
    got.voiceId,
    'de_DE-thorsten-medium',
    'asking for one voice and receiving another would read the article in a voice nobody chose'
  );
});

test('changing voice lets the old one go before parsing the new one', async () => {
  const { holder, waiting } = voices();

  const first = holder.get(VOICE);
  await settled();
  waiting(VOICE).finish();
  const original = await first;

  const second = holder.get('de_DE-thorsten-medium');
  await settled();
  assert.equal(original.released, 1, '60MB must be handed back before another 60MB is asked for');

  waiting('de_DE-thorsten-medium').finish();
  await second;
});

test('a preparation that fails does not wedge the next attempt', async () => {
  let attempts = 0;
  const holder = createVoiceHolder({
    prepare: async (voiceId) => {
      attempts += 1;
      if (attempts === 1) throw new Error('model would not load');
      return { voiceId, release: async () => {} };
    },
  });

  await assert.rejects(() => holder.get(VOICE), /model would not load/);

  // Checked without waiting, because that is the property at issue: a failure must leave
  // nothing behind that a later request has to wait on. Asking again would hide the fault,
  // since the next request tidies up a stale attempt on its way past.
  const second = holder.get(VOICE);
  assert.equal(attempts, 2, 'the retry must start at once, not queue behind the failed load');
  assert.equal((await second).voiceId, VOICE, 'and it must produce a usable voice');
});

// ---------------------------------------------------------------------------
// Speed
// ---------------------------------------------------------------------------

/** Pull the three scales out of what the model was actually handed. */
const scalesOf = (feeds) => Array.from(feeds.scales.data ?? feeds.scales);

test('speed is asked of the voice, as a duration rather than a playback rate', async () => {
  /*
   * WHY THIS MATTERS MORE THAN IT LOOKS. Speed used to be applied to the finished sound
   * by replaying it faster, which shortens the audio AND raises the pitch — the owner
   * heard it immediately as a squeak at the higher settings. Asking the model to speak
   * faster changes only the pace, because the voice is genuinely speaking more quickly
   * rather than being played back faster.
   *
   * `length_scale` is how long each sound LASTS, so it is the inverse of speed. Getting
   * that backwards would make the speed button slow the voice down, which is the sort of
   * thing that is obvious the moment it is heard and invisible in a diff.
   */
  let feeds = null;
  const { create } = setup({
    run: (given) => {
      feeds = given;
      return { output: { data: Float32Array.from([0]) } };
    },
  });
  const speaker = await create();

  await speaker.generate('One.', { rate: 2 });
  assert.equal(scalesOf(feeds)[1], 0.5, 'twice the speed is half the duration');

  await speaker.generate('One.', { rate: 0.5 });
  assert.equal(scalesOf(feeds)[1], 2, 'half the speed is twice the duration');

  await speaker.generate('One.');
  assert.equal(scalesOf(feeds)[1], 1, 'no speed asked for means the voice is left as it is');
});

test('speed scales the voice own pace rather than replacing it', async () => {
  // length_scale is a property of the trained voice, not a preference. A voice that is
  // naturally slow must still sound like itself at 1x, so speed multiplies its value
  // rather than overwriting it — otherwise every voice would snap to the same pace the
  // moment the speed button was touched.
  let feeds = null;
  const { create } = setup({
    lengthScale: 1.2,
    run: (given) => {
      feeds = given;
      return { output: { data: Float32Array.from([0]) } };
    },
  });
  const speaker = await create();

  await speaker.generate('One.');
  assert.equal(scalesOf(feeds)[1], 1.2, 'at 1x the voice keeps its own natural pace');

  await speaker.generate('One.', { rate: 2 });
  assert.ok(
    Math.abs(scalesOf(feeds)[1] - 0.6) < 1e-9,
    'and speed scales that pace rather than discarding it'
  );
});

test('a nonsense speed leaves the voice at its own pace', async () => {
  // Rates arrive from stored settings and from messages across a thread boundary, so a
  // bad one must be ignored rather than handed to the model, where it would produce
  // silence or a crash rather than a sentence.
  let feeds = null;
  const { create } = setup({
    run: (given) => {
      feeds = given;
      return { output: { data: Float32Array.from([0]) } };
    },
  });
  const speaker = await create();

  for (const bad of [0, -1, Number.NaN, Infinity, 'fast', null]) {
    await speaker.generate('One.', { rate: bad });
    assert.equal(scalesOf(feeds)[1], 1, `a rate of ${String(bad)} must not reach the model`);
  }
});

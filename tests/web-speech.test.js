import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebSpeechEngine, whenVoicesReady } from '../src/lib/engines/web-speech.js';
import { isEngine } from '../src/lib/engines/engine.js';

/**
 * A stand-in for the browser's speechSynthesis, so the engine can be tested without a
 * browser. It mimics the parts that matter: speaking is asynchronous, cancel interrupts,
 * and the voice list can start out empty the way real browsers do.
 */
function fakeSynth({ voices = [] } = {}) {
  const synth = {
    speaking: false,
    paused: false,
    onvoiceschanged: null,
    utterance: null,
    cancelled: 0,
    getVoices: () => voices,
    speak(utterance) {
      synth.speaking = true;
      synth.utterance = utterance;
    },
    pause() {
      synth.paused = true;
    },
    resume() {
      synth.paused = false;
    },
    cancel() {
      synth.cancelled += 1;
      synth.speaking = false;
      const utterance = synth.utterance;
      synth.utterance = null;
      if (utterance && utterance.onerror) utterance.onerror({ error: 'interrupted' });
    },
    /** Pretend the voice finished reading the text. */
    finish() {
      synth.speaking = false;
      const utterance = synth.utterance;
      synth.utterance = null;
      if (utterance && utterance.onend) utterance.onend();
    },
  };
  return synth;
}

class FakeUtterance {
  constructor(text) {
    this.text = text;
  }
}

const noopTimers = { setInterval: () => 1, clearInterval: () => {} };

const build = (synth) => createWebSpeechEngine({ synth, Utterance: FakeUtterance, ...noopTimers });

const VOICES = [
  { name: 'Microsoft David', lang: 'en-US', default: true },
  { name: 'Microsoft Hazel', lang: 'en-GB' },
  { name: 'Microsoft Hedda', lang: 'de-DE' },
];

test('provides the whole voice engine interface', () => {
  assert.ok(isEngine(build(fakeSynth())));
});

test('speaking finishes when the voice reaches the end', async () => {
  const synth = fakeSynth();
  const engine = build(synth);

  const done = engine.speak('Hello there.');
  assert.equal(synth.utterance.text, 'Hello there.');

  synth.finish();
  assert.equal(await done, 'ended');
});

test('reports being stopped rather than failing when cancelled', async () => {
  const synth = fakeSynth();
  const engine = build(synth);

  const done = engine.speak('Hello there.');
  engine.stop();

  assert.equal(await done, 'stopped');
  assert.equal(synth.cancelled, 1);
});

test('a genuine failure is reported as an error, not a stop', async () => {
  const synth = fakeSynth();
  const engine = build(synth);

  const done = engine.speak('Hello there.');
  synth.utterance.onerror({ error: 'synthesis-failed' });

  assert.equal(await done, 'error');
});

test('empty text finishes immediately instead of hanging', async () => {
  const synth = fakeSynth();
  assert.equal(await build(synth).speak('   '), 'ended');
  assert.equal(synth.utterance, null, 'nothing should have been sent to the voice');
});

test('passes speed, pitch and volume to the voice', () => {
  const synth = fakeSynth();
  build(synth).speak('Hello.', { rate: 1.5, pitch: 0.8, volume: 0.5, lang: 'en-GB' });

  assert.equal(synth.utterance.rate, 1.5);
  assert.equal(synth.utterance.pitch, 0.8);
  assert.equal(synth.utterance.volume, 0.5);
  assert.equal(synth.utterance.lang, 'en-GB');
});

test('uses the requested voice when it is installed', () => {
  const synth = fakeSynth({ voices: VOICES });
  build(synth).speak('Hello.', { voiceName: 'Microsoft Hazel' });

  assert.equal(synth.utterance.voice.name, 'Microsoft Hazel');
});

test('falls back to a voice in the right language when the named one is missing', () => {
  const synth = fakeSynth({ voices: VOICES });
  build(synth).speak('Hello.', { voiceName: 'Not Installed', lang: 'de-DE' });

  assert.equal(synth.utterance.voice.name, 'Microsoft Hedda');
});

test('matches the language family when the exact locale is missing', () => {
  const synth = fakeSynth({ voices: VOICES });
  build(synth).speak('Hello.', { lang: 'en-AU' });

  assert.equal(synth.utterance.voice.lang.slice(0, 2), 'en');
});

test('leaves the voice to the browser when nothing matches', () => {
  const synth = fakeSynth({ voices: VOICES });
  build(synth).speak('Hello.', { lang: 'ja-JP' });

  assert.equal(synth.utterance.voice, undefined);
});

test('pause and resume drive the browser', () => {
  const synth = fakeSynth();
  const engine = build(synth);

  engine.speak('Hello there.');
  engine.pause();
  assert.ok(synth.paused);

  engine.resume();
  assert.ok(!synth.paused);
});

test('lists the installed voices', () => {
  const listed = build(fakeSynth({ voices: VOICES })).listVoices();

  assert.equal(listed.length, 3);
  assert.deepEqual(listed[0], { name: 'Microsoft David', lang: 'en-US', default: true });
});

test('word boundaries are reported to whoever subscribed', () => {
  const synth = fakeSynth();
  const engine = build(synth);
  const seen = [];
  engine.onBoundary((event) => seen.push(event));

  engine.speak('Hello there.');
  synth.utterance.onboundary({ charIndex: 6, charLength: 5 });

  assert.deepEqual(seen, [{ charIndex: 6, charLength: 5 }]);
});

test('unsubscribing stops the boundary callbacks', () => {
  const synth = fakeSynth();
  const engine = build(synth);
  const seen = [];
  const off = engine.onBoundary((event) => seen.push(event));

  engine.speak('Hello there.');
  off();
  synth.utterance.onboundary({ charIndex: 0, charLength: 5 });

  assert.equal(seen.length, 0);
});

test('a listener that throws does not break the speech', () => {
  const synth = fakeSynth();
  const engine = build(synth);
  engine.onBoundary(() => {
    throw new Error('bad listener');
  });

  engine.speak('Hello there.');
  assert.doesNotThrow(() => synth.utterance.onboundary({ charIndex: 0, charLength: 1 }));
});

test('refuses to start in a browser with no speech support', () => {
  assert.throws(() => createWebSpeechEngine({ synth: null, Utterance: null }), /not available/);
});

test('waits for the voice list to arrive before speaking', async () => {
  let voices = [];
  const synth = fakeSynth();
  synth.getVoices = () => voices;

  const ready = whenVoicesReady({ synth, setTimeout: () => {}, timeoutMs: 50 });

  voices = VOICES;
  synth.onvoiceschanged();

  await ready;
  assert.equal(synth.getVoices().length, 3);
});

test('does not hang when the voice list never arrives', async () => {
  const synth = fakeSynth();
  synth.getVoices = () => [];

  await whenVoicesReady({ synth, setTimeout: (fn) => fn(), timeoutMs: 0 });
});

test('the keepalive nudge must not undo a pause the user asked for', () => {
  const synth = fakeSynth();
  let nudge = null;
  const engine = createWebSpeechEngine({
    synth,
    Utterance: FakeUtterance,
    setInterval: (fn) => {
      nudge = fn;
      return 1;
    },
    clearInterval: () => {},
  });

  engine.speak('A long article that takes more than ten seconds to read aloud.');
  engine.pause();
  assert.ok(synth.paused, 'the user asked for a pause');

  // The keepalive timer fires while the user is still paused.
  if (nudge) nudge();

  assert.ok(synth.paused, 'speech must still be paused after the keepalive runs');
});

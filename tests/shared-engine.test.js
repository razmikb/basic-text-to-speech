import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebSpeechEngine } from '../src/lib/engines/web-speech.js';
import { createReader } from '../src/lib/reader.js';
import { createFakeEngine } from './helpers/fake-engine.js';

/**
 * The bug the owner hit: pause an article in one tab, and NO other tab will read
 * anything until the first tab is closed - at which point the second tab suddenly
 * starts talking by itself.
 *
 * The cause is that the browser has ONE speechSynthesis for the whole browser, not one
 * per tab. Every tab's speech goes into the same queue, and `synth.paused` /
 * `synth.speaking` describe the browser, not the page. A tab that pauses therefore
 * holds the shared queue closed for everybody.
 *
 * These tests model that faithfully: one `sharedSynth` standing in for the browser,
 * with a separate engine built on it per "tab", exactly as two content scripts would.
 */

/**
 * A stand-in for the browser's single shared speechSynthesis.
 *
 * The critical detail is the queue: speak() while paused does NOT start speaking, it
 * waits - which is precisely why a paused tab silences the others.
 */
function sharedSynth() {
  const synth = {
    speaking: false,
    paused: false,
    current: null,
    queue: [],
    getVoices: () => [],

    speak(utterance) {
      synth.queue.push(utterance);
      synth.pump();
    },

    /** Start the next utterance if the engine is free and not being held paused. */
    pump() {
      if (synth.paused || synth.speaking) return;
      const next = synth.queue.shift();
      if (!next) return;
      synth.speaking = true;
      synth.current = next;
    },

    pause() {
      synth.paused = true;
    },

    resume() {
      synth.paused = false;
      synth.pump();
    },

    cancel() {
      const current = synth.current;
      synth.current = null;
      synth.queue = [];
      synth.speaking = false;
      synth.paused = false;
      if (current && current.onerror) current.onerror({ error: 'interrupted' });
      synth.pump();
    },

    /** The voice reaches the end of whatever it is currently reading. */
    finish() {
      const current = synth.current;
      synth.current = null;
      synth.speaking = false;
      if (current && current.onend) current.onend();
      synth.pump();
    },

    /** What is actually being read ALOUD right now - paused speech makes no sound. */
    nowSpeaking() {
      return synth.speaking && !synth.paused && synth.current ? synth.current.text : null;
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

/** One "tab": its own engine, on the browser's one shared synthesiser. */
function tab(synth) {
  return createWebSpeechEngine({ synth, Utterance: FakeUtterance, ...noopTimers });
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * The old engine's pause/stop, kept verbatim so the test proves the fix is needed.
 *
 * The whole defect is in that first line: it consulted `synth.paused`, a browser-wide
 * flag, and then paused the browser-wide engine on behalf of one page.
 */
function oldTab(synth) {
  return {
    speak: (text) => synth.speak(new FakeUtterance(text)),
    pause() {
      if (synth.speaking && !synth.paused) synth.pause();
    },
    stop: () => synth.cancel(),
  };
}

/**
 * The second bug the owner hit, after the first fix: press play in a second tab while
 * the first is still reading, and the two articles TAKE TURNS. A sentence of article
 * one, then a sentence of article two, back and forth, both audible in one stream.
 *
 * Same root cause as before, different face: one shared queue. Both tabs push sentences
 * into it and the browser plays them in arrival order. Reading sentence-by-sentence is
 * what makes them alternate so neatly.
 */
test('REGRESSION: two playing tabs used to interleave their articles', () => {
  const synth = sharedSynth();
  const heard = [];

  // Two tabs, both reading, neither aware of the other - the old behaviour.
  const one = oldTab(synth);
  const two = oldTab(synth);

  one.speak('ONE sentence 1.');
  two.speak('TWO sentence 1.');
  one.speak('ONE sentence 2.');
  two.speak('TWO sentence 2.');

  for (let i = 0; i < 4; i += 1) {
    heard.push(synth.nowSpeaking());
    synth.finish();
  }

  assert.deepEqual(
    heard,
    ['ONE sentence 1.', 'TWO sentence 1.', 'ONE sentence 2.', 'TWO sentence 2.'],
    'this is the bug the owner heard: two articles alternating in one ear'
  );
});

test('REGRESSION: a tab that pauses used to block every other tab', () => {
  const synth = sharedSynth();
  const tabOne = oldTab(synth);

  tabOne.speak('Article one.');
  assert.equal(synth.nowSpeaking(), 'Article one.');

  tabOne.pause();

  // A second tab tries to read. The old code left the shared engine paused, so this
  // utterance joined the queue and never started.
  const tabTwo = oldTab(synth);
  tabTwo.speak('Article two.');

  assert.equal(synth.nowSpeaking(), null, 'this is the bug: tab two is stuck behind tab one');
  assert.equal(synth.queue.length, 1, 'tab two is queued, waiting on the shared engine');

  // ...and whatever un-pauses the shared engine - closing tab one, or its pagehide
  // handler firing - is what let the queued article burst into life on its own.
  synth.resume();
  assert.equal(synth.nowSpeaking(), 'Article one.', 'the held article resumes first');
  synth.finish();
  assert.equal(synth.nowSpeaking(), 'Article two.', 'then tab two starts, unasked');
});

test('the fixed engine no longer blocks a second tab when it pauses', () => {
  const synth = sharedSynth();
  const tabOne = tab(synth);
  const tabTwo = tab(synth);

  tabOne.speak('Article one.');
  tabOne.pause();

  // Tab one is hidden while paused, so it hands the engine back.
  tabOne.release();
  tabTwo.speak('Article two.');

  assert.equal(synth.nowSpeaking(), 'Article two.', 'tab two starts straight away');
  assert.equal(synth.queue.length, 0, 'nothing is left stuck in the shared queue');
});

test('releasing the voice frees the shared engine for other tabs', () => {
  const synth = sharedSynth();
  const tabOne = tab(synth);

  tabOne.speak('Article one.');
  tabOne.pause();
  assert.ok(tabOne.isPaused());

  // This is what a hidden, paused tab now does.
  assert.equal(tabOne.release(), true, 'release reports that it was holding the engine');
  assert.equal(synth.paused, false, 'the shared engine must not be left paused');

  const tabTwo = tab(synth);
  tabTwo.speak('Article two.');
  assert.equal(synth.nowSpeaking(), 'Article two.', 'the second tab reads immediately');
});

test('releasing a paused tab does not make it speak', () => {
  const synth = sharedSynth();
  const tabOne = tab(synth);

  tabOne.speak('Article one.');
  tabOne.pause();
  tabOne.release();

  assert.equal(synth.nowSpeaking(), null, 'a hidden tab must never burst into speech');
});

test('releasing never lets a left-behind tab blurt out audio', () => {
  const synth = sharedSynth();

  // Record every moment the engine was actually making sound. Releasing must not
  // produce a single one after the pause: resuming a paused engine to cancel it would.
  const audible = [];
  const watch = () => {
    if (synth.speaking && !synth.paused && synth.current) audible.push(synth.current.text);
  };
  for (const name of ['pause', 'resume', 'cancel', 'speak']) {
    const original = synth[name].bind(synth);
    synth[name] = (...args) => {
      const result = original(...args);
      watch();
      return result;
    };
  }

  const tabOne = tab(synth);
  tabOne.speak('Article one.');
  tabOne.pause();

  audible.length = 0; // Everything from here on happens after the user walked away.
  tabOne.release();

  assert.deepEqual(audible, [], 'a tab being left must make no sound on the way out');
  assert.equal(synth.paused, false, 'and it must not leave the shared engine held');
});

test('release on an idle tab does nothing and says so', () => {
  const synth = sharedSynth();
  const idle = tab(synth);
  assert.equal(idle.release(), false);
});

test('one tab cannot pause another tab speech', () => {
  const synth = sharedSynth();
  const tabOne = tab(synth);
  const tabTwo = tab(synth);

  tabOne.speak('Article one.');
  assert.equal(synth.nowSpeaking(), 'Article one.');

  // Tab two never started speaking, so its pause must be ignored entirely.
  tabTwo.pause();

  assert.equal(synth.paused, false, 'a silent tab must not pause the browser');
  assert.equal(synth.nowSpeaking(), 'Article one.');
});

test('a tab reports its own state, not the browser-wide one', () => {
  const synth = sharedSynth();
  const tabOne = tab(synth);
  const tabTwo = tab(synth);

  tabOne.speak('Article one.');

  assert.equal(tabOne.isSpeaking(), true);
  assert.equal(tabTwo.isSpeaking(), false, 'tab two must not think it is speaking');

  tabOne.pause();
  assert.equal(tabOne.isPaused(), true);
  assert.equal(tabTwo.isPaused(), false, 'tab two must not think it is paused');
});

test('a released reader keeps its place and resumes on the same sentence', async () => {
  const engine = createFakeEngine();
  const sentences = [
    { text: 'One.', blockIndex: 0, start: 0, end: 4 },
    { text: 'Two.', blockIndex: 0, start: 5, end: 9 },
    { text: 'Three.', blockIndex: 0, start: 10, end: 16 },
  ];
  const reader = createReader({ engine, sentences });

  reader.play();
  await settle();
  await engine.finish(); // the first sentence finishes
  await settle();
  assert.equal(reader.getIndex(), 1, 'now on the second sentence');

  reader.pause();
  assert.equal(reader.getState(), 'paused');

  // The tab is hidden while paused: hand the voice back.
  assert.equal(reader.releaseVoice(), true);
  await settle();

  assert.equal(engine.released, 1, 'the engine was released, not stopped');
  assert.equal(reader.getState(), 'paused', 'still paused, not reset');
  assert.equal(reader.getIndex(), 1, 'the place is kept');

  // Back in the tab: press play.
  reader.play();
  await settle();

  assert.equal(reader.getState(), 'playing');
  assert.equal(reader.getIndex(), 1);
  assert.equal(
    engine.spoken.at(-1).text,
    'Two.',
    'it carries on from the sentence it was paused on'
  );
});

test('releasing does not skip ahead when the sentence was mid-flight', async () => {
  const engine = createFakeEngine();
  const sentences = [
    { text: 'One.', blockIndex: 0, start: 0, end: 4 },
    { text: 'Two.', blockIndex: 0, start: 5, end: 9 },
  ];
  const reader = createReader({ engine, sentences });

  reader.play();
  await settle();

  // Released while the first sentence is still being spoken: it must not count as read.
  reader.releaseVoice();
  await settle();

  assert.equal(reader.getIndex(), 0, 'the abandoned sentence is not counted as read');
  assert.equal(reader.getState(), 'paused');

  reader.play();
  await settle();
  assert.equal(engine.spoken.at(-1).text, 'One.', 'it re-reads the sentence it abandoned');
});

test('releasing an idle reader changes nothing', () => {
  const engine = createFakeEngine();
  const reader = createReader({
    engine,
    sentences: [{ text: 'One.', blockIndex: 0, start: 0, end: 4 }],
  });

  assert.equal(reader.releaseVoice(), false);
  assert.equal(reader.getState(), 'idle');
  assert.equal(engine.released, 0);
});

test('a finished reader is not dragged back to paused by a release', async () => {
  const engine = createFakeEngine();
  const reader = createReader({
    engine,
    sentences: [{ text: 'Only.', blockIndex: 0, start: 0, end: 5 }],
  });

  reader.play();
  await settle();
  await engine.finish();
  await settle();
  assert.equal(reader.getState(), 'finished');

  assert.equal(reader.releaseVoice(), false, 'nothing is being held once it has finished');
  assert.equal(reader.getState(), 'finished');
});

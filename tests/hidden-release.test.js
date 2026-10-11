/**
 * Letting go of the voice when the tab is hidden — and, more importantly, NOT letting go
 * of a voice nobody else is waiting for.
 *
 * The rule exists for the browser's speechSynthesis, which is ONE engine shared by every
 * tab: a page that walks away holding it paused silently blocks every other page from
 * speaking. Releasing it costs that page its place and is worth paying.
 *
 * Piper is not that. It runs in the add-on's own page and no other tab queues for it, so
 * releasing buys nothing and costs everything: the audio already built is thrown away,
 * the position is lost, and the listener comes back to silence.
 *
 * THE FAULT THIS PINS, found by the owner on 2026-09-14. Pause an article, switch tabs to
 * write a note, come back, press play — silence. The recipe needed both halves, which is
 * why it looked random: releasing only happens on a PAUSED hidden page, so switching away
 * mid-sentence was always fine and switching away after a pause was not.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReader } from '../src/lib/reader.js';
import { createFakeEngine } from './helpers/fake-engine.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Sentences as the reader expects them: text plus where it sits on the page. */
function asSentences(texts) {
  return texts.map((text, i) => ({ text, blockIndex: 0, start: i, end: i + 1 }));
}

/**
 * The content script's releaseIfHidden, mirroring src/content.js.
 *
 * Copied rather than imported because content.js runs inside a page and cannot be loaded
 * here — the same reason tab-coordination.test.js mirrors the background script.
 */
function releaseIfHidden(reader, visibility) {
  if (visibility !== 'hidden') return false;
  if (reader.getState() !== 'paused') return false;
  if (!reader.sharesVoice()) return false;
  return reader.releaseVoice();
}

/** A fake engine that answers the shared-or-not question. */
function engineThatShares(shares) {
  const engine = createFakeEngine();
  if (shares === undefined) return engine; // Says nothing, like an older engine.
  engine.sharesVoice = () => shares;
  return engine;
}

test('a paused hidden tab keeps an unshared voice, and its place with it', async () => {
  const engine = engineThatShares(false);
  const reader = createReader({ engine, sentences: asSentences(['One.', 'Two.', 'Three.']) });

  reader.play();
  await settle();
  reader.pause();

  const released = releaseIfHidden(reader, 'hidden');

  assert.equal(released, false, 'nothing is waiting for this voice, so nothing is freed');
  assert.equal(
    engine.isSpeaking() || engine.isPaused(),
    true,
    'the engine must still hold the sentence, so play() resumes instead of rebuilding'
  );
});

test('a paused hidden tab still lets go of a voice the whole browser shares', async () => {
  const engine = engineThatShares(true);
  const reader = createReader({ engine, sentences: asSentences(['One.', 'Two.', 'Three.']) });

  reader.play();
  await settle();
  reader.pause();

  assert.equal(
    releaseIfHidden(reader, 'hidden'),
    true,
    'other tabs are blocked while this one holds the shared engine'
  );
});

test('an engine that does not say is treated as shared', async () => {
  const engine = engineThatShares(undefined);
  const reader = createReader({ engine, sentences: asSentences(['One.', 'Two.']) });

  reader.play();
  await settle();
  reader.pause();

  assert.equal(
    releaseIfHidden(reader, 'hidden'),
    true,
    'silence must mean the old behaviour, never the new one — releasing too much merely ' +
      'costs a position, releasing too little blocks every other tab'
  );
});

test('a visible paused tab never releases, shared or not', async () => {
  const engine = engineThatShares(true);
  const reader = createReader({ engine, sentences: asSentences(['One.', 'Two.']) });

  reader.play();
  await settle();
  reader.pause();

  assert.equal(releaseIfHidden(reader, 'visible'), false);
});

test('a hidden tab that is still PLAYING keeps the voice either way', async () => {
  const engine = engineThatShares(true);
  const reader = createReader({ engine, sentences: asSentences(['One.', 'Two.']) });

  reader.play();
  await settle();

  assert.equal(
    releaseIfHidden(reader, 'hidden'),
    false,
    'listening while working in another tab is the whole point'
  );
});

/**
 * The part the owner actually experienced: what it costs to release the wrong voice.
 *
 * Pressing play after a release cannot resume, because there is nothing held to resume —
 * the sentence has to be built again from nothing. For Piper that is seconds of silence
 * where there should have been none.
 */
test('keeping an unshared voice means play resumes rather than rebuilding', async () => {
  const engine = engineThatShares(false);
  const reader = createReader({ engine, sentences: asSentences(['One.', 'Two.', 'Three.']) });

  reader.play();
  await settle();
  reader.pause();

  releaseIfHidden(reader, 'hidden');

  const spokenBefore = engine.spoken.length;
  reader.play();
  await settle();

  assert.equal(
    engine.spoken.length,
    spokenBefore,
    'the sentence was still in hand, so it must not have been asked for a second time'
  );
});

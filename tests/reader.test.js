import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReader, buildSentences } from '../src/lib/reader.js';
import { isEngine, ENGINE_METHODS, OPTIONAL_ENGINE_METHODS } from '../src/lib/engines/engine.js';
import { createFakeEngine } from './helpers/fake-engine.js';

/** Wait for the reader's own promise chain to settle before asserting. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const BLOCKS = [{ text: 'The bridge opened. It cost a lot.' }, { text: 'Nobody complained.' }];

test('turns blocks into a flat list of sentences', () => {
  assert.deepEqual(
    buildSentences(BLOCKS).map((s) => s.text),
    ['The bridge opened.', 'It cost a lot.', 'Nobody complained.']
  );
});

test('each sentence remembers which block it came from', () => {
  const sentences = buildSentences(BLOCKS);
  assert.deepEqual(
    sentences.map((s) => s.blockIndex),
    [0, 0, 1]
  );
});

test('survives blocks that are empty or malformed', () => {
  assert.equal(buildSentences([{ text: '' }, {}, null, { text: 'Fine.' }]).length, 1);
  assert.deepEqual(buildSentences(null), []);
});

test('the fake engine satisfies the engine interface', () => {
  assert.ok(isEngine(createFakeEngine()));
  assert.ok(!isEngine({}));
  assert.ok(!isEngine(null));
  // Deliberately exact: adding to the engine contract means every engine, present and
  // future, has to grow a method, so it should never happen by accident.
  assert.equal(ENGINE_METHODS.length, 8);
});

test('play speaks the first sentence', async () => {
  const engine = createFakeEngine();
  const reader = createReader({ engine, sentences: buildSentences(BLOCKS) });

  reader.play();
  await settle();

  assert.equal(engine.spoken.length, 1);
  assert.equal(engine.spoken[0].text, 'The bridge opened.');
  assert.equal(reader.getState(), 'playing');
});

test('moves to the next sentence when one finishes', async () => {
  const engine = createFakeEngine();
  const reader = createReader({ engine, sentences: buildSentences(BLOCKS) });

  reader.play();
  await settle();
  await engine.finish();
  await settle();

  assert.equal(engine.spoken.length, 2);
  assert.equal(engine.spoken[1].text, 'It cost a lot.');
  assert.equal(reader.getIndex(), 1);
});

test('reads a whole article to the end and reports finishing', async () => {
  const engine = createFakeEngine();
  const reader = createReader({ engine, sentences: buildSentences(BLOCKS) });
  let finished = false;
  reader.on('finished', () => {
    finished = true;
  });

  reader.play();
  await settle();
  for (let i = 0; i < 3; i++) {
    await engine.finish();
    await settle();
  }

  assert.equal(engine.spoken.length, 3);
  assert.ok(finished, 'the reader must announce that the article ended');
  assert.equal(reader.getState(), 'finished');
});

test('pause holds the voice and resume continues it', async () => {
  const engine = createFakeEngine();
  const reader = createReader({ engine, sentences: buildSentences(BLOCKS) });

  reader.play();
  await settle();
  reader.pause();

  assert.equal(reader.getState(), 'paused');
  assert.ok(engine.isPaused(), 'the engine must actually be paused');

  reader.play();
  assert.equal(reader.getState(), 'playing');
  assert.ok(!engine.isPaused());
  assert.equal(engine.spoken.length, 1, 'resuming must not re-speak the sentence from the start');
});

test('toggle plays then pauses', async () => {
  const engine = createFakeEngine();
  const reader = createReader({ engine, sentences: buildSentences(BLOCKS) });

  reader.toggle();
  await settle();
  assert.equal(reader.getState(), 'playing');

  reader.toggle();
  assert.equal(reader.getState(), 'paused');
});

test('stop silences the voice and returns to the start', async () => {
  const engine = createFakeEngine();
  const reader = createReader({ engine, sentences: buildSentences(BLOCKS) });

  reader.play();
  await settle();
  await engine.finish();
  await settle();
  reader.stop();
  await settle();

  assert.equal(reader.getState(), 'idle');
  assert.equal(reader.getIndex(), 0);
  assert.equal(engine.spoken.length, 2, 'stopping must not start another sentence');
});

test('skipping forward speaks the sentence after the current one', async () => {
  const engine = createFakeEngine();
  const reader = createReader({ engine, sentences: buildSentences(BLOCKS) });

  reader.play();
  await settle();
  reader.skip(1);
  await settle();

  assert.equal(reader.getIndex(), 1);
  assert.equal(engine.spoken.at(-1).text, 'It cost a lot.');
});

test('skipping back past the beginning stays on the first sentence', async () => {
  const engine = createFakeEngine();
  const reader = createReader({ engine, sentences: buildSentences(BLOCKS) });

  reader.play();
  await settle();
  reader.skip(-5);
  await settle();

  assert.equal(reader.getIndex(), 0);
});

test('skipping past the end stays on the last sentence', async () => {
  const engine = createFakeEngine();
  const reader = createReader({ engine, sentences: buildSentences(BLOCKS) });

  reader.play();
  await settle();
  reader.skip(99);
  await settle();

  assert.equal(reader.getIndex(), 2);
});

test('a sentence finishing after a skip does not jump the position', async () => {
  const engine = createFakeEngine();
  const reader = createReader({ engine, sentences: buildSentences(BLOCKS) });

  reader.play();
  await settle();
  reader.skip(2);
  await settle();

  assert.equal(reader.getIndex(), 2);
  assert.equal(engine.spoken.at(-1).text, 'Nobody complained.');
});

/**
 * Paragraph skipping.
 *
 * Three paragraphs, deliberately with more than one sentence each, because every
 * interesting case here is about landing on a paragraph *boundary* rather than a
 * sentence one — and a one-sentence paragraph cannot tell the two apart.
 */
const PARAGRAPHS = [
  { text: 'One begins. One middles. One ends.' },
  { text: 'Two begins. Two ends.' },
  { text: 'Three begins. Three ends.' },
];

/** A reader parked on a given sentence, already playing. */
async function playingAt(index, blocks = PARAGRAPHS) {
  const engine = createFakeEngine();
  const reader = createReader({ engine, sentences: buildSentences(blocks) });
  reader.play();
  await settle();
  if (index !== 0) {
    reader.seek(index);
    await settle();
  }
  return { engine, reader };
}

test('skipping a paragraph forward lands on the first sentence of the next one', async () => {
  const { engine, reader } = await playingAt(1);

  reader.skipParagraph(1);
  await settle();

  assert.equal(reader.getIndex(), 3);
  assert.equal(engine.spoken.at(-1).text, 'Two begins.');
});

test('skipping back mid-paragraph returns to the start of that paragraph', async () => {
  const { engine, reader } = await playingAt(4); // 'Two ends.'

  reader.skipParagraph(-1);
  await settle();

  assert.equal(reader.getIndex(), 3);
  assert.equal(engine.spoken.at(-1).text, 'Two begins.');
});

test('skipping back at the start of a paragraph goes to the previous paragraph', async () => {
  const { engine, reader } = await playingAt(3); // already at 'Two begins.'

  reader.skipParagraph(-1);
  await settle();

  assert.equal(reader.getIndex(), 0);
  assert.equal(engine.spoken.at(-1).text, 'One begins.');
});

test('skipping back reaches the start of the previous paragraph, not its last sentence', async () => {
  // The bug this guards: landing on the *end* of the previous paragraph, which is what
  // "the sentence before this paragraph" would give and is never what anyone wants.
  const { reader } = await playingAt(5); // 'Three begins.'

  reader.skipParagraph(-1);
  await settle();
  assert.equal(reader.getIndex(), 3, 'start of paragraph two');

  reader.skipParagraph(-1);
  await settle();
  assert.equal(reader.getIndex(), 0, 'start of paragraph one');
});

test('skipping a paragraph forward from the last paragraph goes to its end', async () => {
  const { reader } = await playingAt(5); // 'Three begins.', last paragraph

  reader.skipParagraph(1);
  await settle();

  assert.equal(reader.getIndex(), 6, 'the final sentence, not a dead button');
});

test('skipping back from the very first sentence stays put', async () => {
  const { reader } = await playingAt(0);

  reader.skipParagraph(-1);
  await settle();

  assert.equal(reader.getIndex(), 0);
});

test('paragraph skipping keeps playing, and keeps a pause paused', async () => {
  const { reader } = await playingAt(1);

  reader.skipParagraph(1);
  await settle();
  assert.equal(reader.getState(), 'playing');

  reader.pause();
  reader.skipParagraph(1);
  await settle();
  assert.equal(reader.getIndex(), 5, 'moved while paused');
});

test('paragraph skipping announces the new sentence even when not playing', async () => {
  const engine = createFakeEngine();
  const reader = createReader({ engine, sentences: buildSentences(PARAGRAPHS) });
  const announced = [];
  reader.on('sentence', ({ index }) => announced.push(index));

  reader.skipParagraph(1);
  await settle();

  // Nothing was spoken, but the highlight still has to move: an idle reader being driven
  // by the on-page bar is exactly how someone finds their place before pressing play.
  assert.equal(engine.spoken.length, 0);
  assert.deepEqual(announced, [3]);
});

test('paragraph skipping on an empty article does nothing rather than throwing', () => {
  const reader = createReader({ engine: createFakeEngine(), sentences: [] });
  reader.skipParagraph(1);
  reader.skipParagraph(-1);
  assert.equal(reader.getIndex(), 0);
});

test('one-sentence paragraphs behave like plain sentence skipping', async () => {
  const { reader } = await playingAt(0, [{ text: 'First.' }, { text: 'Second.' }]);

  reader.skipParagraph(1);
  await settle();
  assert.equal(reader.getIndex(), 1);

  reader.skipParagraph(-1);
  await settle();
  assert.equal(reader.getIndex(), 0);
});

test('announces each sentence as it starts, for the highlighter to use', async () => {
  const engine = createFakeEngine();
  const reader = createReader({ engine, sentences: buildSentences(BLOCKS) });
  const announced = [];
  reader.on('sentence', ({ index, sentence }) => announced.push([index, sentence.text]));

  reader.play();
  await settle();
  await engine.finish();
  await settle();

  assert.deepEqual(announced, [
    [0, 'The bridge opened.'],
    [1, 'It cost a lot.'],
  ]);
});

test('passes the configured speed and voice through to the engine', async () => {
  const engine = createFakeEngine();
  const config = { rate: 1.5, pitch: 0.9, volume: 0.8, voiceName: 'Zira', lang: 'en-GB' };
  const reader = createReader({ engine, sentences: buildSentences(BLOCKS), config });

  reader.play();
  await settle();

  assert.deepEqual(engine.spoken[0].options, config);
});

test('one failed sentence does not end the article', async () => {
  const engine = createFakeEngine();
  const reader = createReader({ engine, sentences: buildSentences(BLOCKS) });

  reader.play();
  await settle();
  await engine.finish('error');
  await settle();

  assert.equal(engine.spoken.length, 2, 'reading must continue past a sentence the voice refused');
});

test('a page with no article finishes instead of hanging', () => {
  const engine = createFakeEngine();
  const reader = createReader({ engine, sentences: [] });
  let finished = false;
  reader.on('finished', () => {
    finished = true;
  });

  reader.play();

  assert.ok(finished);
  assert.equal(engine.spoken.length, 0);
});

test('playing again after finishing starts from the top', async () => {
  const engine = createFakeEngine();
  const reader = createReader({ engine, sentences: buildSentences(BLOCKS) });

  reader.play();
  await settle();
  for (let i = 0; i < 3; i++) {
    await engine.finish();
    await settle();
  }
  assert.equal(reader.getState(), 'finished');

  reader.play();
  await settle();

  assert.equal(reader.getIndex(), 0);
  assert.equal(engine.spoken.at(-1).text, 'The bridge opened.');
});

test('refuses to be built without a voice engine', () => {
  assert.throws(() => createReader({ sentences: [] }), /voice engine/);
});

/**
 * The engine interface grew one optional method, `prime`, so a voice that has to build
 * its audio can start on the next sentence while the current one plays. These two tests
 * pin down both halves of the promise: the reader offers the hint, and an engine that
 * has never heard of it is entirely unaffected.
 */

test('the reader tells the engine which sentences are coming next', async () => {
  const engine = createFakeEngine();
  const primed = [];
  engine.prime = (text) => primed.push(text);

  const reader = createReader({ engine, sentences: buildSentences(BLOCKS) });

  // Several are offered, not just the next one: a voice that builds its audio needs more
  // than one sentence of warning to keep a cushion. What it does with them is its own
  // business — the reader only says what is coming.
  reader.play();
  await settle();
  assert.deepEqual(primed, ['It cost a lot.', 'Nobody complained.']);

  await engine.finish();
  await settle();
  assert.deepEqual(primed, ['It cost a lot.', 'Nobody complained.', 'Nobody complained.']);

  // The last sentence has nothing after it, and nothing must be offered for it.
  primed.length = 0;
  await engine.finish();
  await settle();
  assert.deepEqual(primed, [], 'nothing follows the final sentence');
});

test('an engine with no prime() works exactly as before', async () => {
  const engine = createFakeEngine();
  assert.equal(typeof engine.prime, 'undefined', 'the fake engine has no prime()');

  const reader = createReader({ engine, sentences: buildSentences(BLOCKS) });

  reader.play();
  await settle();
  await engine.finish();
  await settle();

  assert.deepEqual(
    engine.spoken.map((s) => s.text),
    ['The bridge opened.', 'It cost a lot.'],
    'the hint is optional: without it the reader behaves identically'
  );
});

test('prime is optional, so an engine without it is still a valid engine', () => {
  const engine = createFakeEngine();
  assert.ok(isEngine(engine));
  assert.ok(!OPTIONAL_ENGINE_METHODS.some((method) => ENGINE_METHODS.includes(method)));
});

// ---------------------------------------------------------------------------
// Pause has to be instant
// ---------------------------------------------------------------------------

/**
 * Pause is not a request, it is a command to stop making a sound, and there is nothing to
 * wait for. Play is different and allowed to take a moment: this voice has to build the
 * audio before there is anything to hear. But pausing existing sound is instant work, and
 * anything that makes it feel otherwise is a bug.
 *
 * "Instant" is testable without a clock, because what made it slow was ordering rather than
 * arithmetic: work was being done, or awaited, before the sound was silenced. So these
 * tests assert on what has happened by the time pause() returns — with nothing awaited in
 * between, and no turn of the event loop given away.
 */

test('pause silences the voice before it returns, with nothing awaited', () => {
  const engine = createFakeEngine();
  const reader = createReader({ engine, sentences: buildSentences(BLOCKS) });

  reader.play();
  // Deliberately no `await settle()` after pause: if silencing the sound needed a turn of
  // the event loop, this test would be the thing that failed.
  reader.pause();

  assert.equal(engine.isPaused(), true, 'the voice must already be silent');
});

test('pause announces itself before asking the engine, so the button can redraw at once', () => {
  // The control bar redraws from this announcement. Announcing after the engine had been
  // asked meant the icon waited on another document — the neural voice runs in a page of
  // its own — and the button changed a moment after the finger that pressed it.
  const engine = createFakeEngine();
  const order = [];

  const watched = {
    ...engine,
    pause() {
      order.push('engine');
      return engine.pause();
    },
  };

  const reader = createReader({ engine: watched, sentences: buildSentences(BLOCKS) });
  reader.on('state', ({ state }) => {
    if (state === 'paused') order.push('announced');
  });

  reader.play();
  reader.pause();

  assert.deepEqual(order, ['announced', 'engine'], 'the announcement must come first');
});

test('the reader reports itself paused the instant pause is called', () => {
  const engine = createFakeEngine();
  const reader = createReader({ engine, sentences: buildSentences(BLOCKS) });

  reader.play();
  reader.pause();

  assert.equal(reader.getState(), 'paused', 'no waiting, no settling');
});

/*
 * A sentence spoken twice after a pause — found in the owner's console log, 2026-09-11.
 *
 * The log showed the reader moving BACKWARDS with nobody asking it to, around each pause:
 *
 *   [3/62] Sign up for the Ideas newsletter…
 *   [4/62] This is the emerging problem…
 *   [3/62] Sign up for the Ideas newsletter…   <- back to 3, unasked
 *   [4/62] This is the emerging problem…
 */

test('pausing stops the loop rather than letting it run on to the next sentence', async () => {
  const engine = createFakeEngine();
  const reader = createReader({
    engine,
    sentences: buildSentences([{ text: 'One. Two. Three.' }]),
  });

  reader.play();
  await settle();
  assert.equal(engine.spoken.length, 1, 'speaking the first sentence');

  // Pause lands while the first sentence is still in the air, which is the ordinary case:
  // a press nearly always arrives mid-sentence.
  reader.pause();
  assert.equal(reader.getState(), 'paused');

  // That sentence now finishes — it was already built and playing, so this happens whether
  // or not anyone is listening. The loop is sitting at `await speaking` and must NOT step
  // on to the next sentence: the listener asked for silence.
  await engine.finish('ended');
  await settle();

  assert.equal(
    engine.spoken.length,
    1,
    'a paused reader must not start the next sentence when the current one ends'
  );
  assert.equal(reader.getState(), 'paused', 'and it must still be paused');
});

test('playing after a sentence finished while paused continues, without repeating', async () => {
  const engine = createFakeEngine();
  const reader = createReader({
    engine,
    sentences: buildSentences([{ text: 'One. Two. Three.' }]),
  });

  reader.play();
  await settle();
  reader.pause();
  await engine.finish('ended'); // The paused sentence finishes anyway.
  await settle();

  assert.equal(engine.spoken.length, 1, 'still only the first sentence has been spoken');

  // Pressing play must now carry on with the SECOND sentence. The first was heard all the
  // way through, so repeating it is exactly the fault being fixed; skipping to the third
  // would be the opposite mistake, losing a sentence nobody heard.
  reader.play();
  await settle();

  assert.equal(engine.spoken.length, 2, 'play continues the article');
  assert.equal(engine.spoken[1].text, 'Two.', 'with the sentence after the one already heard');
});

test('skipping after a sentence finished while paused goes where it is told', async () => {
  // The flag that remembers "there is nothing held to resume" must not outlive the pause
  // it describes. A skip decides its own position and starts the loop fresh, so a stale
  // flag here would be a bug waiting to happen the next time play is pressed.
  const engine = createFakeEngine();
  const reader = createReader({
    engine,
    sentences: buildSentences([{ text: 'One. Two. Three. Four.' }]),
  });

  reader.play();
  await settle();
  reader.pause();
  await engine.finish('ended');
  await settle();

  reader.skip(1); // From sentence two, where the pause left us, to sentence three.
  await settle();

  assert.equal(engine.spoken[engine.spoken.length - 1].text, 'Three.', 'skip lands correctly');

  // And a pause taken now must behave like an ordinary one again.
  reader.pause();
  assert.equal(reader.getState(), 'paused');
});

test('playFrom starts at that sentence from idle, paused, or finished', async () => {
  const engine = createFakeEngine();
  const sentences = buildSentences([{ text: 'One. Two. Three.' }]);
  const reader = createReader({ engine, sentences });

  reader.playFrom(1);
  await settle();
  assert.equal(engine.spoken.at(-1).text, 'Two.');
  assert.equal(reader.getState(), 'playing');

  reader.pause();
  reader.playFrom(2);
  await settle();
  assert.equal(engine.spoken.at(-1).text, 'Three.');

  await engine.finish();
  await settle();
  assert.equal(reader.getState(), 'finished');
  // Where seek() then play() would start a finished article over from the top.
  reader.playFrom(1);
  await settle();
  assert.equal(engine.spoken.at(-1).text, 'Two.');
  assert.equal(reader.getState(), 'playing');
});

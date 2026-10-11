/**
 * Tests for the Piper pipeline — the part that decides what to generate and when.
 *
 * Every test here encodes a requirement that came out of measuring the real thing, so
 * each one is named after the behaviour a listener would notice if it broke.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPipeline } from '../src/piper/pipeline.js';
import { createFakeGenerator, createFakePlayers, settled } from './helpers/fake-piper.js';

/** Short enough never to trip the long-opening-sentence split. */
const A = 'First sentence.';
const B = 'Second sentence.';
const C = 'Third sentence.';

function setup(options = {}) {
  const generator = createFakeGenerator();
  const audio = createFakePlayers();
  const pipeline = createPipeline({
    generate: generator.generate,
    createPlayer: audio.createPlayer,
    ...options,
  });
  return { pipeline, generator, audio };
}

test('the pipeline provides what an engine needs', () => {
  const { pipeline } = setup();
  for (const method of ['speak', 'prime', 'pause', 'resume', 'stop', 'release']) {
    assert.equal(typeof pipeline[method], 'function', `missing ${method}`);
  }
});

test('it speaks one sentence and reports that it ended', async () => {
  const { pipeline, generator, audio } = setup();

  const speaking = pipeline.speak(A);
  await settled();

  assert.deepEqual(generator.requests, [A], 'should generate exactly the sentence asked for');
  await generator.finish(A);
  assert.equal(audio.current.playCount, 1, 'should start playing once generated');

  await audio.end();
  assert.equal(await speaking, 'ended');
});

test(
  'THE POINT OF ALL THIS: a primed sentence is already waiting, so the next one ' +
    'starts without generating anything',
  async () => {
    const { pipeline, generator, audio } = setup();

    // Sentence A is playing…
    const speakingA = pipeline.speak(A);
    await settled();
    await generator.finish(A);

    // …and while it plays, the reader says what is coming next.
    pipeline.prime(B);
    await settled();
    assert.deepEqual(generator.requests, [A, B], 'should start preparing B during A');

    // B finishes generating comfortably before A finishes playing — the whole premise.
    await generator.finish(B);
    await audio.end();
    assert.equal(await speakingA, 'ended');

    // Now B is asked for. Nothing new may be generated: it is already made.
    const speakingB = pipeline.speak(B);
    await settled();

    assert.equal(generator.count, 2, 'B must NOT be generated a second time');
    assert.equal(audio.current.audio.id, B, 'B should start playing immediately');

    await audio.end();
    assert.equal(await speakingB, 'ended');
  }
);

test('a prepared sentence that is no longer wanted is discarded, not played', async () => {
  const { pipeline, generator, audio } = setup();

  const speakingA = pipeline.speak(A);
  await settled();
  await generator.finish(A);

  // The reader expects B next, so B is prepared.
  pipeline.prime(B);
  await settled();
  assert.ok(generator.isPending(B));

  // But the listener skips, and C is asked for instead.
  pipeline.stop();
  assert.equal(await speakingA, 'stopped');

  const speakingC = pipeline.speak(C);
  await settled();
  assert.deepEqual(generator.requests, [A, B, C], 'C must be generated in its own right');

  // B arrives late, as it always will — generation cannot be cancelled mid-flight.
  await generator.finish(B);
  await generator.finish(C);
  await settled();

  assert.ok(!audio.played.includes(B), 'the skipped sentence must never be heard');
  assert.equal(audio.current.audio.id, C);

  await audio.end();
  assert.equal(await speakingC, 'ended');
});

test('two sentences are never generated at the same time', async () => {
  const { pipeline, generator } = setup();

  pipeline.speak(A);
  await settled();
  assert.equal(generator.count, 1);

  // Several hints arrive while A is still being made. Starting them now would steal the
  // single thread from the sentence that is actually needed next.
  pipeline.prime(B);
  pipeline.prime(C);
  await settled();

  assert.equal(generator.count, 1, 'nothing else may start while a generation is running');
});

test('stopping mid-generation stays silent when the audio finally arrives', async () => {
  const { pipeline, generator, audio } = setup();

  const speaking = pipeline.speak(A);
  await settled();

  // The listener stops before the audio is ready.
  pipeline.stop();

  // The WebAssembly call cannot be cancelled, so the audio still turns up.
  await generator.finish(A);
  await settled();

  assert.equal(await speaking, 'stopped');
  assert.equal(audio.played.length, 0, 'audio that arrives after a stop must never play');
});

test('stopping while speaking abandons the audio', async () => {
  const { pipeline, generator, audio } = setup();

  const speaking = pipeline.speak(A);
  await settled();
  await generator.finish(A);
  assert.equal(audio.current.playCount, 1);

  pipeline.stop();
  assert.ok(audio.current.stopped, 'the player should be told to stop');
  await audio.end();
  assert.equal(await speaking, 'stopped');
});

test('a sentence that fails to generate costs one sentence, not the article', async () => {
  const { pipeline, generator } = setup();

  const speaking = pipeline.speak(A);
  await settled();
  await generator.fail(A);

  // Resolves rather than rejecting: the reader drops this sentence and carries on.
  assert.equal(await speaking, 'error');
});

test('audio that fails while playing reports an error rather than throwing', async () => {
  const { pipeline, generator, audio } = setup();

  const speaking = pipeline.speak(A);
  await settled();
  await generator.finish(A);
  await audio.error();

  assert.equal(await speaking, 'error');
});

test('pause and resume drive the player, and do nothing when idle', async () => {
  const { pipeline, generator, audio } = setup();

  // Nothing is playing yet, so these must be harmless no-ops.
  pipeline.pause();
  pipeline.resume();
  assert.equal(audio.players.length, 0);

  const speaking = pipeline.speak(A);
  await settled();
  await generator.finish(A);

  pipeline.pause();
  assert.equal(audio.current.pauseCount, 1);
  assert.ok(pipeline.isPaused());
  assert.ok(!pipeline.isSpeaking());

  pipeline.resume();
  assert.equal(audio.current.playCount, 2, 'resuming plays the same audio again');
  assert.ok(pipeline.isSpeaking());

  await audio.end();
  assert.equal(await speaking, 'ended');
});

test('releasing reports whether anything was actually being held', async () => {
  const { pipeline, generator } = setup();

  assert.equal(pipeline.release(), false, 'nothing held when idle');

  const speaking = pipeline.speak(A);
  await settled();
  await generator.finish(A);

  assert.equal(pipeline.release(), true, 'held while speaking');
  assert.equal(await speaking, 'stopped');
});

test('empty text is treated as spoken rather than generated', async () => {
  const { pipeline, generator } = setup();

  assert.equal(await pipeline.speak('   '), 'ended');
  assert.equal(generator.count, 0, 'nothing to say means nothing to generate');

  pipeline.prime('');
  assert.equal(generator.count, 0);
});

test('a long opening sentence can be split so speech starts sooner', async () => {
  const { pipeline, generator, audio } = setup({ splitFirstSentence: true });

  const opener =
    'The board voted on Tuesday to extend the program through 2027, a decision that ' +
    'arrived after months of hearings and three revised budgets.';

  const speaking = pipeline.speak(opener);
  await settled();

  assert.equal(generator.count, 1, 'only the first chunk is generated up front');
  const first = generator.requests[0];
  assert.ok(first.length < opener.length, 'the first chunk must be shorter than the whole');
  assert.ok(first.endsWith(','), `expected a split at the comma, got "${first}"`);

  // Speech starts on the short chunk while the rest is prepared behind it.
  await generator.finish(first);
  assert.equal(audio.current.playCount, 1, 'sound starts on the short opening chunk');
  await settled();
  assert.equal(generator.count, 2, 'the remainder is prepared while the opening plays');

  await generator.finish(generator.requests[1]);
  await audio.end();
  await settled();

  // The caller asked for one sentence, so it gets one result — the split is invisible.
  await audio.end();
  assert.equal(await speaking, 'ended');
});

test('a short opening sentence is left alone', async () => {
  const { pipeline, generator } = setup({ splitFirstSentence: true });

  pipeline.speak(A);
  await settled();

  assert.deepEqual(generator.requests, [A], 'a short sentence must not be split');
});

test('only the opening sentence is split, not every later one', async () => {
  const { pipeline, generator, audio } = setup({ splitFirstSentence: true });

  // Get the first sentence out of the way.
  const speakingA = pipeline.speak(A);
  await settled();
  await generator.finish(A);
  await audio.end();
  await speakingA;

  const longLater =
    'Funding will rise by four and a half percent, though officials cautioned that the ' +
    'figure depends on state allocations that are not yet final.';

  pipeline.speak(longLater);
  await settled();

  assert.deepEqual(
    generator.requests.slice(1),
    [longLater],
    'once speech is under way the pipeline is ahead, so splitting would only add joins'
  );
});

/**
 * Regression tests for the pauses heard on 2026-09-10.
 *
 * Piper worked, but there was a pause before every sentence — the pipeline was not
 * pipelining at all. The cause: the reader announces the next sentence the instant the
 * current one *starts*, which is while that current one is still being built. The hint
 * arrived, found the generator busy, and was silently thrown away. So nothing was ever
 * prepared in advance and every sentence waited for its own audio.
 *
 * The tests below are written against the reader's real timing — speak() and prime()
 * back to back — because the original tests primed only after generation had finished,
 * which is the one moment the bug did not happen.
 */

test('a hint that arrives while busy is remembered, not thrown away', async () => {
  const { pipeline, generator, audio } = setup();

  // Exactly what the reader does: ask for A, then immediately say B is next. At this
  // moment A is still being generated, so the generator is busy.
  const speakingA = pipeline.speak(A);
  pipeline.prime(B);
  await settled();

  assert.deepEqual(generator.requests, [A], 'B must wait rather than compete with A');

  // The moment A is ready, B must start being built — while A is playing.
  await generator.finish(A);
  await settled();

  assert.deepEqual(
    generator.requests,
    [A, B],
    'the remembered hint must start as soon as the generator is free'
  );

  // So when A ends, B is already waiting and there is no pause.
  await generator.finish(B);
  await audio.end();
  assert.equal(await speakingA, 'ended');

  const speakingB = pipeline.speak(B);
  await settled();
  assert.equal(generator.count, 2, 'B was ready: no gap, and no second generation');
  assert.equal(audio.current.audio.id, B);

  await audio.end();
  assert.equal(await speakingB, 'ended');
});

test('a whole article runs without ever waiting for a sentence', async () => {
  const { pipeline, generator, audio } = setup();
  const sentences = [A, B, C];

  // Drive it the way the reader does, and assert that after the first sentence nothing
  // is ever generated at the moment it is needed.
  for (let i = 0; i < sentences.length; i += 1) {
    const speaking = pipeline.speak(sentences[i]);
    pipeline.prime(sentences[i + 1]);
    await settled();

    if (i === 0) {
      // Only the very first sentence is allowed to be built on demand.
      await generator.finish(sentences[i]);
      await settled();
    } else {
      assert.ok(
        !generator.isPending(sentences[i]),
        `sentence ${i + 1} should have been ready before it was asked for`
      );
    }

    // Whatever is being prepared now is the NEXT sentence, so let it finish while this
    // one plays — the pipeline working exactly as intended.
    const next = sentences[i + 1];
    if (next && generator.isPending(next)) await generator.finish(next);

    await audio.end();
    assert.equal(await speaking, 'ended');
  }

  assert.equal(generator.count, 3, 'each sentence generated exactly once');
});

test('a remembered hint is forgotten when the listener skips away', async () => {
  const { pipeline, generator } = setup();

  const speakingA = pipeline.speak(A);
  pipeline.prime(B);
  await settled();

  // Skip before B ever starts being built.
  pipeline.stop();

  // A's generation cannot be cancelled, so it still arrives — and only then can the
  // abandoned sentence report back. It must not drag the remembered hint along with it.
  await generator.finish(A);
  assert.equal(await speakingA, 'stopped');
  await settled();

  assert.deepEqual(generator.requests, [A], 'a hint about an abandoned article is dropped');
});

/**
 * Building does not stop and wait for the sentence to change.
 *
 * One sentence of lookahead leaves the generator idle through the spare time in every
 * sentence, and that spare time is exactly what pays for a sentence that turns out to be
 * slow to build. Keeping it working banks a cushion instead.
 */

test('it keeps building ahead while a sentence plays, not just the next one', async () => {
  const { pipeline, generator, audio } = setup();
  const S = ['One.', 'Two.', 'Three.', 'Four.'];

  // The reader offers several upcoming sentences, not just the next.
  const speaking = pipeline.speak(S[0]);
  for (const text of S.slice(1)) pipeline.prime(text);
  await settled();

  assert.deepEqual(generator.requests, [S[0]], 'only one sentence is ever built at a time');

  // The first sentence is ready and starts playing.
  await generator.finish(S[0]);
  await settled();
  assert.deepEqual(generator.requests, [S[0], S[1]], 'the next one starts immediately');

  // Crucially, it does not now stop and wait: as each finishes, the next begins, all
  // while the FIRST sentence is still being heard.
  await generator.finish(S[1]);
  await settled();
  assert.deepEqual(
    generator.requests,
    [S[0], S[1], S[2]],
    'building continues without waiting for the spoken sentence to change'
  );

  // Everything banked is used without generating again.
  await generator.finish(S[2]);
  await audio.end();
  assert.equal(await speaking, 'ended');

  const second = pipeline.speak(S[1]);
  await settled();
  assert.ok(
    !generator.requests.slice(3).includes(S[1]),
    'the banked sentence is reused, not rebuilt'
  );
  await audio.end();
  assert.equal(await second, 'ended');
});

test('it does not run away and build the whole article', async () => {
  const { pipeline, generator } = setup();

  pipeline.speak('Start.');
  await settled();
  await generator.finish('Start.');

  // Offer far more than it should take on.
  for (let i = 0; i < 60; i += 1) pipeline.prime(`Sentence ${i}.`);
  await settled();

  // Let everything it accepted finish building.
  for (let i = 0; i < 40; i += 1) {
    const pending = generator.requests.find((text) => generator.isPending(text));
    if (!pending) break;
    await generator.finish(pending);
    await settled();
  }

  // The point is the cap, not its exact value: offered sixty sentences it must take a
  // bounded cushion and stop. The bound is the pipeline's lookahead plus the sentence
  // being spoken, with a little room so that tuning the depth does not fail this test —
  // only removing the limit entirely should.
  assert.ok(
    generator.count <= 12,
    `should build a bounded cushion, not the whole article; built ${generator.count}`
  );
  assert.ok(generator.count < 60, 'and must not simply build everything it was offered');
});

// Note what this does and does not say. Stopping ends the *queue* — nothing carries on
// being built for an article nobody is listening to. It does not throw away audio already
// made: that is kept deliberately, so returning to a sentence is instant. See the cache
// tests below.
test('stopping ends the queue as well as the sentence being spoken', async () => {
  const { pipeline, generator, audio } = setup();

  const speaking = pipeline.speak('Start.');
  pipeline.prime('Next.');
  pipeline.prime('After.');
  await settled();
  await generator.finish('Start.');
  await settled();

  pipeline.stop();
  assert.equal(await speaking, 'stopped');

  const built = generator.count;
  await settled();

  // Nothing queued may quietly carry on into the abandoned article.
  assert.equal(generator.count, built, 'a stop ends the queue as well as the sentence');
  assert.ok(!audio.played.includes('Next.'));
});

/**
 * Pausing and changing speed while a sentence is still being built.
 *
 * This voice manufactures audio before it can play it, which takes a second or two, and
 * that gap is a real part of using the add-on rather than an edge case — it happens before
 * every single sentence. Pressing a button during it is normal.
 *
 * Every test below failed when they were written. The pipeline only ever looked at the
 * audio player, which does not exist yet during generation, so a press in that window was
 * dropped on the floor: the voice carried on regardless and the button looked broken.
 */

test('pausing while a sentence is generating does not let it start speaking', async () => {
  const { pipeline, generator, audio } = setup();

  const speaking = pipeline.speak(A);
  await settled();
  assert.ok(generator.isPending(A), 'the sentence should still be building');

  pipeline.pause();
  await generator.finish(A);

  assert.equal(audio.current.playCount, 0, 'a paused sentence must not start speaking');
  assert.equal(pipeline.isPaused(), true);

  // And it is genuinely held rather than lost: resuming still speaks it.
  pipeline.resume();
  await settled();
  assert.equal(audio.current.playCount, 1);

  await audio.end();
  assert.equal(await speaking, 'ended');
});

test('resuming during generation leaves the sentence to start on its own', async () => {
  // Pause then resume before the audio exists must come out exactly where it started,
  // rather than holding the sentence forever waiting for a play that already happened.
  const { pipeline, generator, audio } = setup();

  const speaking = pipeline.speak(A);
  await settled();

  pipeline.pause();
  pipeline.resume();
  await generator.finish(A);

  assert.equal(audio.current.playCount, 1, 'it should speak as if nothing had happened');
  assert.equal(pipeline.isSpeaking(), true);

  await audio.end();
  assert.equal(await speaking, 'ended');
});

test('a pause taken during generation does not hold the next article', async () => {
  // The nastiest version of this bug: a remembered pause outliving what it applied to
  // would leave the *next* press of play silently mute, with nothing on screen to explain
  // it — and it would look like a broken voice rather than a stuck pause.
  const { pipeline, generator, audio } = setup();

  pipeline.speak(A);
  await settled();
  pipeline.pause();
  pipeline.stop();
  await settled();

  const speaking = pipeline.speak(B);
  await settled();
  await generator.finish(B);

  assert.equal(audio.current.playCount, 1, 'the new sentence must speak');
  await audio.end();
  assert.equal(await speaking, 'ended');
});

test('changing speed rebuilds what was banked at the old one', async () => {
  /*
   * MOVED, NOT DROPPED. This used to assert that a speed change reached the player, which
   * is no longer where speed lives: the voice bakes it into the samples as it builds
   * them, so that a faster voice keeps its own pitch instead of squeaking.
   *
   * What the pipeline owes the listener now is the other half of that bargain — audio
   * built at the old speed must be thrown away and made again, or the bank of eight
   * sentences would go on playing at a speed nobody asked for. The speed that reaches the
   * voice is asserted in tests/piper-speed-end-to-end.test.js, where the real generate
   * call can be watched.
   */
  const { pipeline, generator, audio } = setup();

  const speaking = pipeline.speak(A);
  await settled();
  await generator.finish(A);
  pipeline.prime(B);
  await settled();
  await generator.finish(B);

  const builtBefore = generator.count;
  pipeline.setRate(1.5);
  await settled();

  assert.ok(generator.count > builtBefore, 'the bank must be rebuilt, not reused');
  assert.ok(generator.requests.includes(B), 'and the sentence ahead is what gets rebuilt');

  await audio.end();
  assert.equal(await speaking, 'ended');
});

test('changing speed leaves the sentence in the air alone, and bins the bank', async () => {
  /*
   * REVERSED DELIBERATELY, and the reason is audible. Speed used to be applied to the
   * finished sound by replaying it faster, so it could be changed mid-sentence for free.
   * But replaying samples faster raises their pitch — the owner heard it as a squeak at
   * the higher settings — so speed is now asked of the voice itself and baked in as each
   * sentence is built.
   *
   * Two consequences, both asserted here. The sentence already being heard cannot change
   * speed without being cut off and rebuilt, so it is left to finish. And everything
   * banked behind it was built at the old speed, so it must be discarded rather than
   * played at a speed it was not made for.
   */
  const { pipeline, generator, audio } = setup();

  const speaking = pipeline.speak(A);
  await settled();
  await generator.finish(A);

  const before = audio.current.rates.length;
  pipeline.setRate(0.75);

  assert.equal(
    audio.current.rates.length,
    before,
    'the sound already playing must not be re-rated: it is played exactly as built'
  );

  await audio.end();
  assert.equal(await speaking, 'ended');
});

test('a no-op speed change keeps the bank it has', async () => {
  // Rebuilding is the price of a voice that keeps its pitch, so it must be paid only on a
  // real change. The same rate arrives more than once in normal use — every speak carries
  // one — and re-stating it must not bin eight good sentences.
  const { pipeline, generator, audio } = setup();

  const first = pipeline.speak(A);
  await settled();
  await generator.finish(A);
  pipeline.prime(B);
  await settled();
  await generator.finish(B);

  pipeline.setRate(1.25);
  await settled();
  const afterRealChange = generator.count;

  pipeline.setRate(1.25); // the speed it is already at
  await settled();

  assert.equal(generator.count, afterRealChange, 'nothing is rebuilt when nothing changed');

  await audio.end();
  await first;
});

test('a nonsense speed is ignored rather than passed to the audio', async () => {
  const { pipeline, generator, audio } = setup();

  const speaking = pipeline.speak(A);
  await settled();
  pipeline.setRate('fast');
  pipeline.setRate(Number.NaN);
  await generator.finish(A);

  assert.deepEqual(audio.current.rates, [], 'nothing invalid should reach the audio');

  await audio.end();
  await speaking;
});

/*
 * The cache: audio built for an article is kept, not thrown away when it finishes playing.
 *
 * WHY THIS EXISTS. Skipping back used to mean waiting for a sentence to be built a second
 * time, and skipping forward binned everything prepared ahead. Keeping what has been built
 * makes both free, and is what allows the lookahead to be deep enough to keep the voice
 * busy — a deep queue was only ever wasteful because its work was discarded.
 *
 * The lifetime tests are the ones that matter most. A cache cleared too eagerly silently
 * reintroduces the bug it was written to fix, and a cache never cleared is a leak that
 * shows up as Firefox getting slow an hour later. Neither announces itself.
 */

/** Speak `text` through to its end, so it is finished and banked. */
async function speakFully(pipeline, generator, audio, text) {
  const speaking = pipeline.speak(text);
  await settled();
  if (generator.isPending(text)) await generator.finish(text);
  await audio.end();
  return speaking;
}

test('a sentence already heard is replayed without being built again', async () => {
  const { pipeline, generator, audio } = setup();

  await speakFully(pipeline, generator, audio, A);
  const builtOnce = generator.count;

  // Going back to it — the skip-back button.
  await speakFully(pipeline, generator, audio, A);

  assert.equal(generator.count, builtOnce, 'skipping back must not rebuild what was heard');
  assert.equal(audio.played.filter((id) => id === A).length, 2, 'and it must actually play');
});

test('sentences skipped past are kept, not binned', async () => {
  const { pipeline, generator, audio } = setup();

  // Build a cushion: B and C are prepared while A is being spoken.
  const speaking = pipeline.speak(A);
  pipeline.prime(B);
  pipeline.prime(C);
  await settled();
  await generator.finish(A);
  await settled();
  await generator.finish(B);
  await settled();
  await generator.finish(C);
  await settled();
  await audio.end();
  await speaking;

  const builtSoFar = generator.count;

  // Jump straight to C, skipping past B. B was built and must survive being stepped over.
  await speakFully(pipeline, generator, audio, C);
  await speakFully(pipeline, generator, audio, B);

  assert.equal(generator.count, builtSoFar, 'neither the target nor the skipped sentence rebuilds');
});

test('a sentence that failed is tried again rather than remembered as broken', async () => {
  const { pipeline, generator, audio } = setup();

  const failing = pipeline.speak(A);
  await settled();
  await generator.fail(A, 'model fell over');
  assert.equal(await failing, 'error');

  const retry = pipeline.speak(A);
  await settled();
  assert.ok(generator.isPending(A), 'a failure must not be cached — one bad moment is not forever');
  await generator.finish(A);
  await audio.end();
  assert.equal(await retry, 'ended');
});

test('the same sentence twice in an article is built once', async () => {
  const { pipeline, generator, audio } = setup();
  const repeated = 'The bell rang.';

  await speakFully(pipeline, generator, audio, repeated);
  await speakFully(pipeline, generator, audio, repeated);

  assert.equal(generator.count, 1, 'identical text sounds identical, so build it once');
});

test('stopping keeps the audio, so playing the same article again is instant', async () => {
  const { pipeline, generator, audio } = setup();

  await speakFully(pipeline, generator, audio, A);
  const builtOnce = generator.count;

  pipeline.stop();

  await speakFully(pipeline, generator, audio, A);
  assert.equal(
    generator.count,
    builtOnce,
    'stop ends playback, it does not discard an article the listener may resume'
  );
});

test('releasing the voice for another tab keeps the audio too', async () => {
  const { pipeline, generator, audio } = setup();

  await speakFully(pipeline, generator, audio, A);
  const builtOnce = generator.count;

  // This is what happens when the tab is merely hidden. Clearing here would empty the
  // cache every time the listener switched tab and came back.
  pipeline.release();

  await speakFully(pipeline, generator, audio, A);
  assert.equal(generator.count, builtOnce, 'hiding a tab must not cost the article its audio');
});

test('moving to a different article lets the old audio go', async () => {
  const { pipeline, generator, audio } = setup();

  pipeline.setArticle('https://example.com/first');
  await speakFully(pipeline, generator, audio, A);
  const builtOnce = generator.count;

  pipeline.setArticle('https://example.com/second');

  const speaking = pipeline.speak(A);
  await settled();
  assert.ok(
    generator.isPending(A),
    'audio for a page the listener has left must not be held forever'
  );
  assert.ok(generator.count > builtOnce);
  await generator.finish(A);
  await audio.end();
  await speaking;
});

test('preparing the same article again keeps what it has', async () => {
  const { pipeline, generator, audio } = setup();

  pipeline.setArticle('https://example.com/same');
  await speakFully(pipeline, generator, audio, A);
  const builtOnce = generator.count;

  // A second prepare for the same page — a reload of the add-on, or a second play.
  pipeline.setArticle('https://example.com/same');

  await speakFully(pipeline, generator, audio, A);
  assert.equal(generator.count, builtOnce, 'the same article is not a different article');
});

test('every player created is finished, so nothing holds audio open', async () => {
  const { pipeline, generator, audio } = setup();

  await speakFully(pipeline, generator, audio, A);
  await speakFully(pipeline, generator, audio, B);
  await speakFully(pipeline, generator, audio, A);
  pipeline.stop();

  // Each player owns an object URL in the real add-on, released on ended, error or stop.
  // A player that is neither played to the end nor stopped would leak one silently.
  const dangling = audio.players.filter((player) => !player.stopped && player.playCount === 0);
  assert.deepEqual(dangling, [], 'a player that is never finished leaks the audio behind it');
});

test('moving to the next sentence does not abandon the sentences being built ahead', async () => {
  const { pipeline, generator, audio } = setup();
  const S = ['One.', 'Two.', 'Three.', 'Four.', 'Five.'];

  // Speak the first and offer the rest, the way the reader does.
  const first = pipeline.speak(S[0]);
  for (const text of S.slice(1)) pipeline.prime(text);
  await settled();
  await generator.finish(S[0]);
  await settled();
  await generator.finish(S[1]);
  await settled();
  await audio.end();
  await first;

  // Now speak the second — the single most ordinary thing that happens. Building must
  // CARRY ON from here. It used to stop dead: speaking bumped the same counter that
  // marked queued work as abandoned, so the bookkeeping which starts the next build was
  // skipped and the queue never moved again. The cushion drained to nothing and the voice
  // idled until it was asked for something, one sentence at a time, for the rest of the
  // article.
  const second = pipeline.speak(S[1]);
  await settled();

  assert.ok(
    generator.requests.includes(S[2]),
    'the queue must keep building through an ordinary sentence change'
  );

  await generator.finish(S[2]);
  await settled();
  assert.ok(generator.requests.includes(S[3]), 'and keep going, rather than stopping after one');

  await audio.end();
  assert.equal(await second, 'ended');
});

test('a stop does still abandon the queue, including work already in flight', async () => {
  const { pipeline, generator, audio } = setup();

  const speaking = pipeline.speak(A);
  pipeline.prime(B);
  pipeline.prime(C);
  await settled();
  await generator.finish(A);
  await settled();

  // B is now being built, and C is waiting behind it.
  assert.ok(generator.isPending(B), 'B should be in flight when the stop arrives');

  pipeline.stop();
  assert.equal(await speaking, 'stopped');

  const built = generator.count;

  // B lands after the stop — generation cannot be called back, so this always happens. It
  // must not restart the queue for an article nobody is listening to, and it must not be
  // heard. Two separate guards make that true and both are wanted: the queue was emptied,
  // so there is nothing left to start, and the work carries a generation stamp that is no
  // longer current, so it is ignored rather than acted on.
  await generator.finish(B);
  await settled();

  assert.equal(generator.count, built, 'a sentence landing after a stop must not start another');
  assert.ok(!audio.played.includes(B), 'nor may it be heard');
});

/*
 * Warming the player — the fix for the gap heard before every sentence on a first pass.
 *
 * The gap was never the buffer. Audio was banked and waiting; what was not ready was the
 * thing that plays it, because the player was built at the moment sound was wanted and
 * only then began fetching and decoding the audio. That happened inside the silence
 * between two sentences, every time, on every sentence the listener had not heard before.
 *
 * It is also exactly why skipping BACK sounded instant: the browser already held the
 * decoded audio, so the same work cost nothing the second time. The asymmetry between
 * forwards and backwards is the evidence that pointed here.
 */

/** A pipeline whose players can be warmed, as the real add-on's can. */
function setupWarming(options = {}) {
  const generator = createFakeGenerator();
  const audio = createFakePlayers({ warms: true });
  const pipeline = createPipeline({
    generate: generator.generate,
    createPlayer: audio.createPlayer,
    ...options,
  });
  return { pipeline, generator, audio };
}

test('a sentence built ahead has its player ready before it is asked for', async () => {
  const { pipeline, generator, audio } = setupWarming();

  const speakingA = pipeline.speak(A);
  await settled();
  await generator.finish(A);

  pipeline.prime(B);
  await settled();
  await generator.finish(B);
  await settled();

  // B is banked. The whole point is that its player is ready NOW, while A is still being
  // heard — not in the silence after A ends.
  assert.ok(audio.warmed.includes(B), 'B should be warmed as soon as it is built');

  await audio.end();
  assert.equal(await speakingA, 'ended');

  // And when B is finally asked for, no new player is built: the warm one is used.
  const built = audio.players.length;
  const speakingB = pipeline.speak(B);
  await settled();

  assert.equal(audio.players.length, built, 'B must reuse the player warmed for it');
  assert.equal(audio.current.audio.id, B, 'and that player is the one now playing');
  assert.equal(audio.current.playCount, 1, 'played exactly once');

  await audio.end();
  assert.equal(await speakingB, 'ended');
});

test('a player is only ever warmed for a factory that says it wants it', async () => {
  // The default fake has no `warm` and its factory does not claim to want one. Nothing
  // may be built early for it: a player built speculatively and never used costs a real
  // audio element and a real object URL in the add-on, and it would also make "the player
  // that is playing" ambiguous for every other test here.
  const { pipeline, generator, audio } = setup();

  const speaking = pipeline.speak(A);
  await settled();
  await generator.finish(A);

  pipeline.prime(B);
  await settled();
  await generator.finish(B);
  await settled();

  assert.deepEqual(
    audio.players.map((player) => player.audio.id),
    [A],
    'only the sentence being played may have a player built'
  );

  await audio.end();
  assert.equal(await speaking, 'ended');
});

test('warming a sentence again after it has been played does not reuse a spent player', async () => {
  const { pipeline, generator, audio } = setupWarming();

  // Play A through to its end, so its warmed player is used up.
  const speaking = pipeline.speak(A);
  await settled();
  await generator.finish(A);
  await audio.end();
  assert.equal(await speaking, 'ended');

  const spent = audio.current;

  // Skipping back to A plays it again. A player is good for one playing, so this must be
  // a fresh one rather than the one already finished — reusing a spent audio element
  // would play nothing at all, which is a silence, not an error.
  const again = pipeline.speak(A);
  await settled();

  assert.notEqual(audio.current, spent, 'a second playing needs its own player');
  assert.equal(audio.current.audio.id, A, 'and it is still A that plays');
  assert.equal(generator.count, 1, 'without building the audio again — that is the cache');

  await audio.end();
  assert.equal(await again, 'ended');
});

test('moving to a different article releases the players warmed for the old one', async () => {
  const { pipeline, generator, audio } = setupWarming();
  pipeline.setArticle('https://example.com/first');

  const speaking = pipeline.speak(A);
  await settled();
  await generator.finish(A);

  pipeline.prime(B);
  await settled();
  await generator.finish(B);
  await settled();

  await audio.end();
  assert.equal(await speaking, 'ended');

  const warmedForB = audio.players.find((player) => player.audio.id === B);
  assert.ok(warmedForB, 'B should have been warmed');
  assert.ok(!warmedForB.stopped, 'and still held while the article is being read');

  // A warmed player owns an audio element and an object URL. Emptying the cache without
  // stopping them would drop the only reference to that memory and never hand it back —
  // a leak that grows with every article read in the same tab, and one that no test
  // watching what is HEARD would ever notice.
  pipeline.setArticle('https://example.com/second');

  assert.ok(warmedForB.stopped, 'a warmed player must be released when its article is let go');
});

test('the cushion count reports what is actually banked, not always zero', async () => {
  // A gauge that always reads zero is worse than no gauge: it was read, reasonably, as
  // proof that nothing was being built ahead. It counted finished entries in the work
  // queue — but a finished sentence is removed from that queue the instant its audio is
  // cached, so there was almost never one to count.
  const reports = [];
  const { pipeline, generator, audio } = setupWarming({
    onActivity: (activity) => reports.push(activity),
  });

  const speakingA = pipeline.speak(A);
  await settled();
  await generator.finish(A);

  pipeline.prime(B);
  pipeline.prime(C);
  await settled();
  await generator.finish(B);
  await settled();
  await generator.finish(C);
  await settled();

  await audio.end();
  assert.equal(await speakingA, 'ended');

  // B and C are both built and both still ahead. That is a cushion of two.
  const speakingB = pipeline.speak(B);
  await settled();

  const spoken = reports.filter((report) => report.phase === 'speaking');
  const latest = spoken[spoken.length - 1];
  assert.equal(latest.text, B, 'the report should be about the sentence now speaking');
  assert.equal(latest.banked, 1, 'with C still banked ahead of it');

  await audio.end();
  assert.equal(await speakingB, 'ended');
});

test('the cushion count stops at the first sentence that is not ready', async () => {
  // A cushion with a hole in it only cushions as far as the hole. Counting everything
  // cached regardless of order would claim depth the listener will not actually get.
  //
  // C is built first here, by being spoken; the listener then goes back to A. So C is in
  // the cache while B, which comes next, is not — the cushion ahead of A is zero, however
  // much audio is held in total.
  const reports = [];
  const { pipeline, generator, audio } = setupWarming({
    onActivity: (activity) => reports.push(activity),
  });

  const speakingC = pipeline.speak(C);
  await settled();
  await generator.finish(C);
  await audio.end();
  assert.equal(await speakingC, 'ended');

  const speakingA = pipeline.speak(A);
  pipeline.prime(B);
  pipeline.prime(C);
  await settled();
  await generator.finish(A);
  await settled();

  const spoken = reports.filter((report) => report.phase === 'speaking');
  assert.equal(
    spoken[spoken.length - 1].banked,
    0,
    'B is not built, so the cushion is zero even though C is cached'
  );

  await audio.end();
  assert.equal(await speakingA, 'ended');
});

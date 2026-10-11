/**
 * The speed button, from the press to the sound — across every seam it crosses.
 *
 * WHY THIS FILE EXISTS. Every layer the speed change passes through was already tested,
 * every layer passed, and the button still did not work. That is the signature of a fault
 * living in a SEAM rather than in a layer, and it is invisible to tests that stub the
 * layer next door.
 *
 * The pipeline's own tests use a fake player that records every setRate it is handed. A
 * fake like that answers "was setRate called", which was never in doubt. It cannot answer
 * the only question the listener cares about: what speed did the sound card actually get.
 * So these tests wire the REAL pipeline to the REAL player and read the answer off a
 * stand-in sound card at the far end.
 *
 * The banked case is the one that matters most. Sentences are built several ahead, so by
 * the time a speed is pressed most of what the listener is about to hear already exists —
 * and a speed that reaches only the sentence in the air is a button that appears to do
 * nothing for the next minute.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPipeline } from '../src/piper/pipeline.js';
import { createPlayer } from '../src/piper/player.js';

const settled = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** A stand-in sound card that remembers the speed of every source it is asked to play. */
function fakeAudio() {
  const ctx = {
    currentTime: 0,
    state: 'running',
    destination: 'speakers',
    sources: [],
    resume: async () => {},
    createBuffer: (channels, length, sampleRate) => ({
      duration: length / sampleRate,
      copyToChannel: () => {},
    }),
    createBufferSource() {
      const source = {
        buffer: null,
        playbackRate: { value: 1 },
        onended: null,
        connect: () => {},
        start: () => ctx.sources.push(source),
        stop: () => {},
      };
      return source;
    },
  };
  /** The speed the most recently started sentence is actually being heard at. */
  ctx.playingRate = () => ctx.sources[ctx.sources.length - 1]?.playbackRate.value;
  return ctx;
}

/**
 * Wire the real pipeline to the real player, exactly as host.js does.
 *
 * `hostRate` stands in for the variable host.js keeps and reads back through a getter —
 * the mechanism by which a sentence built before a speed change still starts at the new
 * speed. Getting that wrong is precisely the fault this file is here to catch.
 */
function setup() {
  const ctx = fakeAudio();
  const pending = new Map();
  let hostRate = 1;

  const factory = (audio) => createPlayer(audio, { context: () => ctx });
  factory.warms = true;

  /** Every sentence the voice was asked to build, and the speed it was asked for. */
  const built = [];

  const pipeline = createPipeline({
    // Stands in for the real voice, which bakes the speed into the samples as it builds.
    // `rate` is read at the moment of the request, exactly as host.js reads it.
    generate: (text) =>
      new Promise((resolve) => {
        built.push({ text, rate: hostRate });
        pending.set(text, resolve);
      }),
    createPlayer: factory,
  });

  return {
    ctx,
    pipeline,
    built,
    /** What speed the most recent build of `text` was made at. */
    builtRate(text) {
      return [...built].reverse().find((entry) => entry.text === text)?.rate;
    },
    /** How many times `text` has been built — a rebuild is the cost of a speed change. */
    buildCount(text) {
      return built.filter((entry) => entry.text === text).length;
    },
    /** Let a sentence finish being built, as the worker eventually does. */
    async finish(text) {
      pending.get(text)?.({ samples: new Float32Array(22050), sampleRate: 22050 });
      pending.delete(text);
      await settled();
    },
    /** A speed press: host.js updates the rate its getter returns AND tells the pipeline. */
    press(rate) {
      hostRate = rate;
      pipeline.setRate(rate);
    },
  };
}

test('the sentence already playing is left to finish at the old speed', async () => {
  // Deliberate, and the one case where the listener does NOT hear the change at once.
  // Speed is baked in as a sentence is built, so honouring a press mid-sentence would
  // mean cutting it off and rebuilding it — far more jarring than letting it finish.
  const { ctx, pipeline, finish, press } = setup();

  const speaking = pipeline.speak('One.');
  await settled();
  await finish('One.');

  assert.equal(ctx.playingRate(), 1, 'the sound is played as built, never replayed faster');

  press(1.5);

  assert.equal(ctx.playingRate(), 1, 'the sentence in the air is not interrupted');

  await pipeline.stop();
  await speaking;
});

test('a sentence built before the press is rebuilt at the new speed', async () => {
  // THE CASE THAT MATTERS. Sentences are banked several ahead, so most of what the
  // listener is about to hear was built before the press. Audio built at 1x IS 1x audio
  // now that the voice bakes speed in, so the only honest way to hear it faster is to
  // build it again — and a bank silently kept at the old speed would be a speed button
  // that appears to work and then does nothing for the next eight sentences.
  const { pipeline, finish, press, builtRate, buildCount } = setup();

  const first = pipeline.speak('One.');
  await settled();
  pipeline.prime('Two.');
  await finish('One.');
  await finish('Two.'); // banked at the OLD speed, before the press

  assert.equal(builtRate('Two.'), 1, 'banked at the speed in force when it was built');

  press(1.5);
  await settled();

  assert.equal(buildCount('Two.'), 2, 'the stale audio must be rebuilt, not reused');
  assert.equal(builtRate('Two.'), 1.5, 'and rebuilt at the new speed');

  await pipeline.stop();
  await first;
});

test('a speed set once carries on to sentences built after it', async () => {
  const { pipeline, finish, press, builtRate } = setup();

  const first = pipeline.speak('One.');
  await settled();
  await finish('One.');
  press(0.75);
  await settled();
  await pipeline.stop();
  await first;

  const second = pipeline.speak('Two.');
  await settled();

  assert.equal(builtRate('Two.'), 0.75, 'the speed must not snap back on the next sentence');

  await finish('Two.');
  await pipeline.stop();
  await second;
});

test('pressing the speed already in force costs nothing', async () => {
  // Rebuilding is expensive, so it must happen only on a real change. The bar can report
  // the same rate more than once — every speak carries one — and re-reading it must not
  // bin a bank that is perfectly good.
  const { pipeline, finish, press, buildCount } = setup();

  const first = pipeline.speak('One.');
  await settled();
  pipeline.prime('Two.');
  await finish('One.');
  await finish('Two.');

  press(1); // the speed it is already at

  assert.equal(buildCount('Two.'), 1, 'the bank must survive a no-op speed change');

  await pipeline.stop();
  await first;
});

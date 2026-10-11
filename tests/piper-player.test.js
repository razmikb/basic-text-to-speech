/**
 * Tests for playing one sentence's sound.
 *
 * WHY THESE EXIST. Almost everything else about this player is the browser's job — it
 * either makes sound or it does not, and only listening can tell. What is genuinely ours,
 * and genuinely easy to get wrong, is the ARITHMETIC: where a paused sentence resumes
 * from, and what changing speed does to that answer.
 *
 * Getting it wrong is not a crash. It is a sentence that resumes half a word early, or a
 * voice that drifts further out of place the faster it is set to speak — faults that are
 * heard, blamed on the voice, and very hard to trace back to a multiplication. Pause was
 * only just fixed after a long hunt, so it is worth pinning properly this time.
 *
 * The clock and the sound card are stand-ins. That is the point: it lets a test say "three
 * seconds passed at 1.5x speed" and check the sum exactly, which no amount of listening can.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPlayer } from '../src/piper/player.js';

const RATE = 22050;

/**
 * A stand-in sound card with a clock a test can wind by hand.
 *
 * Every source it hands out records what it was told to do, so a test can ask the question
 * that matters — "where did this one start from?" — which is the answer the arithmetic is
 * supposed to produce.
 */
function fakeAudio({ duration = 10 } = {}) {
  const ctx = {
    currentTime: 0,
    state: 'running',
    destination: 'speakers',
    resume: async () => {
      ctx.state = 'running';
    },
    createBuffer: (channels, length, sampleRate) => ({
      duration,
      length,
      sampleRate,
      copyToChannel: () => {},
    }),
    createBufferSource: () => {
      const source = {
        buffer: null,
        playbackRate: { value: 1 },
        onended: null,
        startedFrom: null,
        stopped: false,
        connect: () => {},
        start: (when, offset) => {
          source.startedAt = when;
          source.startedFrom = offset;
          ctx.sources.push(source);
        },
        stop: () => {
          source.stopped = true;
        },
      };
      return source;
    },
    sources: [],
  };
  /** Let time pass, as it does while a sentence plays. */
  ctx.tick = (seconds) => {
    ctx.currentTime += seconds;
  };
  ctx.last = () => ctx.sources[ctx.sources.length - 1];
  return ctx;
}

function playerWith({ duration = 10, samples = 4, leadIn } = {}) {
  const ctx = fakeAudio({ duration });
  const player = createPlayer(
    { samples: new Float32Array(samples), sampleRate: RATE },
    { context: () => ctx, leadIn }
  );
  return { ctx, player };
}

test('a sentence starts at its beginning', () => {
  const { ctx, player } = playerWith();
  player.play();
  assert.equal(ctx.last().startedFrom, 0);
});

test('resuming continues from where it was paused, not from the start', () => {
  const { ctx, player } = playerWith();

  player.play();
  ctx.tick(3);
  player.pause();
  player.play();

  // The whole point of the offset bookkeeping. Restarting at 0 here would mean every
  // pause re-read the sentence from its first word.
  assert.equal(ctx.last().startedFrom, 3, 'must resume three seconds in');
  assert.equal(ctx.sources.length, 2, 'a spent source cannot be restarted, so a new one');
});

test('pausing twice does not lose the place', () => {
  const { ctx, player } = playerWith();

  player.play();
  ctx.tick(2);
  player.pause();
  // Time passes while paused; none of it counts, because no sound was made.
  ctx.tick(60);
  player.play();
  ctx.tick(1);
  player.pause();
  player.play();

  assert.equal(ctx.last().startedFrom, 3, 'two seconds then one more, and no wall time');
});

test('a sentence played faster advances through itself faster', () => {
  const { ctx, player } = playerWith();

  player.setRate(2);
  player.play();
  // Two seconds of real time at double speed is four seconds INTO the sentence. Treating
  // the clock as the position is the bug this catches, and it grows with the rate.
  ctx.tick(2);
  player.pause();
  player.play();

  assert.equal(ctx.last().startedFrom, 4, 'position must account for speed');
  assert.equal(ctx.last().playbackRate.value, 2, 'and the new source keeps the speed');
});

test('changing speed mid-sentence does not move the listener', () => {
  const { ctx, player } = playerWith();

  player.play();
  ctx.tick(4); // four seconds heard at normal speed
  player.setRate(2); // faster from here on
  ctx.tick(2); // two more seconds, now covering four
  player.pause();
  player.play();

  // 4 + (2 * 2) = 8. Re-interpreting the earlier four seconds at the NEW rate would give
  // 12 and skip half the sentence; that is the fault this pins.
  assert.equal(ctx.last().startedFrom, 8, 'time already heard keeps the rate it was heard at');
});

test('a speed change while paused is kept for when it resumes', () => {
  const { ctx, player } = playerWith();

  player.play();
  ctx.tick(2);
  player.pause();
  player.setRate(1.5);
  player.play();

  assert.equal(ctx.last().startedFrom, 2, 'the place is unchanged');
  assert.equal(ctx.last().playbackRate.value, 1.5, 'but it resumes at the new speed');
});

test('a nonsense speed is ignored rather than silencing the voice', () => {
  const { ctx, player } = playerWith();

  player.play();
  for (const bad of [0, -1, NaN, Infinity, 'fast', null, undefined]) player.setRate(bad);

  // A rate of zero stops the sound dead and a negative one is meaningless; both would
  // look exactly like a broken voice.
  assert.equal(ctx.last().playbackRate.value, 1);
});

test('the position never runs past the end of the sentence', () => {
  const { ctx, player } = playerWith({ duration: 5 });

  player.play();
  ctx.tick(500); // far longer than the sentence
  player.pause();
  player.play();

  assert.equal(ctx.last().startedFrom, 5, 'clamped to the length of the audio');
});

test('finishing reports the sentence ended, exactly once', () => {
  const { ctx, player } = playerWith();
  let ended = 0;
  player.onEnded(() => (ended += 1));

  player.play();
  ctx.last().onended();
  ctx.last()?.onended?.();

  assert.equal(ended, 1, 'the pipeline waits on this, and a second call would double-advance');
});

test('a sentence stopped by hand does not claim to have ended', () => {
  const { ctx, player } = playerWith();
  let ended = 0;
  player.onEnded(() => (ended += 1));

  player.play();
  const playing = ctx.last();
  player.stop();

  // Stopping fires `ended` on a real source too, so the two must be told apart by who did
  // it. Reporting this as a natural end would advance the reader to the next sentence
  // after the listener pressed stop.
  assert.ok(playing.stopped, 'the sound really stops');
  assert.equal(ended, 0, 'but it is not reported as the sentence finishing');
});

test('a stopped sentence stays stopped', () => {
  const { ctx, player } = playerWith();

  player.play();
  player.stop();
  player.play();

  assert.equal(ctx.sources.length, 1, 'play after stop must not start it again');
});

test('pausing before anything plays does nothing at all', () => {
  const { ctx, player } = playerWith();

  player.pause();

  assert.equal(ctx.sources.length, 0);
});

test('play while already playing does not start a second voice', () => {
  const { ctx, player } = playerWith();

  player.play();
  player.play();

  // Two sources on the same speakers is the same sentence spoken over itself.
  assert.equal(ctx.sources.length, 1);
});

test('a suspended context is resumed when sound is wanted', () => {
  const { ctx, player } = playerWith();
  ctx.state = 'suspended';

  player.play();

  assert.equal(ctx.state, 'running', 'autoplay rules must not leave the voice silent');
});

test('warming is free, because the samples are already in hand', async () => {
  const { player } = playerWith();
  // Kept as a no-op rather than removed: the pipeline warms anything it banks ahead, and
  // "already ready" is the honest answer now that there is nothing to decode.
  await player.warm();
});

test('a sentence asked to wait for the headphones starts late, and from its beginning', () => {
  // The first sentence after play is pressed may have to wait for Bluetooth headphones to
  // wake, or its first words are lost. Waiting is scheduled on the sound card's clock.
  const { ctx, player } = playerWith({ leadIn: () => 0.5 });
  ctx.tick(1);
  player.play();

  assert.equal(ctx.last().startedAt, 1.5);
  assert.equal(ctx.last().startedFrom, 0);
});

test('pausing during that wait loses nothing, because nothing was heard yet', () => {
  let wait = 0.5;
  const { ctx, player } = playerWith({
    leadIn: () => {
      const given = wait;
      wait = 0;
      return given;
    },
  });

  player.play();
  ctx.tick(0.3);
  player.pause();
  player.play();

  assert.equal(ctx.last().startedFrom, 0, 'still at the very first word');
  assert.equal(ctx.last().startedAt, 0.3, 'and only the first start waits');
});

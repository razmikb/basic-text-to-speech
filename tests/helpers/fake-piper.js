/**
 * Stand-ins for the two slow, browser-only parts of the Piper voice: the WebAssembly
 * that manufactures audio, and the audio element that plays it.
 *
 * Both finish only when a test says so. That is what makes the interesting cases
 * testable at all — "the next sentence was ready before the current one ended" is a
 * statement about ordering, and ordering is only observable if the test controls when
 * each step completes.
 */

/**
 * A generator that records every request and hands back control over when it finishes.
 */
export function createFakeGenerator() {
  /** Every text we were asked to generate, in order. Tests assert on this heavily. */
  const requests = [];
  const pending = new Map();

  return {
    requests,

    /** How many generations were asked for — the measure of wasted work. */
    get count() {
      return requests.length;
    },

    /** True while `text` is still being generated. */
    isPending(text) {
      return pending.has(text);
    },

    /** Finish generating `text` successfully. */
    finish(text, audio = { id: text }) {
      const settle = pending.get(text);
      if (!settle) throw new Error(`nothing is generating "${text}"`);
      pending.delete(text);
      settle.resolve(audio);
      return settled();
    },

    /** Make generating `text` fail, the way a missing model or broken input would. */
    fail(text, message = 'generation failed') {
      const settle = pending.get(text);
      if (!settle) throw new Error(`nothing is generating "${text}"`);
      pending.delete(text);
      settle.reject(new Error(message));
      return settled();
    },

    /** The function handed to the pipeline. */
    generate(text) {
      requests.push(text);
      return new Promise((resolve, reject) => {
        pending.set(text, { resolve, reject });
      });
    },
  };
}

/**
 * An audio player that reports what it did instead of making noise.
 *
 * @param {object} [options]
 * @param {boolean} [options.warms] behave like the real add-on's player factory, which is
 *   built early and told to start decoding as soon as a sentence is banked. Off by
 *   default so the many tests about ordering keep seeing one player per sentence played.
 */
export function createFakePlayers(options = {}) {
  /** Every player created, newest last. */
  const players = [];

  return {
    players,

    /** Every player that was warmed ahead of time, in the order they were warmed. */
    get warmed() {
      return players.filter((player) => player.warmCount > 0).map((player) => player.audio.id);
    },

    /** The audio actually played, in order — the honest record of what was heard. */
    get played() {
      return players.filter((player) => player.playCount > 0).map((player) => player.audio.id);
    },

    /**
     * The player that matters right now.
     *
     * The one actually playing when there is one, and otherwise the most recently built.
     * Those were the same thing until players could be warmed ahead of time: a sentence
     * built for later now has a player of its own while an earlier sentence is still
     * being heard, so "the newest" and "the one making sound" came apart. Tests mean the
     * latter, and a test that ended the wrong player simply hung.
     */
    get current() {
      for (let i = players.length - 1; i >= 0; i -= 1) {
        const player = players[i];
        if (player.playCount > 0 && !player.finished) return player;
      }
      return players[players.length - 1];
    },

    /** Finish the currently playing audio. */
    end() {
      const player = this.current;
      if (!player) throw new Error('nothing is playing');
      player.finished = true;
      player.endedListener?.();
      return settled();
    },

    /** Make the current audio fail mid-playback. */
    error() {
      const player = this.current;
      if (!player) throw new Error('nothing is playing');
      player.finished = true;
      player.errorListener?.();
      return settled();
    },

    /**
     * The function handed to the pipeline.
     *
     * A plain property rather than a method, because the pipeline reads a `warms` flag off
     * this function to decide whether players are worth building early — exactly as the
     * real add-on's factory carries it. See makeWarmingFactory in src/piper/host.js.
     */
    createPlayer: Object.assign(
      function createPlayer(audio) {
        const player = {
          audio,
          playCount: 0,
          pauseCount: 0,
          warmCount: 0,
          stopped: false,
          /** Set once this player has ended or errored, so `current` moves past it. */
          finished: false,
          /** Every speed this player was set to, in order — the record of what was heard. */
          rates: [],
          endedListener: null,
          errorListener: null,
          play() {
            this.playCount += 1;
          },
          setRate(rate) {
            this.rates.push(rate);
          },
          pause() {
            this.pauseCount += 1;
          },
          stop() {
            this.stopped = true;
          },
          onEnded(listener) {
            this.endedListener = listener;
          },
          onError(listener) {
            this.errorListener = listener;
          },
        };
        if (options.warms) {
          player.warm = () => {
            player.warmCount += 1;
            return Promise.resolve();
          };
        }
        players.push(player);
        return player;
      },
      { warms: Boolean(options.warms) }
    ),
  };
}

/**
 * Let every already-resolved promise run before the test looks at the result.
 *
 * A single tick is not enough: the pipeline chains several `.then()` steps between being
 * asked for a sentence and actually requesting it, and each link needs its own turn. A
 * handful of turns drains the whole chain, so tests observe the settled state rather than
 * a half-finished one.
 */
export function settled() {
  return new Promise((resolve) => {
    let remaining = 8;
    const drain = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else setImmediate(drain);
    };
    setImmediate(drain);
  });
}

/**
 * Playing one sentence's sound.
 *
 * WHY THIS IS ITS OWN FILE. The arithmetic below — where a paused sentence resumes from,
 * and what a speed change does to that — is the only genuinely tricky thing left on this
 * side of the add-on, and it is heard rather than seen when it goes wrong: a sentence
 * that restarts a word early, or drifts further adrift the faster the voice is set. It
 * lives here so it can be tested without a browser, for the same reason speech.js and
 * pipeline.js were split out before it.
 *
 * Everything a browser supplies arrives as an argument, so a test can hand over a
 * stand-in clock and a stand-in sound card and check the sums directly.
 */

/**
 * Play one sentence's samples.
 *
 * WHAT THIS REPLACED, AND WHY. Until now a sentence went the long way round: the model
 * made samples, which were encoded into a WAV, wrapped in a blob, handed to an <audio>
 * element, and decoded straight back into samples by the browser. That decode ran on this
 * page's thread — the one the voice used to starve — which is what every `readyState=0`
 * in the trace was, and it is why a sentence could be fully built and still sit silent.
 *
 * Samples are what the sound card wants in the first place. Handing them over directly
 * removes the encode, the decode, the blob, the object URL, and the warming that existed
 * only to hide their cost. It is less code doing less work, which is the rare kind of
 * change that is both simpler and faster.
 *
 * WHY PAUSING IS DONE BY HAND. A source node cannot be paused: once stopped it is spent,
 * and resuming means building a new one and telling it where to begin. So this tracks the
 * offset itself. That is the fiddliest thing in this file and the most worth getting
 * right — pause was only just fixed, and resuming a word or two adrift would be heard.
 */
export function createPlayer(
  { samples, sampleRate },
  { context, trace = () => {}, leadIn = () => 0 }
) {
  const ctx = context();

  // Copied into an AudioBuffer once, here, rather than per playing. The samples arrived
  // from the worker as a transferred buffer, so this is the only copy made at all.
  const buffer = ctx.createBuffer(1, samples.length, sampleRate);
  buffer.copyToChannel(samples, 0);

  let source = null;
  let rate = 1;

  /** How far into the sentence we are, in sentence-seconds rather than wall-seconds. */
  let offset = 0;
  /** The context clock when the current source started, so elapsed time can be measured. */
  let startedAt = 0;

  let ended = null;
  let done = false;

  /**
   * Where we have reached, accounting for speed.
   *
   * The context clock runs in real seconds, but a sentence played at 1.3x advances
   * through itself 1.3 seconds per second — so elapsed wall time must be multiplied by
   * the rate to give a position INSIDE the buffer. Getting this wrong would make pause
   * and resume drift further apart the faster the voice was set to speak, which is
   * exactly the sort of fault that looks like a mystery rather than arithmetic.
   */
  function position() {
    if (!source) return offset;
    // Before a delayed start the clock has not reached `startedAt`, and nothing is heard.
    return offset + Math.max(0, ctx.currentTime - startedAt) * rate;
  }

  function startFrom(at) {
    source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    source.connect(ctx.destination);

    // A source stopped by hand fires `ended` just as a finished one does, so the two are
    // told apart by who stopped it: anything deliberate clears `source` first.
    source.onended = () => {
      if (done || !source) return;
      done = true;
      source = null;
      ended?.();
    };

    // `leadIn` is how long the sound output still needs to wake up; see `wakeAudio` in
    // host.js. Zero for every sentence but the first after a wake.
    const delay = Math.max(0, leadIn() || 0);
    offset = at;
    startedAt = ctx.currentTime + delay;
    source.start(startedAt, at);
  }

  /** Stop the current source without letting it report that the sentence ended. */
  function silence() {
    if (!source) return;
    const stopping = source;
    source = null;
    stopping.onended = null;
    try {
      stopping.stop();
    } catch {
      // Never started, or already stopped. Either way there is nothing to silence.
    }
  }

  return {
    /**
     * Nothing to warm.
     *
     * The samples are already in memory and already decoded — that was the whole point of
     * the change. Kept as a no-op rather than removed because the pipeline asks for it on
     * anything it banks ahead, and a player that simply says "ready" is the honest answer.
     */
    warm() {
      return Promise.resolve();
    },

    play() {
      // Autoplay rules can leave the context suspended until something is actually
      // asked for. Harmless when it is already running.
      const stateAtPress = ctx.state;
      if (ctx.state === 'suspended') {
        // DIAGNOSIS. Whether the resume actually worked, rather than whether it was
        // asked for. A context that stays suspended plays silence while every layer
        // above reports success — the failure mode that cost this project two sessions
        // before, and the reason the result is measured here instead of assumed.
        ctx
          .resume()
          .then(() => trace('audio:resumed', { state: ctx.state }))
          .catch((error) => trace('audio:resume-failed', { error: String(error) }));
      }
      // DIAGNOSIS. `rate` here is the speed this sentence will actually be HEARD at —
      // the last link in the chain, and the only one the ear can confirm. A press that
      // shows up in rate:pressed but not here has been lost between the two.
      // `state` is the context at the moment of pressing: `running` means the sound had
      // a working output to go to, anything else means it did not.
      trace('audio:play', {
        seconds: buffer.duration,
        from: offset,
        rate,
        state: stateAtPress,
      });
      if (source || done) return;
      startFrom(offset);
    },

    pause() {
      if (!source) return;
      // Read the position BEFORE silencing: stopping the source is what makes the clock
      // meaningless, so the order here is the whole of the correctness.
      const at = position();
      silence();
      offset = Math.min(at, buffer.duration);
    },

    stop() {
      done = true;
      silence();
    },

    onEnded(listener) {
      ended = () => {
        trace('audio:ended'); // DIAGNOSIS
        listener();
      };
    },

    /**
     * Nothing to report.
     *
     * An <audio> element could fail to fetch or decode, and had to say so. There is
     * nothing left here that can fail at playing time: the samples are already in hand.
     * The failures that remain all happen while generating, and are reported there.
     */
    onError() {},

    /**
     * Change speed, including mid-sentence.
     *
     * Banking the position first is what keeps a speed change from moving the listener:
     * everything heard so far was heard at the OLD rate, so it has to be measured before
     * the new one applies, or the elapsed time would be re-interpreted at the wrong speed
     * and the sentence would jump.
     */
    setRate(next) {
      if (typeof next !== 'number' || !Number.isFinite(next) || next <= 0) return;
      if (source) {
        offset = position();
        startedAt = ctx.currentTime;
      }
      rate = next;
      // DIAGNOSIS. `live` says whether this reached a sentence already in the air or only
      // set the speed for the next one to start — the difference between a button that
      // works instantly and one that appears to do nothing until the sentence ends.
      trace('audio:rate', { rate, live: Boolean(source) });
      if (source) source.playbackRate.value = rate;
    },
  };
}

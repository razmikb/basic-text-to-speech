/**
 * A voice engine that records what it was asked to say instead of making sound.
 *
 * This is what lets the reader be tested at all: the reader's job is deciding what to
 * speak and when, which is fully observable without a speaker.
 */

export function createFakeEngine() {
  const spoken = [];
  const boundaryListeners = new Set();
  let pending = null;
  let paused = false;
  let speaking = false;

  return {
    /** Everything the reader asked to be spoken, in order. */
    spoken,

    /** Finish the sentence currently being spoken. */
    finish(outcome = 'ended') {
      const settle = pending;
      pending = null;
      speaking = false;
      if (settle) settle(outcome);
      return new Promise((resolve) => setImmediate(resolve));
    },

    speak(text, options) {
      spoken.push({ text, options });
      speaking = true;
      paused = false;
      return new Promise((resolve) => {
        pending = resolve;
      });
    },

    pause() {
      paused = true;
    },

    resume() {
      paused = false;
    },

    stop() {
      const settle = pending;
      pending = null;
      speaking = false;
      paused = false;
      if (settle) settle('stopped');
    },

    /** Count of release() calls, so tests can tell a release from a stop. */
    released: 0,

    release() {
      const held = speaking || paused;
      const settle = pending;
      pending = null;
      speaking = false;
      paused = false;
      if (settle) settle('stopped');
      if (held) this.released += 1;
      return held;
    },

    isSpeaking() {
      return speaking && !paused;
    },

    isPaused() {
      return paused;
    },

    onBoundary(listener) {
      boundaryListeners.add(listener);
      return () => boundaryListeners.delete(listener);
    },

    listVoices() {
      return [{ name: 'Test Voice', lang: 'en-US', default: true }];
    },
  };
}

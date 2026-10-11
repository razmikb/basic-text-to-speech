/**
 * Voice engine backed by the browser's built-in speechSynthesis.
 *
 * These are the system voices already installed on the machine — nothing is downloaded
 * and nothing leaves the computer. They are not the most natural voices available, but
 * they start instantly and cost nothing, which is exactly what Phase 1 needs.
 *
 * Everything odd about this API is contained here, per the engine rule. Three quirks matter:
 * the voice list is often empty on first call and arrives asynchronously; speech can
 * silently stall, so an utterance in progress is nudged periodically to stay alive; and
 * — the big one — speechSynthesis is ONE engine shared by every tab in the browser, not
 * one per page. `synth.speaking` and `synth.paused` describe the whole browser, so this
 * engine must never read them to decide what *this* page is doing, and must never leave
 * the shared engine paused when this page is not the one being listened to.
 */

import { isEngine } from './engine.js';

/** How often to nudge the synthesiser to keep long speech from stalling. */
const KEEPALIVE_INTERVAL_MS = 10000;

/**
 * @param {object} [deps] injectable browser globals, so this can be tested off-browser
 * @returns {object} an engine matching the interface in engine.js
 */
export function createWebSpeechEngine(deps = {}) {
  const synth = deps.synth ?? globalThis.speechSynthesis;
  const Utterance = deps.Utterance ?? globalThis.SpeechSynthesisUtterance;
  const setInterval_ = deps.setInterval ?? globalThis.setInterval;
  const clearInterval_ = deps.clearInterval ?? globalThis.clearInterval;

  if (!synth || !Utterance) {
    throw new Error('speechSynthesis is not available in this browser');
  }

  const boundaryListeners = new Set();
  let keepalive = null;
  let stopped = false;
  /**
   * What *this page* is doing, tracked separately from synth.speaking / synth.paused
   * because those are shared with every other tab. Without this, a second tab reads the
   * first tab's state as its own.
   */
  let ownState = 'idle'; // idle | speaking | paused

  function startKeepalive() {
    stopKeepalive();
    keepalive = setInterval_(() => {
      // Pausing and immediately resuming resets the internal timer that causes the
      // synthesiser to fall silent partway through long text.
      if (ownState === 'speaking' && synth.speaking && !synth.paused) {
        try {
          synth.pause();
          synth.resume();
        } catch {
          // A browser that dislikes this is no worse off than without the nudge.
        }
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  function stopKeepalive() {
    if (keepalive !== null) {
      clearInterval_(keepalive);
      keepalive = null;
    }
  }

  function emitBoundary(event) {
    const payload = {
      charIndex: typeof event.charIndex === 'number' ? event.charIndex : 0,
      charLength: typeof event.charLength === 'number' ? event.charLength : 0,
    };
    for (const listener of boundaryListeners) {
      try {
        listener(payload);
      } catch {
        // A broken listener must not stop the speech.
      }
    }
  }

  return {
    /**
     * Speak one piece of text. Resolves with 'ended' when finished, 'stopped' if
     * cancelled, or 'error' if the browser gave up — never rejects, because a single
     * failed sentence must not tear down a whole article.
     */
    speak(text, options = {}) {
      const content = typeof text === 'string' ? text.trim() : '';
      if (content === '') return Promise.resolve('ended');

      stopped = false;
      return new Promise((resolve) => {
        const utterance = new Utterance(content);

        if (typeof options.rate === 'number') utterance.rate = options.rate;
        if (typeof options.pitch === 'number') utterance.pitch = options.pitch;
        if (typeof options.volume === 'number') utterance.volume = options.volume;
        if (typeof options.lang === 'string') utterance.lang = options.lang;

        const voice = findVoice(options.voiceName, options.lang);
        if (voice) utterance.voice = voice;

        let settled = false;
        const finish = (outcome) => {
          if (settled) return;
          settled = true;
          // nothing to release; the promise below is the only handle on this utterance.
          if (ownState === 'speaking') ownState = 'idle';
          stopKeepalive();
          resolve(outcome);
        };

        utterance.onend = () => finish(stopped ? 'stopped' : 'ended');
        utterance.onerror = (event) => {
          // Cancelling fires an error in some browsers; that is a stop, not a failure.
          const reason = event && event.error;
          finish(
            stopped || reason === 'interrupted' || reason === 'canceled' ? 'stopped' : 'error'
          );
        };
        utterance.onboundary = emitBoundary;

        // The browser owns the utterance from here; we track progress via the promise.
        ownState = 'speaking';
        synth.speak(utterance);
        startKeepalive();
      });
    },

    pause() {
      // Only a page that is actually speaking may pause the shared engine. Without this
      // guard a background tab could pause speech belonging to a different tab.
      if (ownState !== 'speaking') return;
      ownState = 'paused';
      if (synth.speaking && !synth.paused) synth.pause();
      stopKeepalive();
    },

    resume() {
      if (ownState !== 'paused') return;
      ownState = 'speaking';
      if (synth.paused) synth.resume();
      startKeepalive();
    },

    stop() {
      stopped = true;
      ownState = 'idle';
      stopKeepalive();
      try {
        synth.cancel();
      } catch {
        // Nothing useful to do; the reader treats stop as final regardless.
      }
    },

    /**
     * Let go of the shared engine without treating this as a user-facing stop.
     *
     * speechSynthesis is one engine for the whole browser: a tab left holding it paused
     * blocks every other tab from speaking at all. So when this page stops being the one
     * being listened to, it hands the engine back. The caller keeps its own position and
     * can start again from there, which is why this is separate from stop().
     *
     * Cancelling is the only way to release a paused queue, and it must come before any
     * resume — resuming first would make a tab the user has already left burst into
     * speech, which is exactly what this is here to prevent.
     */
    release() {
      if (ownState === 'idle') return false;
      stopped = true;
      ownState = 'idle';
      stopKeepalive();
      try {
        // Cancel FIRST. Resuming before cancelling would briefly un-pause the shared
        // engine and let a tab the user has already left blurt out a moment of audio.
        synth.cancel();
        // Some builds leave the shared `paused` flag set even after a cancel, which
        // would keep every other tab silent — the very bug this exists to prevent.
        // There is nothing left of ours to hear, so clearing it is safe here.
        if (synth.paused) synth.resume();
      } catch {
        // Best effort: a browser that refuses is no worse off than before.
      }
      return true;
    },

    isSpeaking() {
      return ownState === 'speaking';
    },

    /** True when this page is holding the shared engine paused. */
    isPaused() {
      return ownState === 'paused';
    },

    /**
     * One speechSynthesis serves the whole browser, so holding it while hidden is exactly
     * the problem release() was written for. This is the engine that must let go.
     */
    sharesVoice() {
      return true;
    },

    onBoundary(listener) {
      if (typeof listener !== 'function') return () => {};
      boundaryListeners.add(listener);
      return () => boundaryListeners.delete(listener);
    },

    listVoices() {
      return voiceList().map((voice) => ({
        name: voice.name,
        lang: voice.lang,
        default: Boolean(voice.default),
      }));
    },
  };

  function voiceList() {
    try {
      const voices = synth.getVoices();
      return Array.isArray(voices) ? voices : [];
    } catch {
      return [];
    }
  }

  /**
   * Choose a voice: the requested one if installed, otherwise the best match for the
   * language, otherwise nothing — letting the browser use its own default.
   */
  function findVoice(name, lang) {
    const voices = voiceList();
    if (voices.length === 0) return null;

    if (typeof name === 'string' && name !== '') {
      const named = voices.find((voice) => voice.name === name);
      if (named) return named;
    }

    if (typeof lang === 'string' && lang !== '') {
      const exact = voices.find((voice) => voice.lang === lang);
      if (exact) return exact;

      const base = lang.split('-')[0].toLowerCase();
      const sameLanguage = voices.find(
        (voice) => typeof voice.lang === 'string' && voice.lang.toLowerCase().startsWith(base)
      );
      if (sameLanguage) return sameLanguage;
    }

    return null;
  }
}

/**
 * Wait for the browser to populate its voice list.
 *
 * getVoices() is commonly empty on the first call and filled in later, which is why a
 * naive implementation picks the wrong voice on the first play of a session.
 *
 * @returns {Promise<void>}
 */
export function whenVoicesReady(deps = {}) {
  const synth = deps.synth ?? globalThis.speechSynthesis;
  const setTimeout_ = deps.setTimeout ?? globalThis.setTimeout;
  const timeoutMs = deps.timeoutMs ?? 2000;

  if (!synth) return Promise.resolve();

  return new Promise((resolve) => {
    const ready = () => {
      try {
        return synth.getVoices().length > 0;
      } catch {
        return true;
      }
    };
    if (ready()) return resolve();

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      synth.onvoiceschanged = null;
      resolve();
    };

    synth.onvoiceschanged = finish;
    // Some builds never fire the event; speaking with a default voice beats hanging.
    setTimeout_(finish, timeoutMs);
  });
}

/** Re-exported so callers can assert the contract without a second import. */
export { isEngine };

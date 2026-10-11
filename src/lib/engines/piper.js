/**
 * Voice engine backed by Piper — a neural voice that runs on this machine.
 *
 * Everything this file does is ask another part of the add-on to make sound, and report
 * back. The voice itself, the WebAssembly, the 60MB model and the audio all live in the
 * add-on's own hidden page (see src/piper/host.js), for two reasons: the model is loaded
 * once for the whole browser instead of once per tab, and it runs under our own security
 * rules rather than those of whatever site we happen to be reading — some sites forbid
 * WebAssembly outright, and the voice must not work only on friendly websites.
 *
 * So this is a remote control, and deliberately dull. Every method below maps to one
 * message. That the mapping is one-to-one is the sign the split is in the right place.
 *
 * Two things about this engine differ from the browser's built-in voices, both allowed by
 * the contract in engine.js:
 *
 *   - It never reports word boundaries. Piper hands back finished audio with no timings
 *     inside it. Sentence highlighting does not need them, because the reader speaks one
 *     sentence at a time and therefore always knows which one is current.
 *   - It cares what is coming next. Piper has to build audio before it can play it, which
 *     takes a second or two, so it uses prime() to work on the next sentence while the
 *     current one is still being heard. Without that there would be a silence before
 *     every single sentence.
 */

import { isEngine } from './engine.js';
// TEMPORARY — diagnosis. Remove with the trace calls below.
import { absorb, trace } from '../trace.js';

/** How long to wait for the voice page to load and, on a first run, download the model. */
const PREPARE_TIMEOUT_MS = 180000;

/**
 * How often to tell the voice page we are still waiting, while it loads or downloads.
 *
 * Firefox puts an add-on's background to sleep after 30 seconds without an incoming
 * message, and the voice page lives inside the background. A first-run download sends
 * news OUT (progress) but nothing comes IN, so 30 seconds in, the background was put to
 * sleep mid-download, the connection dropped, and the article fell back to the browser's
 * own voice — silent on Linux. Found 2026-10-02 by a fresh-profile run. Well under 30s.
 */
export const KEEPALIVE_MS = 10000;

/**
 * @param {object} [deps] injectable, so this can be tested without a browser
 * @returns {object} an engine matching the interface in engine.js
 */
export function createPiperEngine(deps = {}) {
  const api = deps.api ?? globalThis.browser ?? globalThis.chrome;
  /**
   * Which voice is speaking. A LET rather than a const, and that is the whole of what
   * makes changing voice mid-article possible.
   *
   * It used to be captured once when the engine was built, which was fine while the voice
   * could only be chosen in config.js and never changed. Now that a person can pick one
   * from the settings page while an article is playing, the engine has to be able to be
   * told — so every message that carries a voice id reads this at the moment it is sent
   * rather than closing over whatever was true at construction.
   */
  let voiceId = deps.voiceId ?? 'en_US-amy-medium';
  const onProgress = deps.onProgress ?? (() => {});
  /** Told what the voice is doing, so the control bar can show it. */
  const onActivity = deps.onActivity ?? (() => {});
  /**
   * Make sure there is a voice page to connect to, and wait until there is.
   *
   * Asked again after a connection is lost, which is the whole reason it is a dependency
   * rather than something done once by the caller. The voice lives in a frame inside the
   * background page, and Firefox may end that page — it is allowed to, and it did, after
   * a long stall. What comes back afterwards is a background script with no frame in it,
   * so reconnecting the port alone succeeds at connecting to nothing at all.
   *
   * Defaults to "already there", which is what every existing test and the very first
   * connection of a session both want.
   */
  const ensureHost = deps.ensureHost ?? (() => Promise.resolve(true));

  if (!api?.runtime?.connect) throw new Error('Piper needs the extension messaging API');

  let port = null;
  /**
   * Whether the voice page is known to exist since the last connection was lost.
   *
   * Starts true because the caller builds this engine only after asking for the page and
   * being told it is ready. It goes false the moment a connection drops, which is the
   * only signal we get that the page hosting the voice may have died with it.
   */
  let hostConfirmed = true;
  /** What prepare() was last given, so the voice can be rebuilt exactly as it was. */
  let lastPrepare = null;
  /** Replies are matched to requests by number, since several may be in flight. */
  let nextId = 1;
  const waiting = new Map();

  /** What THIS page is doing. Never inferred from the voice page, which serves everyone. */
  let ownState = 'idle'; // idle | speaking | paused

  /** When pause was last asked for, so the voice page's acknowledgement can be timed. */
  let pauseAskedAt = 0;

  /**
   * Which speak request is the current one.
   *
   * Bumped by every speak, so a reply arriving for a sentence that has since been
   * abandoned can be recognised and prevented from reporting on state it no longer owns.
   */
  let speakToken = 0;

  const nowMs = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

  function connect() {
    if (port) return port;

    port = api.runtime.connect({ name: 'ftts:piper' });

    port.onMessage.addListener((message) => {
      if (!message || typeof message.type !== 'string') return;

      // TEMPORARY — diagnosis. Events recorded on the voice page, collected here so the
      // whole run reads as one ordered list on a clock both pages share.
      if (message.type === 'trace') {
        absorb(message.entry);
        return;
      }

      if (message.type === 'progress') {
        onProgress(message);
        return;
      }

      // How long the pause actually took to reach the sound, measured rather than assumed.
      if (message.type === 'paused-at' && pauseAskedAt) {
        const took = Math.round(nowMs() - pauseAskedAt);
        pauseAskedAt = 0;
        console.info(`Basic Text-to-Speech: pause reached the voice in ${took}ms.`);
        onActivity({ phase: 'paused', pauseLatencyMs: took });
        return;
      }

      // Unprompted news about what the voice is doing. It answers no request, so it is
      // handled before the reply matching below rather than falling through it.
      if (message.type === 'activity') {
        try {
          onActivity(message);
        } catch {
          // A progress display must never disturb speaking.
        }
        return;
      }

      const settle = waiting.get(message.id);
      if (!settle) return;
      waiting.delete(message.id);
      settle.cancelTimeout?.();

      if (message.type === 'failed') settle.resolve({ error: message.message });
      else settle.resolve(message);
    });

    port.onDisconnect.addListener(() => {
      port = null;
      ownState = 'idle';
      // The voice page may have gone with it, so the next connection must not assume one
      // is waiting. Re-asked rather than re-created here, because creating it is the
      // background script's job and this engine only ever talks to it.
      hostConfirmed = false;
      // Anything still waiting will never be answered now. A sentence settles as
      // 'stopped', so the reader simply stops rather than waiting for speech that will
      // never end — but it is also reported as an error, because losing the connection is
      // a genuine failure and anything checking must be able to tell.
      //
      // Both halves matter. Reporting only 'stopped' once made a lost connection look
      // like success to prepare(), so the add-on announced a ready voice, fell back to
      // nothing, and sat in silence.
      for (const settle of waiting.values()) {
        settle.cancelTimeout?.();
        settle.resolve({ outcome: 'stopped', error: 'the voice stopped answering' });
      }
      waiting.clear();
    });

    return port;
  }

  /** Send a message and wait for its matching reply. */
  function request(message, timeoutMs) {
    const id = nextId++;
    const channel = connect();

    return new Promise((resolve) => {
      const entry = { resolve };
      waiting.set(id, entry);

      try {
        // sentAt is TEMPORARY — diagnosis: it lets the voice page report how long this
        // message waited before it was even looked at.
        channel.postMessage({ ...message, id, sentAt: Date.now() });
      } catch (error) {
        waiting.delete(id);
        resolve({ error: String(error?.message ?? error) });
        return;
      }

      if (!timeoutMs) return;

      // Only used while waiting for the voice to load, which is the one step that can
      // take minutes. Cancelled the moment an answer arrives — a timer left running
      // would keep this alive long after there is anything to wait for.
      const timer = setTimeout(() => {
        clearInterval(keepalive);
        if (!waiting.has(id)) return;
        waiting.delete(id);
        resolve({ error: 'the voice took too long to answer' });
      }, timeoutMs);

      // The same long waits are the ones where the background could be put to sleep under
      // us — see KEEPALIVE_MS. Any message in keeps it awake; the voice page ignores this one.
      const keepalive = setInterval(() => {
        try {
          channel.postMessage({ type: 'keepalive' });
        } catch {
          // Gone already; disconnect settles this request.
        }
      }, KEEPALIVE_MS);

      entry.cancelTimeout = () => {
        clearTimeout(timer);
        clearInterval(keepalive);
      };
    });
  }

  /**
   * Put the voice back together after a connection was lost.
   *
   * TWO STEPS, AND THE SECOND IS THE ONE THAT WAS MISSING. Making sure the page exists is
   * not enough: the voice page starts empty, and the pipeline that actually speaks is
   * built by `prepare`. A reconnected port reaches a live page with no pipeline, which
   * refuses every sentence the instant it arrives — the port is fine, the message lands,
   * and the answer is still no.
   *
   * Returns false rather than throwing, because the caller's only sane response is to
   * stop where it is, and a rejected promise there would be one more thing to get right.
   */
  async function rebuildHost() {
    try {
      const ready = await ensureHost();
      if (ready === false) {
        trace('engine:rebuild-failed', { error: 'the voice has nowhere to run' });
        return false;
      }
    } catch (error) {
      trace('engine:rebuild-failed', { error: String(error?.message ?? error) });
      return false;
    }

    // Nothing to rebuild if this engine was never prepared in the first place.
    if (lastPrepare) {
      const reply = await request({ type: 'prepare', voiceId, ...lastPrepare }, PREPARE_TIMEOUT_MS);
      if (reply.error) {
        trace('engine:rebuild-failed', { error: reply.error });
        return false;
      }
    }

    hostConfirmed = true;
    trace('engine:rebuilt'); // TEMPORARY — diagnosis
    return true;
  }

  /** Fire-and-forget: nothing useful can be done with a reply to these. */
  function tell(message) {
    try {
      connect().postMessage({ ...message, sentAt: Date.now() }); // sentAt: TEMPORARY
    } catch {
      // The voice page has gone; the next request reconnects.
    }
  }

  return {
    /**
     * Load the voice, downloading it on a first run.
     *
     * Separate from speak() on purpose: it can take half a minute the very first time,
     * and the caller may want to say so before any sound is expected.
     */
    async prepare(options = {}) {
      // Kept so the voice can be set up again after a lost connection. A reconnected port
      // reaches a voice page with NO PIPELINE IN IT — prepare is what builds one — and a
      // speak sent to a page in that state is refused instantly. Remembering the options
      // is what makes rebuilding possible without asking the caller to do it again.
      lastPrepare = { ...options };
      const reply = await request(
        {
          type: 'prepare',
          voiceId,
          rate: options.rate ?? 1,
          splitFirstSentence: Boolean(options.splitFirstSentence),
          // Which article this is. The voice keeps the audio it builds so that skipping
          // back is instant, and this is how it knows when that audio stopped being
          // about the page in front of the listener.
          articleId: options.articleId,
        },
        PREPARE_TIMEOUT_MS
      );
      if (reply.error) throw new Error(reply.error);
      return true;
    },

    async speak(text, options = {}) {
      const content = typeof text === 'string' ? text.trim() : '';
      if (content === '') return 'ended';

      // Which sentence this is. A skip abandons the one in flight and starts another
      // immediately, and the abandoned one still gets an answer afterwards — generation
      // cannot be called back. Without a token to check, that late answer cleared the
      // state belonging to the sentence that had REPLACED it, leaving this engine
      // believing nothing was playing while sound was coming out. The next pause was then
      // dropped by the guard in pause(), and the sentence played on to its end.
      //
      // Found in the owner's trace, where the two sides plainly disagreed:
      //   reader:pause state="playing"  /  engine:pause ownState="idle"
      const mine = ++speakToken;

      // Rebuild the voice page if the last connection took it with it. Without this the
      // reconnect below succeeds at connecting to a background script that no longer has
      // a voice in it: the port opens, closes immediately, and the sentence settles as
      // 'stopped' in a few milliseconds. Every layer reports honestly and nothing is
      // heard ever again — the failure the owner hit on 2026-09-14, where play worked,
      // the bar showed playing, and the add-on was silent until the tab was reloaded.
      if (!hostConfirmed) {
        trace('engine:rebuilding-host'); // TEMPORARY — diagnosis
        const rebuilt = await rebuildHost();
        if (!rebuilt) {
          ownState = 'idle';
          // 'stopped', NEVER 'error'. An error means THIS SENTENCE failed, and the reader
          // answers that by stepping over it and trying the next one — correct for one
          // bad sentence, catastrophic for a voice that is down, because every remaining
          // sentence fails the same way and the article is skipped to its end in a
          // fraction of a second. The owner saw exactly that on 2026-09-14: play, and the
          // whole article gone in 400ms. A stop leaves the listener where they were.
          return 'stopped';
        }
      }

      ownState = 'speaking';
      // TEMPORARY — diagnosis. The round trip for one sentence: this is asked here and
      // answered when the sound finishes, so a long gap between the two with no playback
      // in between is the handover failing rather than the audio being slow.
      trace('engine:speak', { chars: content.length, text: content.slice(0, 40) });
      const reply = await request({ type: 'speak', text: content, rate: options.rate });
      trace('engine:spoke', {
        outcome: reply.outcome ?? (reply.error ? 'error' : 'ended'),
        stale: mine !== speakToken,
      });

      // Only the sentence still current may report on the state. A stale one returns its
      // outcome — the reader needs that to know it was stopped — but touches nothing.
      if (mine === speakToken && ownState === 'speaking') ownState = 'idle';
      // A definite outcome wins over the error note that may accompany it: losing the
      // connection mid-sentence is a stop, not a sentence that failed to be spoken, and
      // the reader must not step past a sentence nobody heard.
      if (reply.outcome) return reply.outcome;
      return reply.error ? 'error' : 'ended';
    },

    /**
     * Change the speaking speed of an article already under way.
     *
     * Takes effect on the sentence being spoken, not just the next one, because this voice
     * applies speed to the audio as it plays rather than baking it in when the audio is
     * built. Fire-and-forget: there is nothing useful to do about a speed change that does
     * not arrive, and the rate is passed with every speak() as well.
     */
    setRate(rate) {
      if (typeof rate !== 'number' || !Number.isFinite(rate)) return;
      tell({ type: 'rate', rate });
    },

    /**
     * Change which voice speaks, part-way through an article.
     *
     * DELIBERATELY NOT INSTANT, unlike setRate. A speed change can be applied to the
     * sentence already in the air; a voice change cannot — the sentence being spoken was
     * BUILT by the old voice, and the only way to hear it in the new one is to build it
     * again. Cutting it off mid-word to do that would be more jarring than hearing the
     * change one sentence later, which is exactly the judgement the speed change made
     * when it moved from playback to the model.
     *
     * So this hands the new id to the voice page and lets it do the expensive half: it
     * notices the id has changed, rebuilds the pipeline, drops the audio banked ahead in
     * the old voice, and lets the old 60MB model go. The sentence in flight finishes as
     * it was.
     *
     * A change to the voice already speaking is dropped rather than announced, because
     * one costs a download on a first run and a rebuild of everything banked ahead —
     * the same reason a no-op speed change is dropped.
     */
    setVoice(nextVoiceId) {
      if (typeof nextVoiceId !== 'string' || nextVoiceId === '') return false;
      if (nextVoiceId === voiceId) return false;
      voiceId = nextVoiceId;
      tell({ type: 'voice', voiceId });
      return true;
    },

    /** Which voice is speaking right now. */
    voice() {
      return voiceId;
    },

    /** See engine.js: a hint about what is coming, never a request to make sound. */
    prime(text) {
      const content = typeof text === 'string' ? text.trim() : '';
      if (content === '') return;
      tell({ type: 'prime', text: content });
    },

    pause() {
      trace('engine:pause', { ownState }); // TEMPORARY — diagnosis
      if (ownState !== 'speaking') return;
      ownState = 'paused';
      // Timed, because "pause feels slow" is a claim about a number nobody has measured.
      // Every hop between the button and the sound looked fast when read; this reports what
      // it actually costs, so the next round is aimed at evidence rather than at a guess.
      pauseAskedAt = nowMs();
      tell({ type: 'pause', askedAt: pauseAskedAt });
    },

    resume() {
      trace('engine:resume', { ownState }); // TEMPORARY — diagnosis
      if (ownState !== 'paused') return;
      ownState = 'speaking';
      tell({ type: 'resume' });
    },

    stop() {
      trace('engine:stop', { ownState }); // TEMPORARY — diagnosis
      ownState = 'idle';
      tell({ type: 'stop' });
    },

    /**
     * Unlike the browser's shared synthesiser, Piper holds nothing another tab is waiting
     * for, so this only has to stop the sound. The loaded voice deliberately stays in
     * memory: throwing away 60MB that took half a minute to load, for a tab the listener
     * may return to in seconds, is a poor trade.
     */
    release() {
      const held = ownState !== 'idle';
      ownState = 'idle';
      tell({ type: 'stop' });
      return held;
    },

    /**
     * Nothing here is shared, so nobody gains when this page lets go.
     *
     * The voice runs in the add-on's own hidden page — one for the whole browser, reached
     * by every article tab. A tab that walks away holding it is not standing in anyone's
     * queue, because the next tab to speak simply connects and takes over.
     *
     * This exists because saying so in a comment was not enough. The caller released on
     * every hidden pause anyway, which threw away the sentences already built and left
     * the listener in silence on return. Prose cannot be read by a caller; this can.
     */
    sharesVoice() {
      return false;
    },

    isSpeaking() {
      return ownState === 'speaking';
    },

    isPaused() {
      return ownState === 'paused';
    },

    /**
     * Piper produces finished audio with no word timings, so this never fires. The
     * contract allows it and the reader works without it — see engine.js.
     */
    onBoundary() {
      return () => {};
    },

    listVoices() {
      return [{ name: voiceId, lang: 'en-US', default: true }];
    },

    /** Let go of the connection entirely, e.g. when the page is going away. */
    disconnect() {
      if (!port) return;
      try {
        port.disconnect();
      } catch {
        // Already gone.
      }
      port = null;
    },
  };
}

/** Re-exported so callers can assert the contract without a second import. */
export { isEngine };

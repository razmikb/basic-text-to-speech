/**
 * The reader — the brain of the add-on.
 *
 * It owns the list of sentences and which one is current, and it drives the voice engine
 * one sentence at a time. It knows nothing about how sound is produced and nothing about
 * how the page is drawn: it speaks through the engine interface and announces what it is
 * doing through events. That separation is what lets Phase 2 add highlighting and Phase 4
 * swap the voice without touching this file.
 *
 * Speaking sentence-by-sentence rather than handing over the whole article at once is a
 * deliberate choice: it gives exact sentence boundaries for highlighting, keeps skip
 * forward/back cheap, and sidesteps the browser's habit of stalling on long text.
 */

// TEMPORARY — diagnosis. Remove with the trace calls below.
import { trace } from './trace.js';

import { splitSentences } from './sentences.js';

/**
 * How many upcoming sentences to mention to the engine.
 *
 * Not a buffer size — the engine decides what to do with these. It is simply how far ahead
 * the reader is willing to look.
 *
 * This was 3, when work done further ahead was thrown away on every skip and a deep look
 * was therefore wasteful. The Piper pipeline now keeps everything it builds for an article,
 * so that is no longer true and the number is set by what keeps the voice busy instead.
 *
 * Measured on the owner's machine: a sentence takes about 1.9 seconds to build and about
 * 8.8 seconds to speak. At 3 the voice ran out of work roughly half way through every
 * sentence and sat idle until the next one began, because it could not be told about
 * sentence four until sentence one had finished. Eight keeps it fed.
 *
 * Must be read together with LOOKAHEAD_SENTENCES in `src/piper/pipeline.js`: they are two
 * halves of one limit and the smaller governs, so raising this alone would do nothing.
 */
const PRIME_AHEAD = 8;

/** @typedef {{text: string, blockIndex: number, start: number, end: number}} Sentence */

/**
 * Turn extracted blocks into one flat list of sentences.
 *
 * Each sentence remembers which block it came from and where inside that block it sits,
 * which is what Phase 2 will need to find it on the page again.
 *
 * @param {Array<{text: string}>} blocks
 * @returns {Sentence[]}
 */
export function buildSentences(blocks) {
  if (!Array.isArray(blocks)) return [];

  const sentences = [];
  blocks.forEach((block, blockIndex) => {
    const text = block && typeof block.text === 'string' ? block.text : '';
    for (const sentence of splitSentences(text)) {
      sentences.push({
        text: sentence.text,
        blockIndex,
        start: sentence.start,
        end: sentence.end,
      });
    }
  });

  return sentences;
}

/**
 * Create a reader over a sentence list.
 *
 * @param {object} options
 * @param {object} options.engine a voice engine (see engines/engine.js)
 * @param {Sentence[]} options.sentences
 * @param {object} [options.config] speaking settings; see lib/config.js
 */
export function createReader({ engine, sentences = [], config = {} }) {
  if (!engine) throw new Error('reader needs a voice engine');

  const listeners = new Map();

  let index = 0;
  let state = 'idle'; // idle | playing | paused | finished
  /** Distinguishes "this sentence ended" from "a newer request replaced it". */
  let generation = 0;

  function emit(event, detail) {
    const bucket = listeners.get(event);
    if (!bucket) return;
    for (const listener of [...bucket]) {
      try {
        listener(detail);
      } catch {
        // A listener that throws must not stop playback.
      }
    }
  }

  function setState(next) {
    if (state === next) return;
    state = next;
    emit('state', { state, index });
  }

  /**
   * Speak sentences from `index` onward until they run out or something interrupts.
   * Each sentence checks its generation on completion, so a skip or stop that happened
   * while it was speaking cleanly abandons this loop instead of racing with the new one.
   */
  /**
   * True when a pause was taken but the sentence it landed in then finished on its own.
   *
   * The ordinary pause leaves audio held mid-sentence, which the engine can simply
   * continue. This case leaves nothing held: the sentence completed, the position has
   * already moved to the next one, and playing again means starting that next sentence
   * rather than resuming anything. Without distinguishing the two, play() asked the
   * engine to resume audio that had finished and silently did nothing at all.
   */
  let resumeNeedsRestart = false;

  async function run() {
    const mine = ++generation;
    setState('playing');
    resumeNeedsRestart = false;

    while (mine === generation && index < sentences.length) {
      const sentence = sentences[index];
      // TEMPORARY — diagnosis. Where the reader believes it is, so a skip that lands
      // somewhere unexpected shows up as a position rather than as a guess.
      trace('reader:sentence', { index, chars: sentence.text.length });
      emit('sentence', { index, sentence });

      const speaking = engine.speak(sentence.text, {
        rate: config.rate,
        pitch: config.pitch,
        volume: config.volume,
        voiceName: config.voiceName,
        lang: config.lang,
      });

      // Tell the engine what is coming, so a voice that has to build its audio can do so
      // while this sentence is still being heard instead of falling silent between every
      // one. Purely a hint: engines that speak instantly ignore it, and deleting these
      // lines would cost speed but change nothing about what gets read.
      //
      // Several sentences are offered, not just the next one. Building audio is faster
      // than speaking it, so an engine given only one sentence of warning runs out of work
      // and idles through the spare time — then has nothing banked when a long or awkward
      // sentence takes longer than usual. Offering a few lets it build a cushion. How much
      // it actually uses is the engine's business, not ours.
      for (let ahead = 1; ahead <= PRIME_AHEAD; ahead += 1) {
        const upcoming = sentences[index + ahead];
        if (!upcoming) break;
        engine.prime?.(upcoming.text);
      }

      const outcome = await speaking;

      if (mine !== generation) return; // Superseded by a newer command.
      if (outcome === 'stopped') return;

      // An engine error drops one sentence rather than ending the article — the article
      // continuing with a gap is far better than playback dying silently mid-page.
      index += 1;

      /*
       * Stop here if the listener paused while that sentence was in the air.
       *
       * A pause nearly always lands mid-sentence — that is when someone realises they
       * want to stop — and the sentence it lands in goes on to finish, because it was
       * already built and already playing. This loop is sitting at the await above when
       * that happens, and without this check it simply carried on and spoke the NEXT
       * sentence, out loud, after the listener had asked for silence.
       *
       * What made it confusing rather than merely wrong is how it sounded. `index` has
       * moved on by then, so pressing play afterwards resumed from the sentence the loop
       * had already started, and the listener heard a sentence repeat itself — with no
       * skip pressed and nothing in the code that obviously goes backwards. It showed up
       * in the owner's log as the position moving 3 -> 4 -> 3 -> 4 around each pause.
       *
       * Checked after `index` is advanced, deliberately: the sentence that just finished
       * WAS heard in full, so the place to resume from is the one after it.
       */
      if (state === 'paused') {
        // The sentence finished in full, so there is no held audio to resume — `index`
        // has already moved past it. Say so, or play() would ask the engine to continue
        // audio that no longer exists and nothing at all would happen.
        resumeNeedsRestart = true;
        return;
      }
    }

    if (mine !== generation) return;

    if (index >= sentences.length) {
      index = sentences.length;
      setState('finished');
      emit('finished', { count: sentences.length });
    }
  }

  /**
   * The first sentence of the paragraph after the one holding `from`.
   *
   * Runs off the end deliberately clamped to the last sentence rather than stopping dead:
   * pressing forward on the closing paragraph should take you to its end, not do nothing.
   */
  function nextParagraphStart(from) {
    const block = sentences[from]?.blockIndex;
    for (let i = from + 1; i < sentences.length; i += 1) {
      if (sentences[i].blockIndex !== block) return i;
    }
    return sentences.length - 1;
  }

  /** Where the paragraph holding `from` begins. */
  function paragraphStart(from) {
    const block = sentences[from]?.blockIndex;
    let start = from;
    while (start > 0 && sentences[start - 1].blockIndex === block) start -= 1;
    return start;
  }

  /**
   * The start of this paragraph, or of the one before it when we are already there.
   */
  function previousParagraphStart(from) {
    const start = paragraphStart(from);
    if (start < from) return start;
    if (start === 0) return 0;
    return paragraphStart(start - 1);
  }

  /** Engines may report a paused hold; ones that cannot simply never claim it. */
  function isEnginePaused() {
    return typeof engine.isPaused === 'function' ? Boolean(engine.isPaused()) : false;
  }

  return {
    /** Start speaking, or resume if paused. */
    play() {
      if (sentences.length === 0) {
        setState('finished');
        emit('finished', { count: 0 });
        return;
      }
      if (state === 'paused') {
        // If the engine still holds our paused speech, continue it. If it was released
        // (see releaseVoice) there is nothing to resume, so re-speak the current
        // sentence from the start — the price of having handed the voice back.
        //
        // TEMPORARY — diagnosis. Which of these two branches runs matters enormously to
        // how play FEELS: resuming held audio is instant, while re-speaking has to build
        // the sentence again from nothing. "Play is sometimes slow" may simply be this
        // falling down the second path, which the trace will show plainly.
        if (!resumeNeedsRestart && (engine.isSpeaking() || isEnginePaused())) {
          trace('reader:play', { via: 'resume — instant' });
          engine.resume();
          setState('playing');
          return;
        }
        trace('reader:play', { via: 'RE-SPEAK — must build again' });
        run();
        return;
      }
      if (state === 'playing') return;
      if (state === 'finished') index = 0;
      trace('reader:play', { via: 'from idle', index }); // TEMPORARY
      run();
    },

    pause() {
      trace('reader:pause', { state }); // TEMPORARY — diagnosis
      if (state !== 'playing') return;
      // Announced before the engine is asked, not after.
      //
      // Silencing the sound may involve another document — the neural voice runs in a page
      // of its own — and however quick that is, it is not free. The control bar redraws
      // itself from this announcement, so doing it first is what makes the button change
      // under the finger that pressed it rather than a moment later. Nothing here depends
      // on the engine having finished, so there is nothing to wait for.
      setState('paused');
      engine.pause();
    },

    /** Pause if playing, play if not — what the toolbar button and Phase 3 bar will use. */
    toggle() {
      if (state === 'playing') this.pause();
      else this.play();
    },

    /** Stop and forget the position. Everything added to the page comes off after this. */
    stop() {
      generation += 1;
      engine.stop();
      index = 0;
      setState('idle');
    },

    /**
     * Hand the voice back without losing our place.
     *
     * Used when this page stops being the one being listened to. The engine may be
     * shared with other pages (the browser's speechSynthesis is), and a page holding it
     * while hidden blocks every other page from speaking. Afterwards this reader is
     * 'paused' at the current sentence, so play() picks up exactly where it left off.
     *
     * Bumping the generation first is what makes this safe: the sentence currently being
     * spoken is abandoned mid-flight, and its completion is ignored rather than being
     * counted as finished, so we resume that same sentence instead of skipping it.
     */
    releaseVoice() {
      if (state !== 'playing' && state !== 'paused') return false;
      generation += 1;
      if (typeof engine.release === 'function') engine.release();
      else engine.stop();
      setState('paused');
      return true;
    },

    /**
     * Jump `offset` sentences from the current one and carry on speaking if we were.
     * Used by Phase 3's skip buttons; kept here because position is the reader's job.
     */
    skip(offset) {
      if (sentences.length === 0) return;
      const target = clamp(index + offset, 0, sentences.length - 1);
      trace('reader:skip', { offset, from: index, to: target, state }); // TEMPORARY
      const wasPlaying = state === 'playing' || state === 'paused';

      generation += 1;
      engine.stop();
      index = target;

      if (wasPlaying) run();
      else emit('sentence', { index, sentence: sentences[index] });
    },

    /**
     * Start speaking at an exact sentence, whatever the reader was doing — for "Read from
     * here". Unlike seek(), this always plays: from idle, paused, or finished alike, where
     * seek() followed by play() would restart a finished article from the top.
     */
    playFrom(target) {
      if (sentences.length === 0) {
        this.play();
        return;
      }
      trace('reader:playFrom', { from: index, to: target, state }); // TEMPORARY
      generation += 1;
      engine.stop();
      index = clamp(target, 0, sentences.length - 1);
      run();
    },

    /** Move to an exact sentence, for a Phase 2 click-to-start-here. */
    seek(target) {
      this.skip(clamp(target, 0, Math.max(0, sentences.length - 1)) - index);
    },

    /**
     * Jump a whole paragraph at a time, forward (+1) or back (-1).
     *
     * A paragraph is a block from the extractor, and every sentence already remembers
     * which block it came from — so this needs no new knowledge of the page, only
     * arithmetic on what the sentence list already says. That is why it belongs here
     * next to skip() rather than in the control bar: position is the reader's job, and
     * the bar should not be doing sums about paragraphs.
     *
     * Going back means "the start of the paragraph I am in", unless I am already at that
     * start, in which case it means the paragraph before. This is how the back button on
     * every music player behaves, and it is the useful behaviour: the common wish partway
     * through a paragraph is to hear that paragraph again, not to leave it.
     */
    skipParagraph(direction) {
      trace('reader:skipParagraph', { direction, from: index, state }); // TEMPORARY
      if (sentences.length === 0) return;

      const forward = direction > 0;
      const target = forward ? nextParagraphStart(index) : previousParagraphStart(index);
      this.seek(target);
    },

    /**
     * Subscribe to 'state', 'sentence', or 'finished'.
     * @returns {() => void} unsubscribe
     */
    on(event, listener) {
      if (typeof listener !== 'function') return () => {};
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
      return () => listeners.get(event)?.delete(listener);
    },

    /**
     * Whether letting go of the voice would free anything for anyone else.
     *
     * Asked before releasing on a hidden page. An engine that does not answer is assumed
     * to share — the old behaviour, and the safe one, since releasing something unshared
     * merely costs this page its place while releasing something shared unblocks others.
     */
    sharesVoice() {
      return typeof engine.sharesVoice === 'function' ? engine.sharesVoice() !== false : true;
    },

    getState() {
      return state;
    },

    getIndex() {
      return index;
    },

    getSentences() {
      return sentences;
    },
  };
}

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

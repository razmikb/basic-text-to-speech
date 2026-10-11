/**
 * The voice engine contract.
 *
 * Every way of producing sound — the browser's built-in voices today, a downloaded
 * neural model in Phase 4 — implements exactly this and nothing more. The reader talks
 * only to this shape, so adding a voice never touches the reader, highlighter, or UI.
 *
 * An engine is:
 *
 *   speak(text, options)  start speaking one piece of text. Returns a Promise that
 *                         settles when that text finishes, is stopped, or fails.
 *                         Options: { rate, pitch, volume, voiceName, lang }.
 *   pause()               hold at the current position.
 *   resume()              continue from where pause() left off.
 *   stop()                abandon anything queued or in progress.
 *   release()             give up any hold on a shared audio device without this
 *                         counting as a user-facing stop. The caller keeps its own
 *                         position and may speak again later. Engines that own nothing
 *                         shared may simply stop. Returns true if anything was held.
 *   isSpeaking()          true between speak() and its completion.
 *   onBoundary(fn)        register a callback fired as speech passes each word, with
 *                         { charIndex, charLength }. Returns an unsubscribe function.
 *                         An engine that cannot report boundaries simply never fires it;
 *                         callers must work without them.
 *   listVoices()          the voices this engine can offer, as { name, lang, default }.
 *
 * Optional, and safe to leave out:
 *
 *   sharesVoice()         true if this engine is backed by something the whole browser
 *                         shares, so a page holding it while hidden blocks other pages.
 *                         Absent means true, which is the safe assumption: an engine that
 *                         does not say is treated as shared and released as before.
 *   isPaused()            true while this engine holds a pause of its own.
 *   prime(text)           a hint that `text` will probably be spoken soon. The engine may
 *                         start preparing it, or ignore it entirely. It never makes a
 *                         sound and returns nothing worth waiting on.
 *
 * Why prime() exists, and why it belongs here rather than inside one engine.
 *
 * The browser's built-in voices start speaking the instant they are asked. A neural voice
 * does not: it *manufactures* the audio first, which takes seconds. Asked for one sentence
 * at a time with no warning of what follows, such an engine must fall silent before every
 * sentence while it builds the next one — and no amount of cleverness inside the engine
 * can avoid that, because the information it needs simply is not there.
 *
 * So the interface was incomplete, and this is the missing piece: a caller that knows what
 * comes next may say so. Note what prime() does NOT carry — nothing about models, audio,
 * or how long anything takes. It states one fact that is true of every engine: the next
 * sentence is knowable in advance. An engine that cannot use it ignores it, and a caller
 * that never calls it loses speed, never correctness.
 *
 * Why release() exists: the browser's speechSynthesis is one engine shared by every tab,
 * so a page that walks away holding it paused silently blocks every other page. Any
 * engine backed by a shared or exclusive audio device has the same problem, which is why
 * this belongs in the contract rather than in one implementation.
 *
 * Why sharesVoice() had to exist too, learned the expensive way on 2026-09-14. Releasing
 * is not free — it throws away audio already built — and it is only worth paying when
 * something else is waiting for what is held. Piper waits for nobody: it runs in the
 * add-on's own page, one per browser, and a hidden article holding it blocks nothing.
 * Releasing it anyway cost a listener their place, discarded three banked sentences and
 * left the add-on silent. The caller cannot know which kind of engine it has without
 * asking, and asking is exactly what an interface is for.
 *
 * This file is documentation, not machinery: it is the single place that says what an
 * engine is. If a future engine needs the reader to change, the interface is wrong.
 */

/**
 * Names an engine may provide but need not. Documented here so the distinction between
 * "not implemented" and "forgotten" is written down rather than remembered.
 */
export const OPTIONAL_ENGINE_METHODS = ['isPaused', 'prime', 'sharesVoice'];

/** Names every engine must provide. Used by tests to keep implementations honest. */
export const ENGINE_METHODS = [
  'speak',
  'pause',
  'resume',
  'stop',
  'release',
  'isSpeaking',
  'onBoundary',
  'listVoices',
];

/**
 * True if `engine` provides the whole contract.
 * @param {object} engine
 */
export function isEngine(engine) {
  if (!engine || typeof engine !== 'object') return false;
  return ENGINE_METHODS.every((method) => typeof engine[method] === 'function');
}

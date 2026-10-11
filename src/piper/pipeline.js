/**
 * The Piper pipeline — generate one sentence while the previous one is playing.
 *
 * WHY THIS EXISTS. Piper does not speak text; it *manufactures* audio from it, and that
 * takes real time — measured on this machine at roughly a third of the length of the
 * finished audio. Generate a whole paragraph before playing any of it and you get
 * fourteen to twenty seconds of silence, which is unusable. Generate one sentence at a
 * time and you get a much shorter wait, but a gap before every single sentence.
 *
 * The way out is that generating runs faster than speaking. While sentence one is being
 * heard there is spare time to make sentence two, so it is ready before it is needed.
 * After the first sentence, playback should never have to wait again.
 *
 * HOW FAR AHEAD IT WORKS. Several sentences, never the whole article. Building is faster
 * than speaking, so the spare time accumulates into a cushion that absorbs a sentence
 * which takes unusually long to build — that cushion is what stops the occasional pause.
 * It is still capped, but no longer because the work would be wasted: everything built is
 * now kept for the length of the article (see the cache below), so a skip costs nothing.
 * The cap is there because the sentence the listener skips TO waits behind whatever is
 * already being built. Only one sentence is ever built at a time: they share a single
 * thread, so building two at once would make the one needed soonest arrive later.
 *
 * ON SPLITTING THE FIRST SENTENCE, and why it is now off by default. Speaking only the
 * opening clause gets sound out roughly four seconds sooner, but it costs smoothness for
 * the rest of the article: the tail of that first sentence has to be built too, so it
 * competes for the single generator with sentence two, and the pipeline never gets a full
 * sentence ahead. The owner listened to both and chose the opposite trade — wait a few
 * more seconds at the start, then never pause again. Startup is a one-off; a gap between
 * every sentence is heard for the length of the article.
 *
 * This file is deliberately free of WebAssembly, audio, and browser APIs — they all
 * arrive as injectable dependencies. That is what lets the tricky part, the ordering and
 * cancellation logic, be tested properly without a browser or a 60MB model.
 */

/**
 * An opening sentence longer than this is split at a comma so speech can start sooner.
 * Chosen from the measured numbers: ~186 characters took 5.58 seconds, which is far too
 * long to wait after pressing play, while a chunk of this size lands near 1.5 seconds.
 */
const LONG_OPENER_CHARACTERS = 120;

/** Never split so close to the start that the first chunk sounds like a fragment. */
const MIN_OPENING_CHUNK = 30;

/**
 * How many sentences may be built ahead of the one being spoken.
 *
 * This was 3, on the reasoning that work built ahead was thrown away whenever the listener
 * skipped, so a deep queue was a liability. The cache below removed that premise: nothing
 * built is discarded any more, so preparing further ahead costs memory and nothing else.
 *
 * 8 comes from measurement rather than taste. On the owner's machine a sentence takes
 * about 1.9 seconds to build and about 8.8 seconds to speak, so building runs at roughly a
 * fifth of the speed it is consumed at. Eight sentences is around seventy seconds of banked
 * audio — a cushion deep enough that a run of slow sentences cannot catch up with playback,
 * and about 3MB, which is nothing beside the 60MB model already loaded.
 *
 * It is still capped rather than unlimited, because the sentence the listener skips TO
 * waits behind whatever is already being built, and that wait grows with the depth of the
 * queue. Eight is deep enough to never run dry and shallow enough to stay responsive.
 *
 * Paired with PRIME_AHEAD in `src/lib/reader.js`, which decides how many sentences are
 * offered in the first place. They are two halves of one limit: raising either alone
 * changes nothing, because the smaller of the two governs.
 */
const LOOKAHEAD_SENTENCES = 8;

/**
 * @param {object} deps
 * @param {(text: string) => Promise<any>} deps.generate turn text into playable audio
 * @param {(audio: any) => object} deps.createPlayer wrap that audio in something playable
 * @param {(activity: object) => void} [deps.onActivity] told what the voice is doing, so a
 *   caller can show it. Purely informational: nothing here changes what gets spoken, and a
 *   caller that ignores it loses a progress display and nothing else.
 * @param {() => number} [deps.now] the clock, injectable so tests need not wait
 */
export function createPipeline({
  generate,
  createPlayer,
  splitFirstSentence = false,
  onActivity,
  now = () => Date.now(),
}) {
  if (typeof generate !== 'function') throw new Error('pipeline needs a generate function');
  if (typeof createPlayer !== 'function') throw new Error('pipeline needs a createPlayer function');

  /**
   * Sentences already built or being built, oldest first: `{ text, promise }`.
   *
   * Matched by text rather than position, because after a skip the reader asks for a
   * sentence we may never have been told about.
   *
   * Building audio is faster than speaking it, so once playback is under way this fills
   * up and stays full — that spare capacity is the whole point. A sentence that takes
   * unusually long to build is then absorbed by the cushion instead of becoming a pause.
   */
  const ready = [];

  /**
   * Every sentence built for this article, by text: `text -> { audio }`.
   *
   * WHY KEEP IT. Audio used to be thrown away the instant a sentence finished, so skipping
   * back meant building it again from scratch — a wait, for a sentence that had already
   * been made. Worse, a skip forward binned everything prepared ahead, which is why the
   * lookahead had to be kept small: deep preparation was a liability, because any skip
   * wasted it.
   *
   * Keeping it inverts that. Skipping becomes free in both directions, re-listening to a
   * paragraph costs nothing, and building further ahead stops being a gamble — which is
   * what allows the lookahead above to be as large as it now is.
   *
   * WHAT IT COSTS. Piper's audio is 16-bit mono at 22050Hz: about 43KB per second of
   * speech, so a typical sentence is under half a megabyte and a very long article is
   * around 50MB. That is less than the voice model already held in this page, which is
   * what makes "keep all of it" the simple, affordable answer rather than an extravagance.
   *
   * WHY BY TEXT. The same key the queue and `prime` already use. Two identical sentences
   * in one article therefore share their audio, which is correct — identical text sounds
   * identical — and is a small bonus rather than a compromise.
   *
   * FAILURES ARE NOT KEPT. A sentence that failed to generate is retried if it is visited
   * again. Caching the failure would make one bad moment permanent for the whole article.
   */
  const cache = new Map();

  /** Which article the cache belongs to. See `setArticle` for why this is the owner. */
  let currentArticle = null;

  /** Sentences mentioned but not started, oldest first. Started as capacity frees up. */
  const upcoming = [];

  /**
   * The sentences the reader has said are coming, in the order they will be needed.
   *
   * Separate from `upcoming`, which is a work list and is emptied as each sentence starts
   * building. This one is a record of what lies AHEAD, and it survives the work being
   * done — which is what makes it the honest basis for "how many sentences are ready",
   * the number shown on the status panel. Trimmed as sentences are spoken, so it always
   * describes the road in front rather than the road behind.
   */
  const pending = [];

  /** Whatever is making sound right now, so it can be paused or abandoned. */
  let player = null;

  /**
   * Bumped by anything that invalidates work in flight — a stop, a release, or simply a
   * different sentence being asked for. Generation cannot be cancelled once started (the
   * WebAssembly call runs to completion no matter what), so the only honest way to
   * abandon a result is to notice, when it finally arrives, that nobody wants it. Every
   * await below re-checks this.
   */
  let generation = 0;

  /**
   * Bumped only when the QUEUE stops being about the right place — a stop, a release, or a
   * jump to somewhere unannounced. Not by moving to the next sentence.
   *
   * WHY THIS IS SEPARATE FROM `generation`, which it used to share. That counter answers
   * "is this playback still current?", and speaking any sentence bumps it, which is right:
   * audio that arrives for the sentence before last must not suddenly start playing.
   *
   * But work QUEUED ahead is in a different position. Moving from sentence four to
   * sentence five is the most ordinary thing that happens, and it must not abandon the
   * sentences being built for six, seven and eight — they are exactly what was asked for.
   * Sharing one counter meant every sentence abandoned its own lookahead: the queue built
   * a few, then the next `speak` invalidated them, and building never resumed because the
   * bookkeeping that restarts it was skipped as abandoned. The cushion drained to nothing
   * and the voice sat idle waiting to be asked again.
   *
   * That fault predates the cache; deepening the lookahead only made it audible. Found by
   * simulating the owner's measured timings, not by any unit test — the unit tests speak
   * one sentence at a time, which is the one case where the two counters agree.
   */
  let queueGeneration = 0;

  let state = 'idle'; // idle | speaking | paused

  /**
   * A pause asked for while there was nothing yet to pause.
   *
   * This voice has to build a sentence before it can play it, which takes a second or
   * two, and pressing pause during that gap is completely normal — it is exactly when
   * someone realises they want to stop. Without remembering the request, the pause was
   * dropped on the floor: generation finished, playback started anyway, and the button
   * looked broken. So the wish is recorded here and honoured the moment audio exists.
   */
  let pauseWanted = false;

  /** The speed to start new audio at, so a change made mid-generation is not lost. */
  let currentRate = null;

  /**
   * How long recent sentences took to build, so an estimate can be offered rather than a
   * spinner with no end in sight.
   *
   * A rolling average of the last few, not of everything: generation speed changes as the
   * machine warms up and as other tabs compete for it, and an average over the whole
   * article would keep reporting the slow first sentence long after it stopped being true.
   * Kept per character, because a long sentence legitimately takes longer than a short one
   * and an average that ignored length would swing wildly between them.
   */
  const recentRates = [];
  const RATE_SAMPLES = 5;

  function recordDuration(text, ms) {
    const chars = Math.max(1, text.length);
    recentRates.push(ms / chars);
    if (recentRates.length > RATE_SAMPLES) recentRates.shift();
  }

  /** Milliseconds a sentence of this length is likely to take, or null if we cannot say. */
  function estimateFor(text) {
    if (recentRates.length === 0) return null;
    const perChar = recentRates.reduce((sum, rate) => sum + rate, 0) / recentRates.length;
    return Math.round(perChar * Math.max(1, text.length));
  }

  /**
   * Say what the voice is doing.
   *
   * Wrapped in a try/catch because a listener that throws must never interfere with
   * speaking: this is a progress display, and the article matters more than the display.
   */
  function report(activity) {
    if (typeof onActivity !== 'function') return;
    try {
      onActivity(activity);
    } catch {
      // A broken display must not break playback.
    }
  }

  /**
   * How many sentences are built and waiting — the cushion against a slow one.
   *
   * Counted from the CACHE, not from the queue, and that distinction was a real bug: this
   * used to count finished entries in `ready`, but a finished sentence is spliced out of
   * `ready` the instant its audio is cached (otherwise the queue looks permanently full
   * and building stops). So a `done` entry existed for a moment at most, and the panel
   * reported "0 ready" for the entire length of every article — a broken gauge that was
   * read, reasonably, as an empty buffer.
   *
   * What the listener wants to know is how many sentences ahead of the one being spoken
   * are ready to play without waiting. That is a question about what has been built and
   * not yet heard, which is what `pending` holds: the sentences offered by the reader, in
   * the order they will be needed. Counting how many of those are already in the cache
   * answers it honestly, and stops at the first one that is not — a cushion with a hole in
   * it only cushions as far as the hole.
   */
  function bankedCount() {
    let count = 0;
    for (const text of pending) {
      if (!cache.has(text)) break;
      count += 1;
    }
    return count;
  }

  /** True once anything has been spoken, so only the true opening sentence is split. */
  let hasSpokenSinceStop = false;

  function invalidate() {
    generation += 1;
    // The queue is abandoned here and ONLY here — a stop, a release, or a jump somewhere
    // unannounced. Simply moving to the next sentence must not do this: the sentences
    // being built ahead are the ones that were asked for. See `queueGeneration`.
    //
    // Belt and braces, deliberately. Emptying the two lists below is what actually stops
    // the queue; this stamp only makes work ALREADY IN FLIGHT land harmlessly when it
    // finally arrives. Removing it breaks no test today, which was checked rather than
    // assumed — it is kept because a sentence in flight outlives the lists, and something
    // has to tell it that the world moved on. Without it, that decision would rest on the
    // lists happening to be empty, which is a fact about timing rather than a rule.
    queueGeneration += 1;
    // Everything queued describes the article we were reading a moment ago. After a stop
    // or a skip it is about sentences nobody is waiting for any more. Work already
    // running cannot be called back — it is simply ignored when it lands.
    ready.length = 0;
    upcoming.length = 0;
    // The road ahead is no longer the road we were on, so the cushion count must not keep
    // describing it. Refilled by the primes that follow the next speak.
    pending.length = 0;
  }

  function discardPlayer() {
    const current = player;
    player = null;
    if (!current) return;
    current.stop();
    // Stopping makes no sound and fires no event, so say so explicitly — otherwise the
    // sentence being abandoned would never report back and the reader would wait forever.
    if (typeof current.settle === 'function') current.settle();
  }

  /**
   * Get a player ready for audio that has just been built.
   *
   * WHY THIS EXISTED, and why it still earns its keep in a quieter way. Having the audio
   * was never the same as being able to play it: a player had real setup to do — for an
   * audio element, fetching a blob and decoding it — and that work used to start at the
   * moment sound was wanted, inside the silence between two sentences. The buffer was
   * full the whole time; the last step was simply left until too late.
   *
   * It is also why skipping BACKWARDS always sounded instant while the first pass did
   * not: the second time through, the browser already held the decoded audio. That
   * difference is what pointed here rather than at the cache, which had already been made
   * deeper twice with nothing audible to show for it.
   *
   * MOST OF THAT COST IS NOW GONE rather than hidden. The voice hands back raw samples
   * and they are played directly, so there is no blob to fetch and nothing to decode —
   * warming a player is now little more than arranging samples that are already in hand.
   * This is kept because the idea was never wrong: doing the last step when there is time
   * to spare, rather than in the silence before a sentence is due, is still free and
   * still the right shape. It simply has much less to do.
   *
   * ENTIRELY OPTIONAL, and opted INTO rather than out of. A createPlayer marked
   * `warms = true` is built early; every other one is left completely alone and built at
   * play time. The flag is on the factory rather than the player because the only way to
   * ask a player whether it can warm is to build one, and building one speculatively is
   * precisely what must not happen — it would also make "the player that is playing"
   * ambiguous.
   *
   * Failures are ignored for the same reason as ever: this only makes playing sooner,
   * never possible, so a player that refuses to warm is simply played as it always was.
   */
  function warmPlayer(entry) {
    if (entry.player || !entry.audio || createPlayer.warms !== true) return;
    try {
      const prepared = createPlayer(entry.audio);
      entry.player = prepared;
      Promise.resolve(prepared.warm?.()).catch(() => {});
    } catch {
      // A player that cannot even be built is not worth reporting: the sentence is still
      // played the old way, one built at play time, and nothing is lost but the head start.
      entry.player = null;
    }
  }

  /**
   * Let go of every player warmed for a sentence and never played.
   *
   * Warming buys speed by holding a real resource early, so something has to hand it back
   * when the audio it belongs to stops being wanted. Only called when the cache is being
   * emptied for a different article; a warmed player is otherwise kept exactly because
   * the listener may come back to that sentence.
   */
  function discardWarmedPlayers() {
    for (const entry of cache.values()) {
      const warmed = entry.player;
      entry.player = null;
      try {
        warmed?.stop();
      } catch {
        // Already gone, or a player that never had anything to release.
      }
    }
  }

  /**
   * Prepare `text` if nothing is already being prepared.
   *
   * Two generations at once would be actively harmful: they compete for the same single
   * thread, so the sentence that is needed *next* would arrive later than if we had
   * simply waited. One at a time is both simpler and faster.
   */
  function startPreparing(text) {
    // The QUEUE's generation, not playback's: this work outlives the sentence that
    // happened to be playing when it was started, which is the entire point of it.
    const mine = queueGeneration;
    const startedAt = now();

    const promise = Promise.resolve()
      .then(() => generate(text))
      .then(
        (audio) => ({ audio }),
        (error) => ({ error })
      );

    const entry = { text, promise, startedAt, estimateMs: estimateFor(text) };
    ready.push(entry);

    report({
      phase: 'generating',
      text,
      estimateMs: entry.estimateMs,
      banked: bankedCount(),
    });

    promise.then((result) => {
      const took = now() - startedAt;
      if (!result.error) {
        recordDuration(text, took);
        // Kept regardless of whether anyone still wants it. Work already paid for is worth
        // keeping even when the listener has skipped past it — they may well come back,
        // and this is the whole point of the cache.
        cache.set(text, result);
        // Having the audio is not the same as being able to play it instantly. Get the
        // player ready NOW, while there is time to spare, rather than in the silence
        // before this sentence is due. See warmPlayer.
        warmPlayer(result);
      }
      if (mine !== queueGeneration) return;
      report({
        phase: 'generated',
        text,
        tookMs: took,
        error: result.error ? String(result.error?.message ?? result.error) : undefined,
        banked: bankedCount(),
      });
    });

    // Capacity frees up the moment this finishes, so start the next one waiting. This is
    // what keeps building continuous instead of stopping until a sentence is consumed.
    //
    // A finished sentence LEAVES the queue rather than sitting in it. The queue measures
    // work in flight and work waiting to be claimed; once the audio is in the cache it is
    // safe there for the rest of the article, and leaving a copy here as well would let
    // finished entries accumulate until the queue looked permanently full and building
    // stopped altogether. That was a real fault, found by simulating the owner's measured
    // timings rather than by any unit test: the cushion grew to four and then drained to
    // nothing, because `ready` never emptied and so never had room.
    promise.then(() => {
      if (mine !== queueGeneration) return;
      entry.done = true;
      const at = ready.indexOf(entry);
      if (at !== -1 && cache.has(entry.text)) ready.splice(at, 1);
      fillQueue();
    });

    return promise;
  }

  /**
   * Keep the generator busy.
   *
   * Only ONE sentence is built at a time, however many are waiting: they all share a
   * single thread, so building two at once would make the one needed soonest arrive
   * later. Depth comes from queueing, never from working in parallel.
   */
  function fillQueue() {
    if (upcoming.length === 0) return;
    if (ready.some((entry) => !entry.done)) return; // Something is still building.
    if (ready.length >= LOOKAHEAD_SENTENCES) return;
    startPreparing(upcoming.shift());
  }

  /**
   * Get audio for `text`, using the prepared copy when it matches.
   *
   * The identity check is the important part. After a skip the prepared sentence is the
   * wrong one, and waiting for it would mean playing text the listener has already
   * skipped past — the single most likely bug in this file.
   */
  function audioFor(text) {
    // Already built, at any point in this article. This is what makes skipping backwards
    // instant instead of a rebuild, and it is checked first because it is the one answer
    // that needs no waiting at all.
    const kept = cache.get(text);
    if (kept) {
      fillQueue();
      return Promise.resolve(kept);
    }

    // Matched by text alone, deliberately. Preparing sentences in advance is exactly what
    // this file exists to do, so work that turns out to be wanted must survive the
    // ordinary bump that happens when it is finally asked for. It is being asked for by
    // name that makes it current again.
    const found = ready.findIndex((entry) => entry.text === text);
    if (found !== -1) {
      // Anything queued BEFORE this was skipped past, so it is dropped with it.
      const [entry] = ready.splice(0, found + 1).slice(-1);
      fillQueue();
      return entry.promise;
    }

    // Not queued at all: the listener has jumped somewhere unannounced. Everything held
    // is about the old position and is worthless now.
    ready.length = 0;
    upcoming.length = 0;
    return startPreparing(text).then((result) => {
      const index = ready.findIndex((entry) => entry.text === text);
      if (index !== -1) ready.splice(index, 1);
      fillQueue();
      return result;
    });
  }

  /**
   * Play one piece of audio through to its end, or until something interrupts.
   *
   * Note what does NOT happen on its own: silencing a sentence mid-playback reports no
   * natural ending. So if abandoning a sentence only stopped the sound, the promise for
   * that sentence would never settle and the reader would wait for a sentence that had
   * already been thrown away — playback would simply hang. Whoever abandons the audio is
   * therefore responsible for settling it, which is what `settle` below is for.
   */
  function play(entry, mine, playingText = '') {
    return new Promise((resolve) => {
      // The player warmed when this audio was built, if it is still there. Taken rather
      // than borrowed: a player is good for one playing, so the next time this sentence
      // comes round it is warmed again from the audio, which is what the cache holds.
      const warmed = entry.player;
      entry.player = null;
      const current = warmed ?? createPlayer(entry.audio);
      let done = false;

      const finish = (outcome) => {
        if (done) return;
        done = true;
        if (player === current) player = null;
        resolve(outcome);
      };

      // Called by stop() and release() when this audio is discarded before it ends.
      current.settle = () => finish('stopped');

      player = current;

      // NO RATE IS APPLIED HERE, deliberately. The samples were built at the speed that
      // was in force when the voice made them, so they are already correct — and telling
      // the player to play them faster on top of that would speed the sentence up twice
      // and put back the raised pitch that moving speed into the voice removed.

      current.onEnded(() => finish(mine === generation ? 'ended' : 'stopped'));
      current.onError(() => finish(mine === generation ? 'error' : 'stopped'));

      // A pause asked for while this was still being built is honoured now, before a
      // sound is made, rather than being forgotten.
      if (pauseWanted) {
        pauseWanted = false;
        state = 'paused';
        report({ phase: 'paused', text: playingText, banked: bankedCount() });
        return;
      }

      state = 'speaking';
      report({ phase: 'speaking', text: playingText, banked: bankedCount() });
      current.play();
    });
  }

  /**
   * Split a long opening sentence so the first sound arrives sooner.
   *
   * Only ever applied to the first sentence after pressing play, and only inside this
   * file. The caller asked for one sentence and gets one sentence's worth of audio and
   * one result — that two generations happened underneath is nobody else's business,
   * which is exactly what the engine interface is for.
   *
   * @returns {[string] | [string, string]} the chunks to speak, in order
   */
  function splitOpener(text) {
    if (text.length <= LONG_OPENER_CHARACTERS) return [text];

    // A comma is the natural place: it is already a pause, so the join is inaudible.
    const comma = text.indexOf(', ', MIN_OPENING_CHUNK);
    if (comma !== -1 && comma < text.length - MIN_OPENING_CHUNK) {
      return [text.slice(0, comma + 1), text.slice(comma + 2)];
    }

    // No usable comma: fall back to a word boundary near the target length.
    const space = text.lastIndexOf(' ', LONG_OPENER_CHARACTERS);
    if (space > MIN_OPENING_CHUNK) {
      return [text.slice(0, space), text.slice(space + 1)];
    }

    return [text];
  }

  return {
    /**
     * Say which article is being read, so audio kept for a different one can be let go.
     *
     * WHY THIS IS ITS OWN SIGNAL, rather than hanging the cache off stop or release. Both
     * of those fire in the middle of ordinary listening and would throw the audio away at
     * exactly the wrong moments:
     *
     *   - `stop()` is what pressing stop does, and playing the same article again
     *     afterwards is precisely the case that should be instant.
     *   - `release()` fires when the tab is merely hidden. Clearing there would empty the
     *     cache every time the listener switched tab and came back, which would look
     *     exactly like the bug this cache was written to fix.
     *
     * Moving to a different article is the only thing that genuinely makes the audio
     * worthless, so that is what clears it. Called with the same id repeatedly — which is
     * what happens when one article is prepared more than once — it keeps what it has.
     */
    setArticle(articleId) {
      const id = typeof articleId === 'string' && articleId !== '' ? articleId : null;
      if (id === null || id === currentArticle) return;
      currentArticle = id;
      // Every banked sentence may hold a player warmed and waiting, and in the real
      // add-on each of those holds a whole sentence of decoded sound. Dropping the map
      // alone would let go of the only reference to them without ever telling them to
      // stop, which leaks that memory for as long as the tab lives. Nothing here is
      // playing — the warmed player for the sentence in the air was taken out of the
      // cache entry when it started — so stopping them is pure release.
      discardWarmedPlayers();
      cache.clear();
    },

    /**
     * Speak one sentence, resolving with 'ended', 'stopped', or 'error'.
     *
     * Never rejects: one sentence failing to generate must cost that sentence and no
     * more, because an article that continues with a small gap is far better than
     * playback dying silently in the middle of a page.
     */
    async speak(text) {
      const content = typeof text === 'string' ? text.trim() : '';
      if (content === '') return 'ended';

      const mine = ++generation;
      discardPlayer();

      // Everything up to and including this sentence is behind the listener now, so it is
      // no longer part of the cushion ahead. Dropping it here keeps the count honest as
      // the article advances, and does the right thing on a skip in either direction: a
      // jump forward drops what was leapt over, and a jump back finds nothing to drop and
      // simply leaves the list describing the road ahead of where the listener now is.
      const heard = pending.indexOf(content);
      if (heard !== -1) pending.splice(0, heard + 1);

      const chunks = splitFirstSentence && !hasSpokenSinceStop ? splitOpener(content) : [content];
      hasSpokenSinceStop = true;

      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];

        // Whether this sentence was already built decides what the listener sees: a
        // sentence taken from the cushion starts instantly, and one that was not means a
        // visible wait. Asked before audioFor, because that call consumes the entry.
        const alreadyBuilt = ready.some((entry) => entry.text === chunk && entry.done);
        const waiting = audioFor(chunk);

        if (!alreadyBuilt) {
          report({
            phase: 'waiting',
            text: chunk,
            estimateMs: estimateFor(chunk),
            banked: bankedCount(),
          });
        }

        // While this chunk is generating there is nothing useful to do, but once it is
        // playing the rest of the opener can be prepared in the background.
        const result = await waiting;
        if (mine !== generation) return 'stopped';
        if (result.error || !result.audio) return 'error';

        const next = chunks[i + 1];
        const outcome = await (async () => {
          const playing = play(result, mine, chunk);
          if (next !== undefined && mine === generation) {
            upcoming.unshift(next);
            fillQueue();
          }
          return playing;
        })();

        if (outcome !== 'ended') return outcome;
        if (mine !== generation) return 'stopped';
      }

      state = 'idle';
      return 'ended';
    },

    /**
     * A hint that `text` will probably be spoken next.
     *
     * This is the whole point of the file. It never makes a sound, never returns anything
     * worth waiting for, and may be ignored entirely — so a caller that does not know
     * about it loses speed, not correctness.
     */
    prime(text) {
      const content = typeof text === 'string' ? text.trim() : '';
      if (content === '') return;

      // Remembered even when there is nothing to build, because this list answers "what
      // is coming", not "what is left to do". A sentence already in the cache is exactly
      // the case the cushion count most wants to include.
      if (!pending.includes(content)) pending.push(content);

      // Already built earlier in this article — nothing to prepare, and the lookahead is
      // better spent on a sentence that does not exist yet.
      if (cache.has(content)) return;

      // Already built, already building, or already queued: nothing to do. The reader
      // mentions the same sentences repeatedly as it advances, so this is the common case.
      if (ready.some((entry) => entry.text === content)) return;
      if (upcoming.includes(content)) return;
      if (ready.length + upcoming.length >= LOOKAHEAD_SENTENCES) return;

      upcoming.push(content);
      fillQueue();
    },

    /**
     * Change the speed, throwing away everything built at the old one.
     *
     * WHY THIS THROWS WORK AWAY, WHEN IT ONCE DID NOT. Speed used to be applied to the
     * finished sound by replaying it faster, so a sentence built at any speed could be
     * played at any other and nothing prepared was ever wasted. That is no longer true,
     * and the reason is audible: replaying samples faster raises their pitch, which the
     * owner heard as a squeak at the higher settings. Speed is now asked of the voice
     * itself, so it is baked into the samples as they are made.
     *
     * The consequence is unavoidable rather than an oversight: audio built at 1x IS 1x
     * audio, and the only honest way to hear it at 1.5x is to build it again. The cached
     * sentences and the queued ones are therefore dropped, and the next speak rebuilds
     * what it needs. The bank runs eight deep, so this is real work — it is the price of
     * a voice that keeps its pitch, and it was chosen deliberately over a squeak.
     *
     * THE SENTENCE IN THE AIR IS LEFT ALONE. It is already being heard, and stopping it
     * mid-word to rebuild it at a new speed would be far more jarring than letting it
     * finish at the old one. The change is heard from the next sentence on.
     *
     * A rate that is not actually a change costs nothing: the bank is kept.
     */
    setRate(rate) {
      if (typeof rate !== 'number' || !Number.isFinite(rate)) return;
      if (rate === currentRate) return;
      currentRate = rate;

      // Everything held was built at the old speed and is now the wrong audio for every
      // sentence it describes. Dropping the cache is what forces the rebuild.
      cache.clear();

      // Work queued or in flight is also at the old speed. Stamping the queue makes
      // anything already running land harmlessly instead of being cached as if current.
      queueGeneration += 1;
      ready.length = 0;

      // What lies ahead is unchanged — the same sentences, in the same order, simply not
      // built yet. `pending` therefore stays, and re-offering it refills the bank at the
      // new speed. Without this the cushion would stay empty until the reader primed
      // again, which is a gap the listener would hear.
      upcoming.length = 0;
      for (const text of pending) {
        if (upcoming.length >= LOOKAHEAD_SENTENCES) break;
        upcoming.push(text);
      }
      fillQueue();

      // The cushion just went to nothing, and the status panel would otherwise keep
      // claiming a bank that no longer exists. No text: the sentence being spoken has not
      // changed, only what is ready behind it.
      report({ phase: 'generating', banked: bankedCount() });
    },

    /**
     * Hold playback.
     *
     * Works whether or not there is anything playing yet: pressing pause while a sentence
     * is still being built is normal, and it used to be ignored, which made the button
     * look broken for a second or two at a time.
     */
    pause() {
      if (state === 'paused') return;

      if (player) {
        state = 'paused';
        player.pause();
        report({ phase: 'paused', banked: bankedCount() });
        return;
      }

      // Nothing to pause yet. Remember the wish; play() honours it when audio arrives.
      pauseWanted = true;
      state = 'paused';
      report({ phase: 'paused', banked: bankedCount() });
    },

    resume() {
      if (state !== 'paused') return;

      // A pause taken during generation left nothing to resume, so cancelling the wish is
      // the whole job: the audio will start as soon as it is built, as it would have.
      pauseWanted = false;

      if (!player) {
        // Still being built. It will start on its own, and the display should say so
        // rather than claiming to be speaking when there is no sound yet.
        state = 'speaking';
        report({ phase: 'waiting', banked: bankedCount() });
        return;
      }

      state = 'speaking';
      player.play();
      report({ phase: 'speaking', banked: bankedCount() });
    },

    /** Abandon everything, including work already in flight. */
    stop() {
      invalidate();
      discardPlayer();
      state = 'idle';
      hasSpokenSinceStop = false;
      // Otherwise a pause taken before stopping would silently hold the *next* article.
      pauseWanted = false;
      report({ phase: 'idle', banked: 0 });
    },

    /**
     * Give up making sound, but keep the loaded voice.
     *
     * Unlike the browser's shared synthesiser, Piper holds nothing another tab needs, so
     * this only has to stop the audio. The 60MB model deliberately stays loaded: throwing
     * it away to reclaim memory from a tab the listener may return to within seconds
     * would mean paying the whole load cost again.
     */
    release() {
      const held = state === 'speaking' || state === 'paused';
      invalidate();
      discardPlayer();
      state = 'idle';
      hasSpokenSinceStop = false;
      // Same reason as stop(): a remembered pause must not outlive what it applied to.
      pauseWanted = false;
      return held;
    },

    isSpeaking() {
      return state === 'speaking';
    },

    isPaused() {
      return state === 'paused';
    },
  };
}

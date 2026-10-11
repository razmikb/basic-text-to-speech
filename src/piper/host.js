/**
 * The voice's own page — where the neural voice actually runs.
 *
 * This is the only place in the add-on that touches the Piper library, WebAssembly, or the
 * speakers. Article pages talk to it over a connection and never see any of that,
 * which is what keeps everything Piper-specific out of the reader and the page.
 *
 * Three jobs:
 *
 *   1. Load the voice once, and keep it loaded. The model is 60MB and takes a while to
 *      arrive the first time; loading it per tab, or per article, would be wasteful.
 *   2. Run the pipeline — generate one sentence while the previous one plays. That logic
 *      lives in pipeline.js and is fully tested; this file only supplies the two slow
 *      real-world pieces it needs, generating audio and playing it.
 *   3. Answer one article page at a time. A second page taking over cancels the first,
 *      matching the "one tab reads at a time" rule the background script already enforces.
 */

import { createPipeline } from './pipeline.js';
import { createPlayer } from './player.js';
import { createVoiceClient } from './worker-client.js';
import {
  canRemoveVoice,
  deleteVoiceFiles,
  downloadVoiceFiles,
  voiceFileNames,
  voiceFilesAreWhole,
} from '../lib/voice-store.js';
// TEMPORARY — diagnosis. Remove with the trace calls below.
import {
  clearTrace,
  configureTrace,
  formatTrace,
  startHeartbeat,
  trace,
  traced,
} from '../lib/trace.js';

const api = globalThis.browser ?? globalThis.chrome;

/*
 * TEMPORARY — diagnosis. Every event here is shipped to whichever article page is
 * connected, so both sides end up in ONE ordered log on a clock they share. Logging each
 * page separately cannot answer the only question that matters — what was this thread
 * doing while that button was waiting — because each page's own clock starts at its own
 * load. Date.now() is the clock they agree on.
 *
 * The heartbeat is the honest witness: a 100ms timer that fires late proves the thread was
 * held, from outside the work, which is the one vantage point that cannot be fooled.
 */
configureTrace({
  as: 'voice',
  onEntry: (entry) => {
    try {
      activeConnection?.port?.postMessage({ type: 'trace', entry });
    } catch {
      // No page attached, or it has gone. The event is still kept on this side.
    }
  },
});
startHeartbeat({ everyMs: 100, lateAfterMs: 60 });

/*
 * TEMPORARY — diagnosis. The same trace, reachable from THIS console.
 *
 * This page has its own inspector (about:debugging -> Inspect), which is a different
 * console from the article page's, and it is a reasonable place to go looking for an
 * add-on's logs. What appears here is only this side's half of the story — the article
 * page holds the combined log, because that is where both halves are collected — but a
 * stall or a long generate block shows up here, and that is most of what this side is
 * for. The message says where the full version lives so neither console is a dead end.
 */
globalThis.ftts = {
  text: () => formatTrace(),
  show: () => console.info(formatTrace()),
  clear: () => {
    clearTrace();
    return 'voice-page trace cleared';
  },
};

console.info(
  [
    '%cBasic Text-to-Speech voice page — this is the VOICE side of the trace.',
    '',
    '  ftts.show()   print what this page recorded (stalls, generate blocks)',
    '',
    'The COMBINED trace, with both pages on one clock, lives in the ARTICLE page console:',
    '  open the article tab, press F12, then run  copy(ftts.text())',
  ].join(String.fromCharCode(10)),
  'font-weight:bold'
);

/** The library, imported once on first use — it drags in ~30MB of WebAssembly. */
let library = null;
let loadingLibrary = null;

/** Which voice is loaded, so a change of voice reloads rather than speaks in the old one. */
let loadedVoiceId = null;

/**
 * The voice, which now lives on its own thread.
 *
 * WHAT CHANGED AND WHY. This used to be a `createVoiceHolder` right here, holding the
 * 60MB model on the page's own thread. Building a sentence is synchronous WebAssembly, so
 * for as long as it ran here, this page could not answer anything while it worked —
 * measured at twenty stalls and fifty blocked seconds across two traces, including a press
 * of play that went unanswered for 5.2 seconds.
 *
 * The holder moved into the worker WHOLE, and that is the important part: there is no
 * holder on this side any more. Keeping one here as well would parse the model twice and
 * spend 60MB to no purpose.
 *
 * What is left on this thread is the pipeline, the cache and the audio — all of it cheap,
 * none of it blocking — so every button is now answered at once.
 */
const voice = createVoiceClient();

/**
 * Where the vendored library keeps its files, handed to the worker with each request.
 *
 * The worker cannot import that library itself without dragging its download machinery
 * onto the thread we are keeping clear, and these are only three strings. This page loads
 * the library anyway, to download the voice, so it is the natural place to read them.
 */
async function voicePaths() {
  const tts = await loadLibrary();
  return { pathMap: tts.PATH_MAP, onnxBase: tts.ONNX_BASE, phonemizerBase: tts.WASM_BASE };
}

/** The page currently allowed to make sound. */
let activeConnection = null;

function log(...args) {
  console.info('Basic Text-to-Speech (voice):', ...args);
}

async function loadLibrary() {
  if (library) return library;
  if (!loadingLibrary) {
    loadingLibrary = import('../vendor/piper/vits-web.js').then((module) => {
      library = module;
      return module;
    });
  }
  return loadingLibrary;
}

/**
 * Make sure the chosen voice is on this machine, downloading it the first time.
 *
 * The download is ~60MB and takes tens of seconds on a first run. Progress is reported
 * back to the article page so the toolbar button can show that something is happening —
 * silence that looks identical to a broken button is the thing worth avoiding.
 */
async function ensureVoice(voiceId, onProgress) {
  const tts = await loadLibrary();

  const getDirectory = () => navigator.storage.getDirectory();
  if (await voiceFilesAreWhole(voiceId, tts.PATH_MAP, { getDirectory })) {
    loadedVoiceId = voiceId;
    return;
  }

  log(`downloading the voice "${voiceId}" — about 60MB, once.`);
  onProgress?.({ phase: 'downloading', percent: 0 });

  // Our own download, not the library's: see downloadVoiceFiles for why.
  let lastReported = -1;
  const onDownloadProgress = (progress) => {
    if (!progress || !progress.total) return;
    const percent = Math.floor((progress.loaded * 100) / progress.total);
    // Only report every 5%, or the messages cost more than the download.
    if (percent >= lastReported + 5) {
      lastReported = percent;
      onProgress?.({ phase: 'downloading', percent });
    }
  };
  await downloadVoiceFiles({
    voiceId,
    pathMap: tts.PATH_MAP,
    base: tts.HF_BASE,
    fetch: (url) => fetch(url),
    getDirectory,
    onProgress: onDownloadProgress,
  });

  loadedVoiceId = voiceId;
  onProgress?.({ phase: 'ready', percent: 100 });
  log('voice downloaded and stored on this machine.');
}

/**
 * One audio context for the whole page, made on first use.
 *
 * Made lazily rather than at load, because a context created before anyone has asked for
 * sound starts life suspended by the browser's autoplay rules and is one more thing to
 * remember to resume. The first sentence is always preceded by a real request to play.
 */
let audioContext = null;

function context() {
  if (!audioContext) {
    audioContext = new AudioContext();
    // DIAGNOSIS. The context can change state without anyone asking it to — the browser
    // suspends it when it decides this page is not worth running. Knowing WHEN that
    // happens is the difference between a silence we caused and one that was done to us.
    audioContext.addEventListener('statechange', () => {
      trace('audio:statechange', {
        state: audioContext.state,
        pageHidden: document.visibilityState === 'hidden',
      });
    });
    trace('audio:created', { state: audioContext.state });
  }
  return audioContext;
}

/**
 * Waking the sound output before the first sentence, not with it.
 *
 * After a few seconds of quiet the system puts the sound output to sleep, and Bluetooth
 * headphones take most of a second to wake. The first sentence used to be what woke them,
 * so its opening words were swallowed or faded in — the title, on the owner's Sony
 * headset — while "back" replayed it in full because by then they were awake.
 *
 * So pressing play wakes them: silence starts playing the moment the voice is asked to
 * get ready, and runs while it loads and builds the first sentence. That work usually
 * covers the whole wake-up; the first sentence waits out whatever is left of it, and the
 * silence stops once real sound has taken over. Only the first sentence after a press can
 * wait, and never more than WAKE_SECONDS after it.
 */
const WAKE_SECONDS = 0.8;

/**
 * The silence stops by itself after this long even if no sentence ever plays — a voice
 * that fails to load must not leave the headphones held awake, or the screen, which stays
 * on while sound is playing.
 */
const WAKE_LIMIT_SECONDS = 20;

let wakeSource = null;
/** The context clock when the wake began, or null when no wake is waiting to be used. */
let wokeAt = null;

function wakeAudio() {
  try {
    const ctx = context();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    if (wakeSource) return;
    wakeSource = ctx.createBufferSource();
    wakeSource.buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    wakeSource.loop = true;
    wakeSource.connect(ctx.destination);
    wakeSource.start();
    wakeSource.stop(ctx.currentTime + WAKE_LIMIT_SECONDS);
    wokeAt = ctx.currentTime;
    trace('audio:wake', { state: ctx.state });
  } catch {
    // A sleepy first word is a shame, not a failure; the reading goes ahead regardless.
  }
}

/** The seconds a sentence starting now must still wait, used up by the one that asks. */
function leadIn() {
  if (wokeAt === null) return 0;
  const ctx = context();
  const wait = Math.max(0, WAKE_SECONDS - (ctx.currentTime - wokeAt));
  wokeAt = null;
  quietWake(ctx.currentTime + wait + 0.1);
  trace('audio:lead-in', { wait });
  return wait;
}

function quietWake(when) {
  const stopping = wakeSource;
  wakeSource = null;
  wokeAt = null;
  try {
    stopping?.stop(when);
  } catch {
    // Already stopped.
  }
}

// DIAGNOSIS. This page is hidden by design, but "hidden" and "throttled by the browser"
// are different things, and only the second one stops sound. Logged from the voice page
// so the article's trace shows both sides on one clock.
document.addEventListener('visibilitychange', () => {
  trace('voicepage:visibility', {
    visibility: document.visibilityState,
    audio: audioContext ? audioContext.state : 'none',
  });
});

/**
 * The createPlayer the pipeline is given.
 *
 * `warms` stays true even though warming is now free. The flag means "build this as soon
 * as the sentence is banked", and that is still worth doing: it turns the samples into an
 * AudioBuffer ahead of time rather than in the silence before the sentence is due. The
 * expensive half of warming is what disappeared, not the idea.
 */
function makeWarmingFactory() {
  const factory = (audio) => {
    // The browser pieces the player needs, handed over here so the player itself can be
    // tested without either of them.
    //
    // NO RATE IS SET, and that is the point. Speed is now baked into the samples as the
    // voice builds them, so the audio arriving here is ALREADY at the right speed and
    // replaying it faster would speed it up twice — and put back the raised pitch this
    // change exists to remove.
    return createPlayer(audio, { context, trace, leadIn });
  };
  factory.warms = true;
  return factory;
}

/**
 * Build a pipeline bound to one voice.
 *
 * Rate is applied to the audio rather than the model: Piper speaks at exactly one pace,
 * so speeding up means playing the finished sound faster. It stays convincing to about
 * 1.3x and sounds increasingly odd beyond that.
 */
function buildPipeline(voiceId, getRate, splitFirstSentence, onActivity) {
  return createPipeline({
    splitFirstSentence,
    onActivity,
    generate: async (text) => {
      const speaker = await voice.get(voiceId, await voicePaths());

      /*
       * Let anything already waiting be dealt with before the work starts.
       *
       * ON BORROWED TIME, and deliberately so. This existed because building a sentence
       * blocked this page's one thread — the voice was WebAssembly with no worker behind
       * it, so a pause pressed mid-sentence sat in the queue behind the very work it
       * wanted to interrupt. Yielding first meant it was acted on before the next block
       * rather than after it.
       *
       * The worker removes that premise entirely: the inference no longer runs on this
       * thread, so there is nothing here to queue behind. This should therefore be
       * deleted — but not in the same breath as the change that made it pointless.
       * Removing it now would mean the listening session was judging two changes at once,
       * and if anything sounded wrong there would be two suspects. It costs one turn of
       * the event loop per sentence, which is nothing.
       *
       * DELETE THIS once the trace confirms the worker: no THREAD STALLED on this page
       * during ordinary playback.
       */
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));

      // TEMPORARY — diagnosis. This used to be the prime suspect, and it measured time
      // this thread answered nothing. It now measures a WAIT for another thread, which is
      // the whole point: the same seconds pass, but this page is free throughout them.
      // The honest witness is the heartbeat, not this — a stall here would mean the work
      // did not actually leave.
      // The speed is asked for HERE, as the sentence is built, because this voice applies
      // speed by speaking faster rather than by replaying its sound faster. Read at build
      // time rather than captured, so a sentence built after a speed change gets the new
      // speed without anyone having to remember to pass it along.
      return traced(
        'generate',
        { chars: text.length, rate: getRate(), text: text.slice(0, 60) },
        () => speaker.generate(text, { rate: getRate() })
      );
    },
    createPlayer: makeWarmingFactory(),
  });
}

/**
 * Serve one article page.
 *
 * Every message maps one-to-one onto the engine contract, which is the sign the split is
 * in the right place: this end runs the machinery, the other end is a remote control.
 */
function serve(port) {
  // Only one page may speak at a time. Whoever connects most recently wins, matching the
  // referee in the background script.
  if (activeConnection && activeConnection !== port) {
    activeConnection.pipeline?.stop();
  }

  let pipeline = null;
  let rate = 1;
  let voiceId = null;
  let splitFirstSentence = false;
  /**
   * Which article is being read, remembered rather than only passed through.
   *
   * The pipeline is told this so it can let go of audio built for a page the listener has
   * left. It used to be enough to hand it over inside `prepare`, because that was the only
   * place a pipeline was ever built. Changing voice builds a second one part-way through
   * an article, and a new pipeline that was never told which article it belongs to would
   * throw its audio away the first time it was told — so the id is kept here.
   */
  let articleId = null;

  const connection = {
    port,
    get pipeline() {
      return pipeline;
    },
  };
  activeConnection = connection;

  const reply = (message) => {
    try {
      port.postMessage(message);
    } catch {
      // The page has gone. Nothing to tell it, and disconnect will clean up.
    }
  };

  /**
   * What the voice is doing, sent back unprompted.
   *
   * It carries no id because it answers no request — it simply says what is happening so
   * the bar can show it. Named rather than written inline because a voice change builds a
   * second pipeline, and both must report to the same place: a pipeline built with its own
   * copy of this would be one silent bar away from looking like a stall.
   */
  const onPipelineActivity = (activity) => {
    // TEMPORARY — diagnosis. What the pipeline believes is happening, so it can be laid
    // against what the thread was actually doing at that moment.
    trace(`pipeline:${activity.phase}`, {
      banked: activity.banked,
      text: typeof activity.text === 'string' ? activity.text.slice(0, 40) : undefined,
    });
    reply({ type: 'activity', ...activity });
  };

  port.onMessage.addListener(async (message) => {
    if (!message || typeof message.type !== 'string') return;

    /*
     * TEMPORARY — diagnosis, and the single most important measurement here.
     *
     * `sentAt` is stamped by the article page the instant the button was pressed. The
     * difference between that and now is how long this message spent WAITING — not how
     * long the work takes, but how long it sat undelivered because this thread was busy.
     * A pause that shows a large wait here was queued behind a block, which is the theory.
     * A pause that arrives in 1ms and still feels slow means the delay is after this
     * point, and the investigation moves elsewhere. Last session that distinction killed
     * a diagnosis that everyone, including me, believed.
     */
    if (typeof message.sentAt === 'number') {
      trace(`msg:${message.type}`, { waitedMs: Date.now() - message.sentAt });
    } else {
      trace(`msg:${message.type}`);
    }

    /*
     * Stopping the sound happens before anything else, and without an await in front of it.
     *
     * These three are the commands a person is waiting on with their finger still on the
     * button, and they are all instant work: silencing a playing sentence takes no time at
     * all. Everything else here may await — 'speak' in particular sits awaiting a whole
     * sentence — and an async listener that awaits anything gives up its turn, so a pause
     * arriving behind other traffic used to wait for that traffic to finish before it was
     * even looked at. Hence the early exit rather than a case in the switch below: the
     * ordering is the fix, not the code.
     */
    if (message.type === 'pause') {
      pipeline?.pause();
      // Acknowledge immediately, so the article page can measure the true round trip
      // rather than anyone reasoning about how fast it ought to be.
      reply({ type: 'paused-at', askedAt: message.askedAt });
      return;
    }
    if (message.type === 'stop') {
      pipeline?.stop();
      quietWake();
      return;
    }
    if (message.type === 'resume') {
      pipeline?.resume();
      return;
    }

    try {
      switch (message.type) {
        case 'speak': {
          if (!pipeline) return reply({ type: 'outcome', id: message.id, outcome: 'error' });
          // The reader passes the current speed with every sentence, so honour it here as
          // well as on an explicit change. Without this the voice kept whatever speed it
          // was prepared with and a changed setting never took effect at all.
          if (typeof message.rate === 'number' && Number.isFinite(message.rate)) {
            rate = message.rate;
            pipeline.setRate?.(rate);
          }
          const outcome = await pipeline.speak(message.text);
          return reply({ type: 'outcome', id: message.id, outcome });
        }

        case 'prime':
          pipeline?.prime(message.text);
          return undefined;

        /*
         * Change the voice of an article already under way.
         *
         * THE OPPOSITE OF THE RATE CASE BELOW in what it costs, and worth stating plainly
         * because the two look alike from the outside. A rate change is free here — the
         * pipeline reads it through a getter when it builds each sentence. A VOICE change
         * invalidates everything: every sentence banked ahead was built by a voice that is
         * about to be let go, so the pipeline is rebuilt around the new one and the bank
         * goes with it.
         *
         * The new voice may not be on this machine at all, so this awaits a download the
         * same way `prepare` does, reporting progress to the page so a 60MB wait is
         * visible rather than looking like a voice that has stopped answering.
         *
         * The sentence in the air is left alone. It finishes in the old voice, then the
         * reader asks for the next one and gets the new one.
         */
        case 'voice': {
          const nextVoiceId = message.voiceId;
          if (typeof nextVoiceId !== 'string' || nextVoiceId === '') return undefined;
          if (nextVoiceId === voiceId) return undefined;
          voiceId = nextVoiceId;

          await ensureVoice(voiceId, (progress) => reply({ type: 'progress', ...progress }));
          await voice.get(voiceId, await voicePaths());

          // Everything banked ahead was built by the old voice, so it is let go with the
          // pipeline that built it rather than played in the wrong voice.
          const previous = pipeline;
          pipeline = buildPipeline(voiceId, () => rate, splitFirstSentence, onPipelineActivity);
          previous?.stop();
          pipeline.setArticle?.(articleId);

          reply({ type: 'voice-changed', voiceId });
          return undefined;
        }

        // Change the speaking speed of an article already under way.
        //
        // Nothing built in advance has to be thrown away, and that is not luck: this voice
        // applies speed when the audio is *played*, not when it is generated (see
        // playbackRate in wrapAudio), so sentences already prepared simply play at the new
        // speed. The pipeline reads the rate through a getter for exactly this reason.
        case 'rate':
          if (typeof message.rate === 'number' && Number.isFinite(message.rate)) {
            rate = message.rate;
            pipeline?.setRate?.(rate);
          }
          return undefined;

        case 'release':
          return reply({
            type: 'released',
            id: message.id,
            held: Boolean(pipeline?.release()),
          });

        case 'prepare': {
          // Before anything slow, so the headphones wake while the voice loads.
          wakeAudio();
          // Loading the voice, and downloading it the very first time.
          rate = typeof message.rate === 'number' ? message.rate : 1;
          voiceId = message.voiceId;
          splitFirstSentence = Boolean(message.splitFirstSentence);
          await ensureVoice(voiceId, (progress) => reply({ type: 'progress', ...progress }));
          // Load the voice now rather than on the first sentence. It is the same work
          // either way, but done here it happens while the reader is still working out
          // what the article says, instead of adding itself to the wait before the first
          // word is heard.
          await voice.get(voiceId, await voicePaths());
          if (!pipeline || loadedVoiceId !== voiceId) {
            pipeline = buildPipeline(voiceId, () => rate, splitFirstSentence, onPipelineActivity);
          }
          // Tell the pipeline which article this is, so audio kept for a different one is
          // let go. Deliberately after the pipeline exists, and deliberately every time
          // rather than only on a change: the pipeline decides whether the id is new, and
          // the same id repeated must keep what it holds.
          articleId = message.articleId;
          pipeline?.setArticle?.(articleId);
          return reply({ type: 'ready', id: message.id });
        }

        default:
          return undefined;
      }
    } catch (error) {
      log('failed:', error?.message ?? error);
      return reply({ type: 'failed', id: message.id, message: String(error?.message ?? error) });
    }
  });

  port.onDisconnect.addListener(() => {
    // The article page is gone — closed, navigated away, or crashed. Stop immediately
    // rather than talking to an empty room.
    pipeline?.stop();
    if (activeConnection === connection) activeConnection = null;
  });
}

/**
 * Which voices are already on this machine.
 *
 * Asked by the settings page, which needs to tell someone whether picking a voice costs a
 * download or is instant. It is a plain runtime message rather than a connection because
 * it is one question with one answer and no article behind it — the settings page is not a
 * reader and must not hold the voice.
 *
 * Deliberately reports a failure as an empty list rather than an error. If we cannot find
 * out what is stored, the honest thing to show is "these may need downloading", which is
 * what an empty list produces — never a settings page that refuses to open.
 */
async function storedVoices() {
  try {
    const tts = await loadLibrary();
    const stored = await tts.stored();
    return Array.isArray(stored) ? stored : [];
  } catch (error) {
    log('could not list the stored voices:', error?.message ?? error);
    return [];
  }
}

/**
 * Fetch a voice onto this machine without speaking a word of it.
 *
 * FOR THE SETTINGS PAGE, and deliberately NOT over the `ftts:piper` connection a reader
 * uses. That connection means "I am the page that speaks now", and a second one stops
 * whatever the first was playing (see `serve`). The settings page downloading a voice must
 * not silence an article — the entire point of choosing a voice mid-article is that the
 * article keeps playing — so it asks here instead, where nothing is taken over.
 *
 * `loadedVoiceId` is deliberately left alone: the voice is now on disk, but the voice
 * actually LOADED is still whatever the reader is speaking with. Setting it here would
 * make the reader believe it had already switched and skip the rebuild it needs.
 */
async function fetchVoice(voiceId, onProgress) {
  const before = loadedVoiceId;
  try {
    await ensureVoice(voiceId, onProgress);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  } finally {
    loadedVoiceId = before;
  }
}

/**
 * Delete a voice from this machine.
 *
 * The library removes both files a voice is made of — the model and the small `.json`
 * beside it — so there is nothing left to tidy up here.
 *
 * REFUSED FOR THE VOICE THAT IS LOADED, and this is the check that matters. The settings
 * page already hides the option for the voice in use, but it decides that from a SETTING,
 * while this side knows what is actually loaded and speaking. A voice deleted out from
 * under the reader would leave it holding a model whose files are gone — silence with no
 * obvious cause, which is the exact failure mode this project has spent sessions on.
 */
async function removeVoice(voiceId) {
  // The rule itself lives in lib/voice-store.js so it can be tested; this page cannot be
  // loaded in a test process, and "may this be deleted" is too costly to get wrong.
  const allowed = canRemoveVoice(voiceId, { loadedVoiceId });
  if (!allowed.ok) return allowed;

  try {
    const tts = await loadLibrary();

    /*
     * Deleted by us, not by the library. See deleteVoiceFiles: the library's own `remove`
     * calls a method Firefox does not have, swallows the resulting error, and resolves as
     * though it had worked — which is exactly how a "removed" voice stayed on disk.
     */
    const files = voiceFileNames(voiceId, tts.PATH_MAP);
    if (files.length === 0) return { ok: false, error: 'that voice is not one we know' };

    await deleteVoiceFiles(files, { getDirectory: () => navigator.storage.getDirectory() });

    /*
     * CHECK THAT IT ACTUALLY WENT, rather than believing our own delete.
     *
     * The delete above now reports its failures, which the library's did not — but this
     * asks the independent question anyway, and deliberately: it reads the truth back
     * from the very list the settings page believes, so the two cannot disagree the way
     * they did when a "removed" voice kept showing as on this machine.
     *
     * This is the honest witness. Whatever any layer above reported, if the voice is
     * still listed it is still here.
     */
    const left = await tts.stored();
    if (Array.isArray(left) && left.includes(voiceId)) {
      log(`the voice "${voiceId}" is still on disk after removing it.`);
      return { ok: false, error: 'the browser would not delete it' };
    }

    /*
     * Let go of the model in memory too, if this was the one held.
     *
     * Deleting the files does not unload a model already parsed into the worker, and one
     * still held would go on speaking a voice the listener has just deleted — which is
     * both wrong and, since nothing on disk backs it any more, unrepeatable after a
     * reload. Only reached when the voice is not the one in use, so nothing is cut off.
     */
    if (loadedVoiceId === voiceId) loadedVoiceId = null;

    log(`removed the voice "${voiceId}".`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

api.runtime.onMessage.addListener((message) => {
  if (message?.type === 'ftts:stored-voices') {
    return storedVoices().then((voices) => ({ ok: true, voices }));
  }

  // Named differently from what the settings page sends, for the same reason as the
  // fetch below: this script and the background share a bus, and a name relayed under
  // itself would loop.
  if (message?.type === 'ftts:do-remove-voice') {
    return removeVoice(message.voiceId);
  }

  // Named differently from what the settings page sends, on purpose: the background
  // script relays it under this name so that its own listener cannot hear its own
  // broadcast and relay it again. See the note there.
  if (message?.type === 'ftts:do-fetch-voice') {
    // Progress is broadcast rather than replied, because a download takes tens of seconds
    // and a single reply can only arrive once — at the end, which is exactly when a
    // progress report is no longer worth anything.
    return fetchVoice(message.voiceId, (progress) => {
      try {
        const sent = api.runtime.sendMessage({
          type: 'ftts:voice-progress',
          voiceId: message.voiceId,
          ...progress,
        });
        // A broadcast with nobody listening REJECTS rather than throwing, so the catch
        // below would never see it and the browser would report an unhandled rejection
        // for every 5% of a download. Closing the settings page mid-download is the
        // ordinary way that happens, not an edge case.
        if (sent && typeof sent.catch === 'function') sent.catch(() => {});
      } catch {
        // Nobody listening; the download carries on regardless.
      }
    });
  }

  return undefined;
});

api.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ftts:piper') return;
  serve(port);
});

/**
 * Announce that this page is listening.
 *
 * This has to come after the listener above is registered, and that order is the whole
 * point: a connection made before then is not queued, it is refused immediately. Whoever
 * is waiting for this message is waiting for exactly that guarantee.
 */
try {
  api.runtime.sendMessage({ type: 'ftts:voice-page-ready' });
} catch {
  // Nothing is waiting — the page was opened directly rather than by the add-on.
}

log('voice page ready.');

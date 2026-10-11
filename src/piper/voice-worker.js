/**
 * The voice's own thread.
 *
 * WHY THIS FILE EXISTS. Building a sentence is synchronous WebAssembly: once the maths
 * engine starts, the thread it runs on does nothing else until it finishes. For as long
 * as that was the voice page's only thread, it was also the thread that had to notice the
 * pause button, answer messages from the article, and let the browser decode audio — so
 * none of those happened while a sentence was being built.
 *
 * That was measured rather than suspected. Two traces agreed: twenty stalls, fifty
 * seconds of blocked thread, and one press of play that waited 5.2 seconds for an answer.
 *
 * A worker is a second thread. The blocking work is exactly the same and takes exactly as
 * long, but it now happens somewhere nobody is waiting, so the page answers every button
 * at once. Nothing here is faster; things merely stop queueing behind each other.
 *
 * WHAT LIVES HERE, AND WHAT DELIBERATELY DOES NOT. This file owns the voice and nothing
 * else: text in, samples out. The pipeline, the cache, the audio and the article all stay
 * on the page. That split is what keeps this file small enough to reason about — it has
 * no idea what a sentence is for, and it holds no state that outlives a voice.
 *
 * THE DOWNLOAD IS NOT HERE, on purpose. Fetching the ~60MB voice the first time is
 * network work, not thread work, so it never blocked anything and moving it would gain
 * nothing while breaking the progress the page reports. The page downloads; this reads
 * what the page stored. Both sides see the same private file area.
 */

import { createSpeaker, createVoiceHolder } from './speech.js';

/**
 * The one voice, prepared once and kept warm.
 *
 * Moved here WHOLE rather than copied. If the page kept a holder of its own as well, the
 * 60MB model would be parsed twice — once on each thread — which is 60MB spent for
 * nothing. There is exactly one of these in the add-on now, and it is this one.
 *
 * The paths it needs come from the page with each request rather than from importing the
 * vendored library here. The page loads that library anyway for the download, its path
 * constants are three plain strings, and importing it on this side as well would drag its
 * whole download machinery onto the thread we are trying to keep clear.
 */
let voice = null;
let paths = null;

function voiceHolder() {
  if (!voice) {
    voice = createVoiceHolder({
      prepare: (voiceId) =>
        createSpeaker({
          voiceId,
          paths: paths.pathMap,
          wasmPaths: paths.onnxBase,
          phonemizerPaths: paths.phonemizerBase,
        }),
    });
  }
  return voice;
}

/**
 * Answer one request.
 *
 * Every reply carries the id it answers, because a worker's messages arrive as a single
 * unordered stream: the only thing tying an answer to its question is that id. Replies
 * are shaped `{ id, ok, ... }` so the page can settle the right promise either way,
 * rather than a failure going unnoticed and a sentence hanging forever.
 */
self.addEventListener('message', async (event) => {
  const message = event.data;
  if (!message || typeof message.type !== 'string') return;
  const { id, type } = message;

  try {
    switch (type) {
      case 'prepare': {
        // Path constants first: the holder cannot prepare anything without them, and they
        // arrive with this request rather than being remembered from an older one.
        paths = message.paths;
        await voiceHolder().get(message.voiceId);
        return self.postMessage({ id, ok: true });
      }

      case 'generate': {
        const speaker = await voiceHolder().get(message.voiceId);
        // The speed travels WITH the text, because this voice bakes speed in as it
        // builds: it is asked to speak faster rather than having its sound replayed
        // faster, which is what keeps the pitch from rising.
        const { samples, sampleRate } = await speaker.generate(message.text, {
          rate: message.rate,
        });

        /*
         * Hand the samples over rather than copying them.
         *
         * postMessage clones by default, so without the transfer list below every
         * sentence's audio would be duplicated across the thread boundary — paying in
         * memory and in copy time for exactly the work this change exists to save.
         *
         * Listing the buffer moves it instead: this side loses access the instant it is
         * sent, which is precisely what makes it free. Losing access is safe here because
         * nothing on this thread reads the samples again — they were made for the page.
         */
        return self.postMessage({ id, ok: true, samples, sampleRate }, [samples.buffer]);
      }

      case 'release': {
        await voice?.release();
        voice = null;
        return self.postMessage({ id, ok: true });
      }

      default:
        return undefined;
    }
  } catch (error) {
    // The message, not the error object: an Error does not survive being cloned intact,
    // and a sentence that fails silently is worse than one that fails loudly.
    return self.postMessage({ id, ok: false, message: String(error?.message ?? error) });
  }
});

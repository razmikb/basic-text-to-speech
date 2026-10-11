/**
 * The page's end of the voice worker.
 *
 * This exists to make the second thread invisible to everything else. The pipeline asks
 * for a speaker and calls `generate` on it, exactly as it did when the voice ran on this
 * thread; that the work now happens elsewhere is this file's secret. Nothing above it had
 * to change.
 *
 * WHAT IT ACTUALLY DOES is bookkeeping. A worker is not a function call: you post a
 * message and, some time later, an unrelated-looking message arrives. Turning that back
 * into something awaitable means giving every request an id, remembering who is waiting
 * for it, and settling that promise when the matching reply turns up. That is the whole
 * job, and it is why this file is mostly a map.
 *
 * WHY REQUESTS ARE NOT QUEUED HERE. Only one sentence is ever built at a time — the
 * pipeline guarantees it — so there is no ordering to enforce on this side. If that ever
 * changes, the worker builds them in the order they arrive and the ids keep the answers
 * straight regardless.
 */

/**
 * Start the worker and return the small surface the pipeline expects.
 *
 * @param {object} [options]
 * @param {() => Worker} [options.spawn] how to make the worker. Injectable for the same
 *   reason the engines in speech.js are: a real Worker cannot run in a test, and the
 *   protocol — which is the part with the bugs in it — is worth testing without one.
 */
export function createVoiceClient({ spawn = defaultSpawn } = {}) {
  const worker = spawn();

  /** Who is waiting for what: `id -> { resolve, reject }`. */
  const waiting = new Map();
  let nextId = 1;

  worker.addEventListener('message', (event) => {
    const reply = event.data;
    if (!reply || typeof reply.id !== 'number') return;

    const pending = waiting.get(reply.id);
    // No one waiting means the request was already abandoned — a stop, or a reload. The
    // reply is simply dropped; there is nothing left to tell.
    if (!pending) return;
    waiting.delete(reply.id);

    if (reply.ok) pending.resolve(reply);
    else pending.reject(new Error(reply.message ?? 'the voice failed'));
  });

  /*
   * A worker that dies takes every unanswered request with it.
   *
   * Without this, a crash in the voice would leave the pipeline awaiting sentences that
   * can never arrive, and playback would hang with no error anywhere — the exact failure
   * shape that cost this project a whole session to diagnose once already. Failing them
   * loudly means the pipeline drops those sentences and carries on.
   */
  worker.addEventListener('error', (event) => {
    const reason = new Error(event?.message ?? 'the voice thread stopped');
    for (const pending of waiting.values()) pending.reject(reason);
    waiting.clear();
  });

  function request(message, transfer) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      try {
        worker.postMessage({ ...message, id }, transfer ?? []);
      } catch (error) {
        waiting.delete(id);
        reject(error);
      }
    });
  }

  /** Which voice the worker has been told to prepare, so it is not asked twice. */
  let preparedVoiceId = null;

  return {
    /**
     * Make sure the worker holds this voice, and hand back something that can speak.
     *
     * Deliberately the same shape `createVoiceHolder` had on this side — `get(voiceId)`
     * returning an object with `voiceId` and `generate` — because that is what the
     * pipeline already calls. The holder itself now lives in the worker, which is where
     * the 60MB model it guards actually is.
     */
    async get(voiceId, paths) {
      if (preparedVoiceId !== voiceId) {
        await request({ type: 'prepare', voiceId, paths });
        // Recorded only after it succeeded. A failed prepare must be retried, not
        // remembered as done, or the voice would be silently missing for the article.
        preparedVoiceId = voiceId;
      }

      return {
        voiceId,
        generate: async (text, { rate = 1 } = {}) => {
          const reply = await request({ type: 'generate', voiceId, text, rate });
          // Samples and their rate travel together and stay together: they are
          // meaningless apart, and the player needs both to build a buffer.
          return { samples: reply.samples, sampleRate: reply.sampleRate };
        },
      };
    },

    /** Let the voice go, and with it the model. */
    async release() {
      preparedVoiceId = null;
      await request({ type: 'release' });
    },
  };
}

/**
 * The real worker.
 *
 * A module worker, because the file it loads uses imports — and module workers are the
 * reason the add-on asks for Firefox 115 rather than anything older.
 */
function defaultSpawn() {
  return new Worker(new URL('./voice-worker.js', import.meta.url), { type: 'module' });
}

/**
 * TEMPORARY — a shared trace log for diagnosing playback and skip faults.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT JUST console.log. The faults being chased live in
 * the gaps BETWEEN two documents. A skip begins in the article page and ends as sound in
 * the voice page; a block happens in the voice page and is felt as an unresponsive button
 * in the article page. Logging in each place separately produces two lists that cannot be
 * laid against each other, because each page's `performance.now()` counts from its own
 * start. The one question that matters — what was happening HERE while THAT was waiting —
 * is exactly the question two separate logs cannot answer.
 *
 * So every event is stamped with `Date.now()`, which both pages agree on, and the voice
 * page ships its events to the article page to be collected in one ordered list.
 *
 * WHAT IT DELIBERATELY RECORDS. Not just what happened, but how long the thread was
 * unavailable, which is the actual suspect. A synchronous block cannot be observed from
 * inside itself, so it is measured two ways: directly around the work, and independently
 * by a heartbeat that should tick steadily and visibly does not when the thread is held.
 *
 * Remove this file, and the calls to it, once the answer is recorded in PROGRESS.md.
 */

/** Every event, oldest first. Capped so a long session cannot exhaust memory. */
const entries = [];
const MAX_ENTRIES = 5000;

/** Where this trace is being written — 'page' or 'voice'. Set once on first use. */
let side = 'page';

/** Told about each event as it happens, so the voice page can ship its own across. */
let forward = null;

/**
 * Start of the run, so the log reads in seconds-from-zero rather than epoch milliseconds.
 * Taken from the first event rather than from load, so the numbers start where the
 * interesting part starts.
 */
let zero = null;

export function configureTrace({ as, onEntry } = {}) {
  if (typeof as === 'string') side = as;
  if (typeof onEntry === 'function') forward = onEntry;
}

/**
 * Record one event.
 *
 * @param {string} event short, greppable name — the same name every time it happens
 * @param {object} [detail] anything worth knowing, kept small enough to read
 */
export function trace(event, detail = {}) {
  const at = Date.now();
  if (zero === null) zero = at;

  const entry = { at, side, event, ...detail };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();

  if (forward) {
    try {
      forward(entry);
    } catch {
      // A trace that cannot be shipped is still worth keeping locally.
    }
  }
  return entry;
}

/** Take in an event recorded on the other side, so both end up in one ordered list. */
export function absorb(entry) {
  if (!entry || typeof entry.at !== 'number') return;
  if (zero === null || entry.at < zero) zero = entry.at;
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
}

/**
 * Measure how long a synchronous block holds the thread.
 *
 * A block cannot be timed from inside itself — nothing runs during it — so this brackets
 * it from outside and reports the wall-clock time it took. Paired with the heartbeat
 * below: this says how long the work took, the heartbeat says whether anything else got
 * a turn while it ran. They should agree, and if they do not, that disagreement is
 * itself the finding.
 */
export async function traced(event, detail, work) {
  const started = Date.now();
  trace(`${event}:start`, detail);
  try {
    const result = await work();
    trace(`${event}:end`, { ...detail, tookMs: Date.now() - started });
    return result;
  } catch (error) {
    trace(`${event}:failed`, {
      ...detail,
      tookMs: Date.now() - started,
      error: String(error?.message ?? error),
    });
    throw error;
  }
}

/**
 * Tick steadily, and record it whenever a tick is LATE.
 *
 * This is the honest witness. A timer set for 100ms that fires 3 seconds later proves the
 * thread was held for those 3 seconds, whatever anyone believes about the code — and it
 * proves it from outside the work, which is the only vantage point that cannot be fooled.
 * A tick that is on time is not recorded at all, so the log shows stalls and nothing else.
 */
export function startHeartbeat({ everyMs = 100, lateAfterMs = 60 } = {}) {
  let expected = Date.now() + everyMs;
  const tick = () => {
    const at = Date.now();
    const late = at - expected;
    if (late > lateAfterMs) {
      // DIAGNOSIS. A stall says the thread was held; it never says by WHOM, and that is
      // the question eighty seconds of identical stall lines cannot answer. `hidden` is
      // the cheapest candidate to rule in or out: a backgrounded tab is throttled by the
      // browser to roughly one timer per second, which looks EXACTLY like a blocked
      // thread from in here — same lateness, every second, forever.
      trace('THREAD STALLED', {
        blockedMs: Math.round(late),
        hidden: globalThis.document?.visibilityState === 'hidden',
      });
    }
    expected = at + everyMs;
    setTimeout(tick, everyMs);
  };
  setTimeout(tick, everyMs);
}

/** The whole log as readable text, oldest first. */
export function formatTrace() {
  const sorted = [...entries].sort((a, b) => a.at - b.at);
  const base = sorted.length ? sorted[0].at : 0;

  const lines = sorted.map((entry) => {
    const { at, side: where, event, ...rest } = entry;
    const seconds = ((at - base) / 1000).toFixed(3).padStart(9);
    const detail = Object.entries(rest)
      .map(([key, value]) => `${key}=${typeof value === 'string' ? JSON.stringify(value) : value}`)
      .join(' ');
    return `${seconds}s  ${where === 'voice' ? 'VOICE' : 'page '}  ${event}${detail ? '  ' + detail : ''}`;
  });

  return [
    '=== Basic Text-to-Speech trace ===',
    `${sorted.length} events`,
    '',
    ...lines,
    '',
    '=== end of trace ===',
  ].join('\n');
}

/** Throw the log away, so a fresh attempt is not read against the last one. */
export function clearTrace() {
  entries.length = 0;
  zero = null;
}

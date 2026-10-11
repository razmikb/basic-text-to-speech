/**
 * Tests for the Piper engine — the remote control an article page holds.
 *
 * The engine itself makes no sound; it forwards requests to the page where the voice
 * actually runs. So what matters here is that it satisfies the engine contract, that it
 * tracks what THIS page is doing rather than what the shared voice is doing, and that it
 * copes when the voice page goes away — which it will, whenever a tab is closed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPiperEngine, isEngine, KEEPALIVE_MS } from '../src/lib/engines/piper.js';

/** A stand-in for the extension's connection to the voice page. */
function fakeApi() {
  const ports = [];

  const api = {
    ports,
    get port() {
      return ports[ports.length - 1];
    },
    runtime: {
      connect() {
        const port = {
          sent: [],
          messageListeners: [],
          disconnectListeners: [],
          disconnected: false,
          postMessage(message) {
            this.sent.push(message);
          },
          disconnect() {
            this.disconnected = true;
          },
          onMessage: {
            addListener(fn) {
              port.messageListeners.push(fn);
            },
          },
          onDisconnect: {
            addListener(fn) {
              port.disconnectListeners.push(fn);
            },
          },
          /** Pretend the voice page answered. */
          reply(message) {
            for (const listener of port.messageListeners) listener(message);
          },
          /** Pretend the voice page went away. */
          drop() {
            for (const listener of port.disconnectListeners) listener();
          },
          /** The last message of a given type that was sent. */
          lastOf(type) {
            return [...this.sent].reverse().find((message) => message.type === type);
          },
        };
        ports.push(port);
        return port;
      },
    },
  };

  return api;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the Piper engine satisfies the engine interface', () => {
  const engine = createPiperEngine({ api: fakeApi() });
  assert.ok(isEngine(engine));
  assert.equal(typeof engine.prime, 'function', 'Piper is the reason prime() exists');
});

test('speaking asks the voice page and reports back what happened', async () => {
  const api = fakeApi();
  const engine = createPiperEngine({ api });

  const speaking = engine.speak('Hello there.');
  await settle();

  const sent = api.port.lastOf('speak');
  assert.equal(sent.text, 'Hello there.');
  assert.ok(engine.isSpeaking());

  api.port.reply({ type: 'outcome', id: sent.id, outcome: 'ended' });
  assert.equal(await speaking, 'ended');
  assert.ok(!engine.isSpeaking());
});

test('nothing worth saying is never sent anywhere', async () => {
  const api = fakeApi();
  const engine = createPiperEngine({ api });

  assert.equal(await engine.speak('   '), 'ended');
  engine.prime('  ');

  assert.equal(api.ports.length, 0, 'empty text should not even open a connection');
});

test('pause and resume only apply to a page that is actually speaking', async () => {
  const api = fakeApi();
  const engine = createPiperEngine({ api });

  // Not speaking yet, so these must do nothing at all.
  engine.pause();
  engine.resume();
  assert.equal(api.ports.length, 0);

  engine.speak('Hello there.');
  await settle();

  engine.pause();
  assert.ok(engine.isPaused());
  assert.ok(api.port.lastOf('pause'));

  engine.resume();
  assert.ok(engine.isSpeaking());
  assert.ok(api.port.lastOf('resume'));
});

test('releasing says whether this page was holding the voice', async () => {
  const api = fakeApi();
  const engine = createPiperEngine({ api });

  assert.equal(engine.release(), false, 'idle pages hold nothing');

  engine.speak('Hello there.');
  await settle();
  assert.equal(engine.release(), true);
  assert.ok(!engine.isSpeaking());
});

test('a sentence in flight ends cleanly if the voice page disappears', async () => {
  const api = fakeApi();
  const engine = createPiperEngine({ api });

  const speaking = engine.speak('Hello there.');
  await settle();

  // The voice page is gone — the tab was closed, or the add-on reloaded. The sentence
  // must settle rather than leave the reader waiting forever for it to end.
  api.port.drop();

  assert.equal(await speaking, 'stopped');
  assert.ok(!engine.isSpeaking());
});

test('a failure from the voice page costs one sentence, not the article', async () => {
  const api = fakeApi();
  const engine = createPiperEngine({ api });

  const speaking = engine.speak('Hello there.');
  await settle();

  const sent = api.port.lastOf('speak');
  api.port.reply({ type: 'failed', id: sent.id, message: 'the model is missing' });

  // Resolves rather than throwing, so the reader drops this sentence and carries on.
  assert.equal(await speaking, 'error');
});

test('preparing passes on the chosen voice and reports download progress', async () => {
  const api = fakeApi();
  const seen = [];
  const engine = createPiperEngine({
    api,
    voiceId: 'en_US-joe-medium',
    onProgress: (progress) => seen.push(progress),
  });

  const preparing = engine.prepare({ rate: 1.2 });
  await settle();

  const sent = api.port.lastOf('prepare');
  assert.equal(sent.voiceId, 'en_US-joe-medium');
  assert.equal(sent.rate, 1.2);

  api.port.reply({ type: 'progress', phase: 'downloading', percent: 45 });
  api.port.reply({ type: 'ready', id: sent.id });

  assert.equal(await preparing, true);
  assert.deepEqual(seen, [{ type: 'progress', phase: 'downloading', percent: 45 }]);
});

test('the hint about the next sentence is sent, and never waited on', async () => {
  const api = fakeApi();
  const engine = createPiperEngine({ api });

  // Deliberately returns nothing: a caller must not be able to wait on a hint.
  assert.equal(engine.prime('The next sentence.'), undefined);
  assert.equal(api.port.lastOf('prime').text, 'The next sentence.');
});

test('Piper reports no word boundaries, and says so safely', () => {
  const engine = createPiperEngine({ api: fakeApi() });
  const unsubscribe = engine.onBoundary(() => {
    throw new Error('Piper cannot know where words start');
  });
  assert.equal(typeof unsubscribe, 'function');
  unsubscribe();
});

/**
 * Regression tests for the silence of 2026-09-10.
 *
 * The add-on announced "neural voice ready" in nine milliseconds — impossible, since a
 * first run has 60MB to download — and then said nothing at all. Three faults lined up:
 * the voice page was not listening yet, connecting to nothing disconnects immediately,
 * and a disconnect was being reported in a way that looked like success.
 *
 * The lesson worth keeping is the third one. A failure that reports success is far worse
 * than a failure that reports failure, because it silently disables the fallback that
 * exists precisely for this case.
 */

test('losing the connection makes prepare() fail rather than claim success', async () => {
  const api = fakeApi();
  const engine = createPiperEngine({ api });

  const preparing = engine.prepare();
  await settle();

  // Exactly what happens when nothing is listening: connect, then instant disconnect.
  api.port.drop();

  await assert.rejects(
    preparing,
    /stopped answering/,
    'a voice that never answered must never be reported as ready'
  );
});

test('losing the connection mid-sentence is a stop, not a failed sentence', async () => {
  const api = fakeApi();
  const engine = createPiperEngine({ api });

  const speaking = engine.speak('Hello there.');
  await settle();
  api.port.drop();

  // 'stopped' rather than 'error' matters: an error makes the reader step to the next
  // sentence, which would silently skip one nobody heard.
  assert.equal(await speaking, 'stopped');
});

/*
 * Sentences spoken twice after a pause — found in the owner's console log, 2026-09-11.
 *
 * The log showed the reader going BACKWARDS with nobody asking it to:
 *
 *   [3/62] Sign up for the Ideas newsletter…
 *   [4/62] This is the emerging problem…
 *   [3/62] Sign up for the Ideas newsletter…   <- back to 3, unasked
 *   [4/62] This is the emerging problem…
 *
 * and again at 5 -> 6 -> 5 -> 6, each time around a pause. The cause is this engine
 * forgetting that THIS page paused.
 */

test('pausing does not make the engine forget it is paused when a sentence lands', async () => {
  const api = fakeApi();
  const engine = createPiperEngine({ api });

  const speaking = engine.speak('A sentence.');
  api.port.reply({ type: 'ready', id: 1 });

  engine.pause();
  assert.equal(engine.isPaused(), true, 'the engine should know this page is paused');

  // The voice page answers the outstanding speak — which happens whenever the sentence
  // was already built and finished playing, and on resume in the ordinary case too.
  const speakId = api.port.sent.find((message) => message.type === 'speak')?.id;
  api.port.reply({ type: 'outcome', id: speakId, outcome: 'ended' });
  await speaking;

  // THE BUG: speak() ends by setting ownState to 'idle' whenever it still reads
  // 'speaking'. It does not, here — it reads 'paused' — so that guard holds. But the
  // engine must still report itself paused afterwards, because the reader asks exactly
  // this question to decide whether play() can resume held audio or has to re-speak the
  // sentence from nothing. Getting it wrong is heard as a sentence repeating itself.
  assert.equal(engine.isPaused(), true, 'a finished sentence must not clear the pause');
  assert.equal(engine.isSpeaking(), false, 'and it is certainly not speaking');
});

/*
 * Pause dropped after a skip — found in the owner's trace, 2026-09-11.
 *
 * The trace showed the two sides disagreeing about what was happening:
 *
 *   36.807s  page  reader:pause  state="playing"
 *   36.808s  page  engine:pause  ownState="idle"    <- so pause returned, sending nothing
 *
 * The reader knew it was playing; this engine thought it was idle, so pause hit its
 * guard and did nothing at all. The sentence played on to its end, which is exactly what
 * the owner reported: "it stops only after the sentence is read."
 */

test('a sentence abandoned by a skip does not clear the state of the one replacing it', async () => {
  const api = fakeApi();
  const engine = createPiperEngine({ api });

  const first = engine.speak('The sentence being skipped.');
  const firstId = api.port.sent.find((message) => message.type === 'speak')?.id;

  // A skip: stop, then immediately speak something else. This is precisely what the
  // reader does, and the order is its own — stop() sets idle, then speak() sets speaking.
  engine.stop();
  const second = engine.speak('The sentence actually wanted.');
  assert.equal(engine.isSpeaking(), true, 'the new sentence is what is playing now');

  // The voice page now answers the FIRST, abandoned request. This always happens: a
  // sentence in flight cannot be called back, so its reply lands after the stop.
  api.port.reply({ type: 'outcome', id: firstId, outcome: 'stopped' });
  await first;

  // THE BUG: that stale reply ran `if (ownState === 'speaking') ownState = 'idle'` and
  // cleared the state belonging to the sentence that replaced it. The engine then
  // believed nothing was playing while sound was coming out, so the next pause was
  // dropped on the floor.
  assert.equal(engine.isSpeaking(), true, 'the replacement sentence must still be speaking');

  engine.pause();
  assert.equal(engine.isPaused(), true, 'and pause must therefore be honoured');
  assert.ok(
    api.port.sent.some((message) => message.type === 'pause'),
    'a pause must actually be sent to the voice page'
  );

  const secondId = api.port.sent.filter((message) => message.type === 'speak')[1]?.id;
  api.port.reply({ type: 'outcome', id: secondId, outcome: 'ended' });
  await second;
});

/**
 * Regression tests for the silence of 2026-09-14.
 *
 * The owner paused an article, switched tabs, came back and pressed play. The button
 * responded, the bar said playing, and no sound ever came — and it stayed that way until
 * the tab was reloaded.
 *
 * The chain, from the trace: releasing a voice nobody was waiting for threw away the
 * banked audio; the generation already in flight could not be called back and stalled the
 * thread for eighty seconds; Firefox ended the background page that was wedged; and what
 * came back was a background script with NO VOICE FRAME IN IT.
 *
 * This last part is what these tests pin. Reconnecting the port succeeded — that was
 * never broken — but it connected to a page with no voice in it, so it disconnected at
 * once and the sentence settled as 'stopped' in 36 milliseconds. A port that opens and
 * closes looks exactly like a port that works, which is why the voice page has to be
 * asked for again rather than assumed to still be there.
 */

test('a sentence after a lost connection rebuilds the voice page first', async () => {
  const api = fakeApi();
  let asked = 0;
  const engine = createPiperEngine({
    api,
    ensureHost: async () => {
      asked += 1;
      return true;
    },
  });

  // A first sentence, then the connection dies — taking the voice page with it.
  const first = engine.speak('One.');
  await settle();
  api.port.drop();
  await first;

  assert.equal(asked, 0, 'nothing is rebuilt until something is actually needed');

  engine.speak('Two.');
  await settle();

  assert.equal(asked, 1, 'the voice page must be asked for again before speaking');
  assert.ok(
    api.port.lastOf('speak'),
    'and the sentence must still be sent once there is somewhere for it to go'
  );
});

test('a voice that cannot be rebuilt stops the article instead of racing to its end', async () => {
  const api = fakeApi();
  const engine = createPiperEngine({
    api,
    ensureHost: async () => {
      throw new Error('the voice has nowhere to run');
    },
  });

  const first = engine.speak('One.');
  await settle();
  api.port.drop();
  await first;

  const outcome = await engine.speak('Two.');

  /*
   * 'stopped' rather than 'error', and this is the whole lesson of 2026-09-14.
   *
   * The reader answers an error by stepping over that sentence and trying the next one,
   * which is right when ONE sentence is bad. A voice that is down fails every sentence
   * identically, so the same rule walked the entire article in 400 milliseconds and left
   * the listener at the end of a piece they were halfway through.
   *
   * The distinction that matters: an error means "this sentence failed", a stop means
   * "stop asking". Only the second is true when the voice itself has gone.
   */
  assert.equal(outcome, 'stopped', 'a voice that is down must halt the article, not skip it');
});

test('a voice that is down does not let the reader race through the article', async () => {
  const api = fakeApi();
  const engine = createPiperEngine({
    api,
    ensureHost: async () => {
      throw new Error('the voice has nowhere to run');
    },
  });

  const first = engine.speak('One.');
  await settle();
  api.port.drop();
  await first;

  // What the reader does with each outcome, mirroring run() in reader.js: an error steps
  // to the next sentence, a stop ends the loop.
  let index = 0;
  const sentences = ['A.', 'B.', 'C.', 'D.', 'E.'];
  while (index < sentences.length) {
    const outcome = await engine.speak(sentences[index]);
    if (outcome === 'stopped') break;
    index += 1;
  }

  assert.equal(index, 0, 'the listener must still be where they were, not at the end');
});

test('the voice page is not re-asked for while the connection is healthy', async () => {
  const api = fakeApi();
  let asked = 0;
  const engine = createPiperEngine({
    api,
    ensureHost: async () => {
      asked += 1;
      return true;
    },
  });

  engine.speak('One.');
  await settle();
  api.port.reply({ type: 'spoke', id: 1, outcome: 'ended' });
  await settle();
  engine.speak('Two.');
  await settle();

  assert.equal(asked, 0, 'rebuilding on every sentence would cost a message round trip each time');
});

/**
 * The fault my first fix missed, on 2026-09-14.
 *
 * Confirming the voice PAGE exists is not the same as confirming there is a VOICE in it.
 * The page starts empty and `prepare` is what builds the pipeline that speaks, so a
 * reconnected port reaches a live page that refuses every sentence on arrival. The trace
 * showed it plainly: `msg:speak` reached the voice page and the reply was still an error.
 */
test('rebuilding the voice prepares it again, not just the page it lives in', async () => {
  const api = fakeApi();
  const engine = createPiperEngine({ api, ensureHost: async () => true });

  const preparing = engine.prepare({ rate: 1.4, articleId: 'https://example.com/a' });
  await settle();
  api.port.reply({ type: 'ready', id: 1 });
  await preparing;

  const first = engine.speak('One.');
  await settle();
  api.port.drop();
  await first;

  const speaking = engine.speak('Two.');
  await settle();

  const prepared = api.port.lastOf('prepare');
  assert.ok(prepared, 'a page with no pipeline in it refuses every sentence it is sent');

  // Answer the rebuild so the sentence can proceed, as the real voice page would.
  api.port.reply({ type: 'ready', id: prepared.id });
  await settle();
  api.port.reply({ type: 'outcome', id: api.port.lastOf('speak').id, outcome: 'ended' });
  assert.equal(await speaking, 'ended', 'and the sentence must go through once it is back');
  assert.equal(prepared.rate, 1.4, 'and it must come back as it was, not at some default');
  assert.equal(prepared.articleId, 'https://example.com/a');
});

test('an engine that was never prepared does not invent a preparation', async () => {
  const api = fakeApi();
  const engine = createPiperEngine({ api, ensureHost: async () => true });

  const first = engine.speak('One.');
  await settle();
  api.port.drop();
  await first;

  const speaking = engine.speak('Two.');
  await settle();

  assert.equal(api.port.lastOf('prepare'), undefined);

  api.port.reply({ type: 'outcome', id: api.port.lastOf('speak').id, outcome: 'ended' });
  assert.equal(await speaking, 'ended');
});

test('a long first-run download keeps the background awake until the voice is ready', async (t) => {
  // Firefox puts an add-on's background to sleep after 30 seconds with no incoming
  // message, taking the voice page with it. A download only sends news outward, so
  // without these the first article ever read lost its voice half a minute in.
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const api = fakeApi();
  const engine = createPiperEngine({ api });

  const ready = engine.prepare({ rate: 1 });
  await settle();
  const keepalives = () => api.port.sent.filter((m) => m.type === 'keepalive').length;

  t.mock.timers.tick(KEEPALIVE_MS * 6);
  assert.equal(keepalives(), 6, 'one every KEEPALIVE_MS while waiting');
  assert.ok(KEEPALIVE_MS < 30000, 'well inside Firefox’s 30-second idle limit');

  api.port.reply({ type: 'ready', id: api.port.lastOf('prepare').id });
  await ready;
  t.mock.timers.tick(KEEPALIVE_MS * 6);
  assert.equal(keepalives(), 6, 'and none once the voice has answered');
});

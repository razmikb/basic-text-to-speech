/**
 * Tests for the page's end of the voice worker.
 *
 * WHAT THESE CAN AND CANNOT PROVE. A real Worker cannot run here, and neither can the
 * model it loads, so the worker itself is a stand-in. That is enough, because the part
 * worth testing is not the voice — it is the BOOKKEEPING. A worker replies with unordered
 * messages, and the only thing tying an answer to its question is an id. Getting that
 * wrong does not crash: it hands one sentence's audio to a different sentence, or leaves
 * a promise that never settles and playback that hangs with no error anywhere.
 *
 * That last failure shape has already cost this project a session once, which is why the
 * dead-worker case below is here at all.
 *
 * What these cannot prove is that the voice sounds right, or that moving it to a second
 * thread actually unblocked the first. Only a trace and a listening session show that.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createVoiceClient } from '../src/piper/worker-client.js';

const VOICE = 'en_US-hfc_female-medium';
const PATHS = { pathMap: { [VOICE]: 'en/x.onnx' }, onnxBase: '/ort/', phonemizerBase: '/pp' };

/**
 * A worker that records what it was asked and answers only when told to.
 *
 * Replying by hand rather than automatically is the point: it lets a test hold one answer
 * back, which is the only way to ask what happens to the OTHER request in the meantime.
 */
function fakeWorker() {
  const listeners = { message: [], error: [] };
  const worker = {
    sent: [],
    transfers: [],
    postMessage(message, transfer) {
      worker.sent.push(message);
      worker.transfers.push(transfer);
    },
    addEventListener(type, fn) {
      listeners[type]?.push(fn);
    },
    /** Answer one request, as the real worker would. */
    reply(reply) {
      for (const fn of listeners.message) fn({ data: reply });
    },
    /** The worker died, taking everything unanswered with it. */
    die(message = 'boom') {
      for (const fn of listeners.error) fn({ message });
    },
    /** What was asked, by type. */
    of(type) {
      return worker.sent.filter((message) => message.type === type);
    },
  };
  return worker;
}

function clientWith() {
  const worker = fakeWorker();
  const client = createVoiceClient({ spawn: () => worker });
  return { worker, client };
}

test('a voice is prepared once, however many sentences are spoken', async () => {
  const { worker, client } = clientWith();

  const first = client.get(VOICE, PATHS);
  worker.reply({ id: worker.of('prepare')[0].id, ok: true });
  const speaker = await first;

  // The second ask must not prepare again: preparing is the 60MB parse this whole
  // change exists to do exactly once.
  const second = await client.get(VOICE, PATHS);

  assert.equal(worker.of('prepare').length, 1, 'the voice must be prepared only once');
  assert.equal(speaker.voiceId, VOICE);
  assert.equal(second.voiceId, VOICE);
});

test('a failed prepare is retried rather than remembered as done', async () => {
  const { worker, client } = clientWith();

  const failed = client.get(VOICE, PATHS);
  worker.reply({ id: worker.of('prepare')[0].id, ok: false, message: 'no such voice' });
  await assert.rejects(failed, /no such voice/);

  // If the failure were recorded as success, the voice would be silently missing for the
  // whole article and nothing would ever try again.
  const retry = client.get(VOICE, PATHS);
  assert.equal(worker.of('prepare').length, 2, 'a failed prepare must be tried again');
  worker.reply({ id: worker.of('prepare')[1].id, ok: true });
  await retry;
});

test('each answer goes to the request that asked for it, whatever order they arrive in', async () => {
  const { worker, client } = clientWith();

  const ready = client.get(VOICE, PATHS);
  worker.reply({ id: worker.of('prepare')[0].id, ok: true });
  const speaker = await ready;

  const one = speaker.generate('first sentence');
  const two = speaker.generate('second sentence');
  const [askedOne, askedTwo] = worker.of('generate');

  // Answered BACKWARDS, which is the case that catches a client matching by arrival
  // order instead of by id. Getting this wrong plays one sentence's audio for another.
  worker.reply({ id: askedTwo.id, ok: true, samples: Float32Array.of(2), sampleRate: 22050 });
  worker.reply({ id: askedOne.id, ok: true, samples: Float32Array.of(1), sampleRate: 22050 });

  assert.equal((await one).samples[0], 1, 'the first request must get the first answer');
  assert.equal((await two).samples[0], 2, 'and the second the second');
});

test('one sentence failing does not disturb another in flight', async () => {
  const { worker, client } = clientWith();

  const ready = client.get(VOICE, PATHS);
  worker.reply({ id: worker.of('prepare')[0].id, ok: true });
  const speaker = await ready;

  const bad = speaker.generate('unsayable');
  const good = speaker.generate('fine');
  const [askedBad, askedGood] = worker.of('generate');

  worker.reply({ id: askedBad.id, ok: false, message: 'phonemizer gave up' });
  worker.reply({ id: askedGood.id, ok: true, samples: Float32Array.of(7), sampleRate: 22050 });

  await assert.rejects(bad, /phonemizer gave up/);
  const survived = await good;
  assert.equal(survived.samples[0], 7, 'a neighbouring sentence must be unaffected');
  assert.equal(survived.sampleRate, 22050, 'and must keep the rate its samples need');
});

test('a worker that dies fails everything waiting, rather than hanging forever', async () => {
  const { worker, client } = clientWith();

  const ready = client.get(VOICE, PATHS);
  worker.reply({ id: worker.of('prepare')[0].id, ok: true });
  const speaker = await ready;

  const one = speaker.generate('a');
  const two = speaker.generate('b');

  worker.die('the voice thread crashed');

  // The alternative is playback waiting for sentences that can never arrive, with no
  // error shown anywhere — silence that looks exactly like a broken button.
  await assert.rejects(one, /the voice thread crashed/);
  await assert.rejects(two, /the voice thread crashed/);
});

test('an answer nobody is waiting for is ignored, not thrown', async () => {
  const { worker, client } = clientWith();

  const ready = client.get(VOICE, PATHS);
  worker.reply({ id: worker.of('prepare')[0].id, ok: true });
  await ready;

  // Arrives after a stop, or a reload. There is nothing left to tell, and it must not
  // become an error on a thread that is otherwise fine.
  worker.reply({ id: 999, ok: true, samples: Float32Array.of(0), sampleRate: 22050 });
  worker.reply({ ok: true, samples: Float32Array.of(0), sampleRate: 22050 });
});

test('releasing lets the voice go and prepares it afresh next time', async () => {
  const { worker, client } = clientWith();

  const ready = client.get(VOICE, PATHS);
  worker.reply({ id: worker.of('prepare')[0].id, ok: true });
  await ready;

  const released = client.release();
  worker.reply({ id: worker.of('release')[0].id, ok: true });
  await released;

  // The worker no longer holds the model, so asking again must prepare it, not assume it.
  client.get(VOICE, PATHS);
  assert.equal(worker.of('prepare').length, 2, 'a released voice must be prepared again');
});

test('the paths the worker needs are sent with the request that needs them', async () => {
  const { worker, client } = clientWith();

  client.get(VOICE, PATHS);
  const [prepare] = worker.of('prepare');

  // The worker cannot find the model or the pronunciation engine without these, and it
  // deliberately does not import the vendored library to look them up itself.
  assert.deepEqual(prepare.paths, PATHS);
  assert.equal(prepare.voiceId, VOICE);
});

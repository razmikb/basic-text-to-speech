import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The bug the owner hit on a real article: the first click starts reading, the second
 * click starts reading *again* instead of pausing.
 *
 * Setting up the session is asynchronous (it waits for the browser's voice list). A
 * second click that arrives before that finishes finds `session` still empty and builds
 * a whole second reader. Two readers means two voices and a pause button that appears
 * to do nothing, because it pauses only one of them.
 *
 * This models the content script's toggle logic directly, since the content script
 * itself cannot be imported outside a browser.
 */

/** The broken version, kept so the test proves the fix is actually needed. */
function makeBrokenToggle(createSession) {
  let session = null;
  return async function toggle() {
    if (!session) {
      session = await createSession();
      if (!session) return;
    }
    session.reader.toggle();
  };
}

/** The fixed version: remember the in-flight setup, so clicks queue behind it. */
function makeFixedToggle(createSession) {
  let session = null;
  let starting = null;
  let queue = Promise.resolve();

  return function toggle() {
    queue = queue.then(async () => {
      if (!session) {
        if (!starting) starting = createSession();
        session = await starting;
        if (!session) return;
      }
      session.reader.toggle();
    });
    return queue;
  };
}

/** A session whose construction is slow, the way waiting for voices really is. */
function slowSessionFactory(delayMs = 5) {
  const built = [];
  const factory = () =>
    new Promise((resolve) => {
      setTimeout(() => {
        const reader = {
          calls: [],
          toggle() {
            reader.calls.push('toggle');
          },
        };
        built.push(reader);
        resolve({ reader });
      }, delayMs);
    });
  factory.built = built;
  return factory;
}

test('REGRESSION: two fast clicks used to build two readers', async () => {
  const factory = slowSessionFactory();
  const toggle = makeBrokenToggle(factory);

  await Promise.all([toggle(), toggle()]);

  assert.equal(factory.built.length, 2, 'this is the bug: a second reader was created');
});

test('two fast clicks build only one reader', async () => {
  const factory = slowSessionFactory();
  const toggle = makeFixedToggle(factory);

  await Promise.all([toggle(), toggle()]);

  assert.equal(factory.built.length, 1, 'the page must only ever have one reader');
});

test('the second click pauses instead of starting a second voice', async () => {
  const factory = slowSessionFactory();
  const toggle = makeFixedToggle(factory);

  await Promise.all([toggle(), toggle()]);

  assert.deepEqual(
    factory.built[0].calls,
    ['toggle', 'toggle'],
    'both clicks must reach the same reader, so the second one pauses'
  );
});

test('clicks stay in order even when they arrive during setup', async () => {
  const factory = slowSessionFactory(10);
  const toggle = makeFixedToggle(factory);

  const first = toggle();
  const second = toggle();
  const third = toggle();
  await Promise.all([first, second, third]);

  assert.equal(factory.built.length, 1);
  assert.equal(factory.built[0].calls.length, 3, 'no click may be silently dropped');
});

test('a page with no article does not build a reader on later clicks either', async () => {
  let attempts = 0;
  const factory = () => {
    attempts += 1;
    return Promise.resolve(null);
  };
  const toggle = makeFixedToggle(factory);

  await toggle();
  await toggle();

  assert.equal(attempts, 1, 'a page with no article should only be examined once');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReader } from '../src/lib/reader.js';
import { createFakeEngine } from './helpers/fake-engine.js';

/**
 * One tab reads at a time.
 *
 * The browser has a single speech engine shared by every tab, and a content script can
 * only see its own page. Two pages that both start reading push sentences into the same
 * queue and the browser plays them in arrival order, so the articles alternate a
 * sentence at a time — exactly what the owner heard on 2026-09-10.
 *
 * Only the background script sees every tab, so that is where the rule lives: a tab
 * about to speak claims the voice, and every other tab is told to yield first. These
 * tests model that conversation, since neither real script can be imported outside a
 * browser.
 */

const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * The background script's referee logic, mirroring src/background.js.
 * Tabs register themselves so it can deliver the yield message.
 */
function makeReferee() {
  const tabs = new Map();
  let readingTabId = null;

  return {
    register(id, tab) {
      tabs.set(id, tab);
    },

    /** A tab is about to speak: clear everyone else out of the way first. */
    async claim(tabId) {
      readingTabId = tabId;
      for (const [id, tab] of tabs) {
        if (id === tabId) continue;
        await tab.yieldVoice();
      }
      return { ok: true };
    },

    /** Advisory: ignored if this tab is not the one currently holding the voice. */
    released(tabId) {
      if (readingTabId === tabId) readingTabId = null;
    },

    closed(tabId) {
      tabs.delete(tabId);
      if (readingTabId === tabId) readingTabId = null;
    },

    holder() {
      return readingTabId;
    },
  };
}

/** One tab: a reader, plus the content script's claim/yield behaviour. */
function makeTab(id, referee, sentenceTexts) {
  const engine = createFakeEngine();
  const sentences = sentenceTexts.map((text, i) => ({
    text,
    blockIndex: 0,
    start: i,
    end: i + 1,
  }));
  const reader = createReader({ engine, sentences });

  const tab = {
    id,
    engine,
    reader,

    async toggle() {
      if (reader.getState() === 'playing') {
        reader.pause();
        referee.released(id);
        return;
      }
      await referee.claim(id);
      reader.play();
      await settle();
    },

    async yieldVoice() {
      reader.releaseVoice();
      await settle();
    },
  };

  referee.register(id, tab);
  return tab;
}

test('starting a second tab silences the first instead of interleaving', async () => {
  const referee = makeReferee();
  const one = makeTab(1, referee, ['ONE a.', 'ONE b.', 'ONE c.']);
  const two = makeTab(2, referee, ['TWO a.', 'TWO b.']);

  await one.toggle();
  assert.equal(one.reader.getState(), 'playing');

  // The owner switches tabs and presses play on the second article.
  await two.toggle();

  assert.equal(two.reader.getState(), 'playing', 'the new article reads');
  assert.notEqual(one.reader.getState(), 'playing', 'the old one must have gone quiet');
  assert.equal(referee.holder(), 2, 'the second tab now holds the voice');
});

test('only one tab is ever speaking, however many are opened', async () => {
  const referee = makeReferee();
  const tabs = [
    makeTab(1, referee, ['ONE a.', 'ONE b.']),
    makeTab(2, referee, ['TWO a.', 'TWO b.']),
    makeTab(3, referee, ['THREE a.', 'THREE b.']),
  ];

  for (const tab of tabs) {
    await tab.toggle();
    const playing = tabs.filter((t) => t.reader.getState() === 'playing');
    assert.equal(playing.length, 1, 'exactly one tab may be speaking at any moment');
    assert.equal(playing[0].id, tab.id, 'and it is the one just started');
  }
});

test('a tab that yields keeps its place and resumes there', async () => {
  const referee = makeReferee();
  const one = makeTab(1, referee, ['ONE a.', 'ONE b.', 'ONE c.']);
  const two = makeTab(2, referee, ['TWO a.']);

  await one.toggle();
  await one.engine.finish(); // "ONE a." finishes
  await settle();
  assert.equal(one.reader.getIndex(), 1, 'part-way through the first article');

  await two.toggle(); // the first tab is told to yield
  assert.equal(one.reader.getIndex(), 1, 'its place is kept');

  // Back to the first article.
  await one.toggle();
  assert.equal(one.reader.getState(), 'playing');
  assert.equal(one.engine.spoken.at(-1).text, 'ONE b.', 'it carries on where it left off');
});

test('pausing hands the voice back so another tab can take it', async () => {
  const referee = makeReferee();
  const one = makeTab(1, referee, ['ONE a.', 'ONE b.']);

  await one.toggle();
  assert.equal(referee.holder(), 1);

  await one.toggle(); // pause
  assert.equal(one.reader.getState(), 'paused');
  assert.equal(referee.holder(), null, 'the voice is free again');
});

test('a late release from an old tab does not unseat the new reader', async () => {
  const referee = makeReferee();
  const one = makeTab(1, referee, ['ONE a.']);
  const two = makeTab(2, referee, ['TWO a.']);

  await one.toggle();
  await two.toggle();
  assert.equal(referee.holder(), 2);

  // The first tab's "I have stopped" message arrives late, after tab two took over.
  referee.released(1);

  assert.equal(referee.holder(), 2, 'the new reader must keep the voice');
});

test('closing the reading tab frees the voice', async () => {
  const referee = makeReferee();
  const one = makeTab(1, referee, ['ONE a.']);

  await one.toggle();
  assert.equal(referee.holder(), 1);

  referee.closed(1);
  assert.equal(referee.holder(), null);
});

test('yielding a tab that was never reading changes nothing', async () => {
  const referee = makeReferee();
  const one = makeTab(1, referee, ['ONE a.']);
  const two = makeTab(2, referee, ['TWO a.']);

  // Tab one has never played, so being told to yield must be harmless.
  await two.toggle();

  assert.equal(one.reader.getState(), 'idle');
  assert.equal(two.reader.getState(), 'playing');
});

/**
 * The referee only messages tabs that have actually played something, so it never needs
 * the broad "tabs" permission just to find out who is out there. This mirrors the
 * knownReaders set in src/background.js.
 */
test('only tabs that have read are ever asked to yield', async () => {
  const asked = [];
  const knownReaders = new Set();
  let readingTabId = null;

  const claim = (tabId) => {
    knownReaders.add(tabId);
    readingTabId = tabId;
    for (const id of knownReaders) {
      if (id !== tabId) asked.push(id);
    }
  };

  claim(1); // the first tab to play: nobody else is known yet
  assert.deepEqual(asked, [], 'the very first reader disturbs nobody');

  claim(2);
  assert.deepEqual(asked, [1], 'only the tab that had been reading is contacted');

  claim(3);
  assert.deepEqual(asked, [1, 1, 2], 'still only tabs that have played, never all tabs');
  assert.equal(readingTabId, 3);
});

test('the same tab pressing play twice does not fight itself', async () => {
  const referee = makeReferee();
  const one = makeTab(1, referee, ['ONE a.', 'ONE b.']);

  await one.toggle(); // play
  await one.toggle(); // pause
  await one.toggle(); // play again

  assert.equal(one.reader.getState(), 'playing');
  assert.equal(referee.holder(), 1);
  assert.equal(one.reader.getIndex(), 0, 'still on the sentence it paused on');
});

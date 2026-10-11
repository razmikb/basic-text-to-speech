import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createHighlighter, createDomViewport } from '../src/lib/highlighter.js';
import { extractArticle } from '../src/lib/extractor.js';
import { buildSentences } from '../src/lib/reader.js';
import { DEFAULTS } from '../src/lib/config.js';

/**
 * Tests for following the spoken sentence down the page.
 *
 * The rule from PLAN.md is "scroll only when the highlight goes out of view, and never
 * fight someone who scrolls away themselves". Both halves are decisions about *when* to
 * move the page, which is testable without a window — so the measuring and moving lives
 * behind a small seam and these tests supply their own, along with their own clock.
 */

const LONG = 'This paragraph has to be long enough that the extractor treats it as prose. ';

/** A stand-in for the browser: records what it was asked to do, answers what we tell it. */
function createFakeViewport({ visible = true } = {}) {
  const view = {
    visible,
    scrolled: [],
    listeners: new Set(),
    unsubscribed: 0,

    isVisible() {
      return view.visible;
    },
    scrollTo(element) {
      view.scrolled.push(element);
    },
    onUserScroll(listener) {
      view.listeners.add(listener);
      return () => {
        view.unsubscribed += 1;
        view.listeners.delete(listener);
      };
    },

    /** Pretend something scrolled the page — the user, or us. */
    fireScroll() {
      for (const listener of [...view.listeners]) listener();
    },
  };
  return view;
}

function setup(config = {}, viewportOptions = {}) {
  const html = `<article><p>${LONG}A second sentence here. ${LONG}A third one too.</p></article>`;
  const doc = parseHTML(`<html><head></head><body>${html}</body></html>`).document;
  const { blocks } = extractArticle(doc);
  const sentences = buildSentences(blocks);
  const viewport = createFakeViewport(viewportOptions);

  // A clock the test drives, so nothing has to wait in real time.
  let clock = 1_000_000;
  const now = () => clock;
  const advance = (ms) => {
    clock += ms;
  };

  const highlighter = createHighlighter({
    doc,
    blocks,
    config: { ...DEFAULTS, ...config },
    viewport,
    now,
  });

  return { highlighter, sentences, viewport, advance };
}

test('a sentence already in view does not move the page', () => {
  const { highlighter, sentences, viewport } = setup({}, { visible: true });

  highlighter.show(sentences[0]);

  assert.equal(viewport.scrolled.length, 0);
});

test('a sentence out of view brings the page to it', () => {
  const { highlighter, sentences, viewport } = setup({}, { visible: false });

  highlighter.show(sentences[0]);

  assert.equal(viewport.scrolled.length, 1);
  assert.equal(viewport.scrolled[0].className, 'ftts-sentence');
});

test('following can be switched off entirely', () => {
  const { highlighter, sentences, viewport } = setup(
    { scrollToSentence: false },
    { visible: false }
  );

  highlighter.show(sentences[0]);

  assert.equal(viewport.scrolled.length, 0);
  assert.equal(viewport.listeners.size, 0, 'no need to watch scrolling we will never act on');
});

test('scrolling by hand stops the page being pulled away', () => {
  const { highlighter, sentences, viewport, advance } = setup({}, { visible: false });

  highlighter.show(sentences[0]);
  assert.equal(viewport.scrolled.length, 1);

  // The reader takes hold of the page to look ahead.
  advance(5000);
  viewport.fireScroll();

  advance(100);
  highlighter.show(sentences[1]);

  assert.equal(viewport.scrolled.length, 1, 'the page was pulled back while being read');
});

test('following resumes a few seconds after the reader stops scrolling', () => {
  const { highlighter, sentences, viewport, advance } = setup({}, { visible: false });

  highlighter.show(sentences[0]);
  assert.equal(viewport.scrolled.length, 1);

  // The reader scrolls off somewhere else, well after our own glide has settled.
  advance(DEFAULTS.scrollSettleMs + 1);
  viewport.fireScroll();

  advance(100);
  highlighter.show(sentences[1]);
  assert.equal(viewport.scrolled.length, 1, 'the page was pulled back too soon');

  // Long enough that they have plainly stopped: start following again rather than
  // silently giving up for the rest of the article.
  advance(DEFAULTS.scrollRespectUserMs + 1);
  highlighter.show(sentences[2]);

  assert.equal(viewport.scrolled.length, 2);
});

test('our own scrolling is not mistaken for the reader scrolling', () => {
  // A smooth scroll fires scroll events for its whole animation. If those counted as the
  // reader grabbing the page, the first automatic scroll would switch following off for
  // good — so this is the test that the distinction actually works.
  const { highlighter, sentences, viewport, advance } = setup({}, { visible: false });

  highlighter.show(sentences[0]);
  assert.equal(viewport.scrolled.length, 1);

  advance(200);
  viewport.fireScroll(); // the glide we just started
  advance(200);
  viewport.fireScroll();

  advance(100);
  highlighter.show(sentences[1]);

  assert.equal(viewport.scrolled.length, 2, 'we talked ourselves out of following');
});

test('a scroll after our own has settled is the reader, and is respected', () => {
  const { highlighter, sentences, viewport, advance } = setup({}, { visible: false });

  highlighter.show(sentences[0]);

  advance(DEFAULTS.scrollSettleMs + 1);
  viewport.fireScroll(); // too late to be ours

  highlighter.show(sentences[1]);
  assert.equal(viewport.scrolled.length, 1);
});

test('destroy stops watching the page scroll', () => {
  const { highlighter, sentences, viewport } = setup({}, { visible: false });

  highlighter.show(sentences[0]);
  assert.equal(viewport.listeners.size, 1);

  highlighter.destroy();

  assert.equal(viewport.unsubscribed, 1);
  assert.equal(viewport.listeners.size, 0);
});

test('a sentence that could not be marked never moves the page', () => {
  const { highlighter, viewport } = setup({}, { visible: false });

  assert.equal(highlighter.show({ blockIndex: 99, start: 0, end: 5 }), false);

  assert.equal(viewport.scrolled.length, 0);
});

test('a viewport that throws does not interrupt the reading', () => {
  const { highlighter, sentences, viewport } = setup({}, { visible: false });
  viewport.isVisible = () => {
    throw new Error('the page is being difficult');
  };

  assert.equal(highlighter.show(sentences[0]), true, 'the highlight still belongs on the page');
});

/**
 * The real viewport, exercised with a hand-made window. These are the few lines that touch
 * the browser, so they are checked against a stub of it rather than left untested.
 */
test('the real viewport calls a sentence near the bottom edge out of view', () => {
  const view = createDomViewport({ innerHeight: 1000 }, DEFAULTS);

  const comfortable = {
    getBoundingClientRect: () => ({ top: 300, bottom: 400, width: 5, height: 5 }),
  };
  const tooLow = { getBoundingClientRect: () => ({ top: 780, bottom: 860, width: 5, height: 5 }) };
  const tooHigh = { getBoundingClientRect: () => ({ top: 20, bottom: 90, width: 5, height: 5 }) };

  assert.equal(view.isVisible(comfortable), true);
  assert.equal(view.isVisible(tooLow), false, 'clinging to the bottom edge is not readable');
  assert.equal(view.isVisible(tooHigh), false);
});

test('the real viewport does not move a page it cannot measure', () => {
  const noHeight = createDomViewport({ innerHeight: 0 }, DEFAULTS);
  assert.equal(
    noHeight.isVisible({ getBoundingClientRect: () => ({ top: 5000, bottom: 5100 }) }),
    true
  );

  const view = createDomViewport({ innerHeight: 1000 }, DEFAULTS);
  // A hidden element has no box at all; scrolling to it would jump somewhere arbitrary.
  const hidden = { getBoundingClientRect: () => ({ top: 0, bottom: 0, width: 0, height: 0 }) };
  assert.equal(view.isVisible(hidden), true);
  assert.equal(view.isVisible({}), true, 'an element that cannot be measured is left alone');
});

test('the real viewport centres the sentence and respects reduced motion', () => {
  const asked = [];
  const element = { scrollIntoView: (options) => asked.push(options) };

  createDomViewport({ innerHeight: 1000 }, DEFAULTS).scrollTo(element);
  assert.equal(asked[0].block, 'center', 'centring is what keeps scrolling rare');
  assert.equal(asked[0].behavior, 'smooth');

  const still = createDomViewport(
    { innerHeight: 1000, matchMedia: (query) => ({ matches: query.includes('reduced-motion') }) },
    DEFAULTS
  );
  still.scrollTo(element);
  assert.equal(asked[1].behavior, 'auto', 'someone asking for less motion should not get a glide');
});

test('the real viewport subscribes passively and unsubscribes cleanly', () => {
  const added = [];
  const removed = [];
  const win = {
    innerHeight: 1000,
    addEventListener: (type, listener, options) => added.push({ type, listener, options }),
    removeEventListener: (type, listener) => removed.push({ type, listener }),
  };

  const stop = createDomViewport(win, DEFAULTS).onUserScroll(() => {});

  assert.equal(added[0].type, 'scroll');
  assert.equal(added[0].options.passive, true, 'we watch the page, we never interfere with it');

  stop();
  assert.equal(removed[0].listener, added[0].listener);
});

test('there is no viewport at all without a window', () => {
  assert.equal(createDomViewport(null, DEFAULTS), null);
});

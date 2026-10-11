import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createReader, buildSentences } from '../src/lib/reader.js';
import { createHighlighter } from '../src/lib/highlighter.js';
import { extractArticle, normalizeWhitespace } from '../src/lib/extractor.js';
import { DEFAULTS } from '../src/lib/config.js';
import { createFakeEngine } from './helpers/fake-engine.js';
import { needsPages, loadPage } from './helpers/pages.js';

/**
 * The reader and the highlighter, working together on a real article.
 *
 * Each is tested on its own elsewhere. This is the join: content.js connects the reader's
 * announcements to the highlighter, and nothing else proves that what gets marked on the
 * page is the same sentence the voice is saying. That is the whole feature, so it is
 * tested against real article HTML rather than a hand-made page.
 */

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Set up a page, a voice that makes no sound, and the wiring content.js does. */
function startReading(fixture) {
  const doc = loadPage(fixture);
  const { blocks } = extractArticle(doc);
  const sentences = buildSentences(blocks);

  const engine = createFakeEngine();
  const reader = createReader({ engine, sentences, config: DEFAULTS });
  const highlighter = createHighlighter({ doc, blocks, config: DEFAULTS, viewport: null });

  // Exactly what content.js does, and the only connection between the two.
  reader.on('sentence', ({ sentence }) => highlighter.show(sentence));
  reader.on('state', ({ state }) => {
    if (state === 'idle') highlighter.destroy();
  });
  reader.on('finished', () => highlighter.clear());

  const highlighted = () =>
    normalizeWhitespace(
      [...doc.querySelectorAll('.ftts-sentence')].map((span) => span.textContent).join('')
    );

  return { doc, reader, engine, sentences, highlighted, before: doc.body.outerHTML };
}

test('the highlight is always on the sentence being spoken', needsPages, async () => {
  const { reader, engine, sentences, highlighted } = startReading('chalkbeat');

  reader.play();
  await settle();

  // Read a good stretch of the real article, checking at every step that what is marked
  // on the page is what the voice was handed.
  for (let i = 0; i < 25; i += 1) {
    assert.equal(engine.spoken[i].text, sentences[i].text);
    assert.equal(highlighted(), sentences[i].text, `sentence ${i} was marked wrongly`);
    await engine.finish();
    await settle();
  }
});

test('the highlight follows a skip, forwards and back', needsPages, async () => {
  const { reader, sentences, highlighted } = startReading('chalkbeat');

  reader.play();
  await settle();

  reader.skip(10);
  await settle();
  assert.equal(highlighted(), sentences[10].text);

  reader.skip(-4);
  await settle();
  assert.equal(highlighted(), sentences[6].text);
});

test('pausing keeps the highlight, so you can see where you stopped', needsPages, async () => {
  const { reader, sentences, highlighted } = startReading('chalkbeat');

  reader.play();
  await settle();
  reader.pause();
  await settle();

  assert.equal(reader.getState(), 'paused');
  assert.equal(highlighted(), sentences[0].text, 'pausing must not lose your place');
});

test('stopping leaves the page exactly as it was found', needsPages, async () => {
  const { doc, reader, engine, before, highlighted } = startReading('chalkbeat');

  reader.play();
  await settle();
  await engine.finish();
  await settle();
  assert.notEqual(highlighted(), '', 'nothing was ever marked');

  reader.stop();
  await settle();

  assert.equal(doc.body.outerHTML, before);
  assert.equal(doc.getElementById('ftts-highlight-style'), null);
});

test('reaching the end of the article takes the highlight off', needsPages, async () => {
  const doc = parseHTML(
    '<html><head></head><body><article><p>' +
      'This paragraph is long enough for the extractor to treat it as real prose. ' +
      'And it ends here.</p></article></body></html>'
  ).document;
  const { blocks } = extractArticle(doc);
  const sentences = buildSentences(blocks);
  const engine = createFakeEngine();
  const reader = createReader({ engine, sentences, config: DEFAULTS });
  const highlighter = createHighlighter({ doc, blocks, config: DEFAULTS, viewport: null });
  reader.on('sentence', ({ sentence }) => highlighter.show(sentence));
  reader.on('finished', () => highlighter.clear());

  reader.play();
  await settle();
  for (let i = 0; i < sentences.length; i += 1) {
    await engine.finish();
    await settle();
  }

  assert.equal(reader.getState(), 'finished');
  assert.equal(doc.querySelectorAll('.ftts-sentence').length, 0);
});

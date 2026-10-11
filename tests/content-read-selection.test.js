import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePage } from './helpers/content-page.js';
import { made, resetFakes } from './helpers/content-page-fakes.js';

/**
 * "Read selection aloud", run through the real content.js.
 *
 * The selection becomes the reading: whatever was playing stops, its bar goes, and one new
 * reader speaks the selection with the voice already built. The toolbar icon still means
 * "the article" afterwards — it must never replay an old selection.
 */

test('reading a selection stops the article and reads the selection in its place', async () => {
  resetFakes();
  const page = makePage();
  page.load();

  await page.pressIcon();
  const [article] = made.readers;
  assert.equal(article.state, 'playing');

  await page.readSelection('Selected.');
  assert.equal(made.readers.length, 2);
  const selection = made.readers[1];
  assert.equal(article.state, 'idle');
  assert.equal(made.bars[0].destroyed, true);
  assert.equal(selection.state, 'playing');
  assert.deepEqual(selection.sentences, [{ text: 'Selected.' }]);
  // The browser's copy of the text is passed on for the fallback.
  assert.deepEqual(made.selections, ['Selected.']);
  // The voice is built once and shared, not built again for the selection.
  assert.equal(made.engines, 1);
});

test('after a selection, the toolbar icon reads the article again, not the selection', async () => {
  resetFakes();
  const page = makePage();
  page.load();

  await page.readSelection();
  const selection = made.readers[0];
  assert.deepEqual(selection.sentences, [{ text: 'Selected.' }]);

  await page.pressIcon(); // switches the selection off
  assert.equal(selection.state, 'idle');
  await page.pressIcon(); // reads the article

  assert.equal(made.readers.length, 2);
  const article = made.readers[1];
  assert.deepEqual(article.sentences, [{ text: 'One.' }, { text: 'Two.' }]);
  assert.equal(article.state, 'playing');
  assert.equal(selection.voices, 0);
  assert.equal(made.engines, 1);
});

test('a second selection replaces the first', async () => {
  resetFakes();
  const page = makePage();
  page.load();

  await page.readSelection();
  await page.readSelection();

  assert.equal(made.readers.length, 2);
  assert.equal(made.readers[0].state, 'idle');
  assert.equal(made.readers[1].state, 'playing');
  assert.equal(made.bars.filter((bar) => !bar.destroyed).length, 1);
});

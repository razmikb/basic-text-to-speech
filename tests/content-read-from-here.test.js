import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePage } from './helpers/content-page.js';
import { made, resetFakes } from './helpers/content-page-fakes.js';

/**
 * "Read from here", run through the real content.js.
 *
 * It always reads the article. An article already on the page is moved, not rebuilt — its
 * reader and voice are kept — and anything else gives way to a fresh article.
 */

test('with nothing playing, it starts the article at the sentence found', async () => {
  resetFakes();
  const page = makePage();
  page.load();

  await page.readFromHere();

  assert.equal(made.readers.length, 1);
  const [reader] = made.readers;
  assert.equal(reader.from, 1);
  assert.equal(reader.state, 'playing');
  assert.deepEqual(made.points[0].sentences, [{ text: 'One.' }, { text: 'Two.' }]);
});

test('while the article plays, the same reader moves; nothing is rebuilt', async () => {
  resetFakes();
  const page = makePage();
  page.load();

  await page.pressIcon();
  await page.readFromHere();

  assert.equal(made.readers.length, 1);
  assert.equal(made.bars.length, 1);
  assert.equal(made.readers[0].from, 1);
  assert.equal(made.engines, 1);
});

test('after the bar is closed, the article comes back at the sentence found', async () => {
  resetFakes();
  const page = makePage();
  page.load();

  await page.pressIcon();
  await page.pressIcon(); // closes it
  await page.readFromHere();

  assert.equal(made.readers.length, 1);
  assert.equal(made.bars.length, 2);
  assert.equal(made.bars[1].destroyed, false);
  assert.equal(made.readers[0].from, 1);
  assert.equal(made.readers[0].state, 'playing');
});

test('while a selection is being read, it gives way to the article', async () => {
  resetFakes();
  const page = makePage();
  page.load();

  await page.readSelection();
  await page.readFromHere();

  assert.equal(made.readers.length, 2);
  assert.equal(made.readers[0].state, 'idle');
  assert.deepEqual(made.readers[1].sentences, [{ text: 'One.' }, { text: 'Two.' }]);
  assert.equal(made.readers[1].from, 1);
  assert.equal(made.engines, 1);
});

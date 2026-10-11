import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makePage } from './helpers/content-page.js';
import { made, resetFakes } from './helpers/content-page-fakes.js';

/**
 * What the toolbar icon does, by the owner's decision: it switches reading ON and OFF.
 *
 * It used to pause on the second press, which left the bar and highlight on the page for
 * someone who, by pressing the icon again, had said they were done listening. Pausing is
 * still one tap away on the bar itself. So: first press starts, next press stops and takes
 * everything off the page — exactly what the bar's ✕ does — and the press after that starts
 * again with a fresh bar.
 *
 * Runs the real content.js (see helpers/content-page.js).
 */

let page;
beforeEach(() => {
  resetFakes();
  page = makePage();
  page.load();
});

test('the first press starts reading and puts up the bar', async () => {
  await page.pressIcon();
  assert.equal(made.readers[0].state, 'playing');
  assert.equal(made.bars.length, 1);
  assert.equal(made.bars[0].shown, true);
});

test('a second press while reading stops, and takes the bar and highlight off', async () => {
  await page.pressIcon();
  await page.pressIcon();
  assert.equal(made.readers[0].state, 'idle');
  assert.equal(made.bars[0].destroyed, true);
  assert.equal(made.highlighters[0].destroyed, true);
});

test('a press while paused on the bar also stops', async () => {
  await page.pressIcon();
  made.readers[0].pause();
  await page.pressIcon();
  assert.equal(made.readers[0].state, 'idle');
  assert.equal(made.bars[0].destroyed, true);
});

test('the press after stopping starts again with a fresh bar', async () => {
  await page.pressIcon();
  await page.pressIcon();
  await page.pressIcon();
  assert.equal(made.readers[0].state, 'playing');
  assert.equal(made.bars.length, 2);
  assert.equal(made.bars[1].destroyed, false);
});

test('two quick presses while it is still loading leave it stopped, never two voices', async () => {
  const first = page.pressIcon();
  const second = page.pressIcon();
  await Promise.all([first, second]);
  assert.equal(made.readers.length, 1);
  assert.equal(made.readers[0].state, 'idle');
  assert.equal(made.bars[0].destroyed, true);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePage } from './helpers/content-page.js';
import { made, resetFakes } from './helpers/content-page-fakes.js';

/**
 * The bug the owner hit: one press of the toolbar icon and the article is read twice over,
 * by two voices at once.
 *
 * Cause, found in Firefox's own code (ExtensionActions.sys.mjs → activateScripts): on a site
 * the add-on has not been granted outright, pressing the icon makes FIREFOX inject our
 * content script into the page. The click handler runs at the same moment, finds nothing
 * answering yet, and injects the script itself as a fallback. Both copies land in the same
 * page, both listen for the button, and both start reading.
 *
 * So the script must be safe to load twice: the second copy has to step aside. This runs the
 * real content.js twice in one shared scope, which is what Firefox does with the two copies.
 */

test('a second copy of the content script does not answer the toolbar button', () => {
  const page = makePage();
  page.load();
  page.load();
  assert.equal(page.listeners.length, 1);
});

test('loaded twice, one press starts one reader with one voice', async () => {
  resetFakes();
  const page = makePage();
  page.load();
  page.load();
  await page.pressIcon();
  assert.equal(made.readers.length, 1);
  assert.equal(made.readers[0].voices, 1);
  assert.equal(made.bars.length, 1);
});

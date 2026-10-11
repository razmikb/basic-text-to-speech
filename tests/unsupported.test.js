/**
 * Why a page could not be read.
 *
 * The case that matters most is the last one: an ordinary article must never be labelled a
 * PDF or an internal page. Everything here is about a click that has ALREADY failed, so
 * being wrong is not catastrophic — but telling someone their article is a PDF would send
 * them looking in entirely the wrong place.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { explainUnreadable } from '../src/lib/unsupported.js';

test('a PDF is recognised by its address', () => {
  assert.equal(explainUnreadable('https://example.com/paper.pdf').kind, 'pdf');
  assert.equal(explainUnreadable('https://example.com/paper.PDF').kind, 'pdf');
  assert.equal(explainUnreadable('https://example.com/a.pdf?download=1').kind, 'pdf');
  assert.equal(explainUnreadable('https://example.com/a.pdf#page=3').kind, 'pdf');
});

/**
 * The paper that prompted this work. There is no `.pdf` anywhere in the address — it ends
 * `/content` — so a URL-only rule misses it completely and the owner gets the vague
 * "something went wrong" message instead of the true reason. The tab title is what saves
 * it: Firefox names the tab after the file the server declares.
 */
test('a PDF served without .pdf in the address is recognised by the tab title', () => {
  const url =
    'https://scholarspace.manoa.hawaii.edu/server/api/core/bitstreams/' +
    '7e16b9e4-6491-4165-b44a-3e01e5d4caaf/content';

  assert.equal(explainUnreadable(url, '30_01_10125-73712.pdf').kind, 'pdf');
});

test("Firefox's own viewer address is recognised", () => {
  assert.equal(explainUnreadable('resource://pdf.js/web/viewer.html').kind, 'pdf');
});

test("Firefox's own pages are named as such", () => {
  assert.equal(explainUnreadable('about:config').kind, 'internal');
  assert.equal(explainUnreadable('about:debugging#/runtime/this-firefox').kind, 'internal');
  assert.equal(explainUnreadable('view-source:https://example.com/').kind, 'internal');
});

/** Our own settings page. Pressing the button there is a natural thing to try. */
test('the add-on’s own pages are named as Firefox pages', () => {
  assert.equal(
    explainUnreadable('moz-extension://abc-123/settings/settings.html').kind,
    'internal'
  );
});

test('Mozilla’s own sites are named separately', () => {
  assert.equal(explainUnreadable('https://addons.mozilla.org/en-GB/firefox/').kind, 'mozilla');
});

/**
 * The false-positive guard, and the reason the PDF rule is written as `\.pdf` at the end of
 * a path rather than a bare search for "pdf". An article ABOUT PDFs, or one whose publisher
 * has "pdf" in a path segment, is still an article.
 */
test('an ordinary article is never mislabelled', () => {
  const ordinary = [
    'https://example.com/article',
    'https://www.edutopia.org/article/will-these-6-sneaky-charts-deceive-your-students',
    'https://example.com/how-to-read-a-pdf-properly',
    'https://example.com/pdfs/guide',
  ];

  for (const url of ordinary) {
    const result = explainUnreadable(url, 'How to read a PDF properly');
    assert.equal(result.kind, 'unknown', `${url} should not be a known limitation`);
    assert.notEqual(result.kind, 'pdf');
  }
});

/**
 * An unexpected failure must not be dressed up as a known limitation. This is the case
 * where something may genuinely be broken, and saying "this is normal" would hide it.
 */
test('an unexplained failure says so honestly', () => {
  const result = explainUnreadable('https://example.com/article');
  assert.equal(result.kind, 'unknown');
  assert.match(result.summary, /unusual/i);
});

test('every explanation is complete enough to show', () => {
  const urls = [
    'https://example.com/paper.pdf',
    'about:config',
    'https://addons.mozilla.org/',
    'https://example.com/article',
  ];

  for (const url of urls) {
    const result = explainUnreadable(url);
    assert.ok(result.badge.length > 0 && result.badge.length <= 2, `${url} badge`);
    assert.ok(result.tooltip.length > 0, `${url} tooltip`);
    assert.ok(result.summary.length > 0, `${url} summary`);
  }
});

/** Called after a failure, possibly with nothing useful to hand. It must not throw. */
test('missing or odd input does not throw', () => {
  assert.equal(explainUnreadable(undefined).kind, 'unknown');
  assert.equal(explainUnreadable('').kind, 'unknown');
  assert.equal(explainUnreadable(null, null).kind, 'unknown');
  assert.equal(explainUnreadable(42, {}).kind, 'unknown');
});

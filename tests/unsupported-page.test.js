import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { explainUnreadable } from '../src/lib/unsupported.js';

/**
 * The explanation page has a section for every kind of failure.
 *
 * One page answers for PDFs, Firefox's own pages, Mozilla's site and the unexpected case,
 * and it picks the right section by id. Nothing connects the ids in the HTML to the kinds
 * in `explainUnreadable` except this test — rename either side and the page would quietly
 * show a heading with no explanation under it, which is the failure this whole change
 * exists to remove.
 */

const page = readFileSync(new URL('../src/unsupported.html', import.meta.url), 'utf8');

const EVERY_KIND = [
  ['https://example.com/paper.pdf', '', 'pdf'],
  ['about:config', '', 'internal'],
  ['https://addons.mozilla.org/', '', 'mozilla'],
  ['https://example.com/article', '', 'unknown'],
];

test('every kind of failure has something to show', () => {
  const { document } = parseHTML(page);

  for (const [url, title, expected] of EVERY_KIND) {
    const { kind, summary } = explainUnreadable(url, title);
    assert.equal(kind, expected);

    const detail = document.getElementById(`${kind}-detail`);
    assert.ok(detail, `no section on the page for "${kind}"`);
    assert.ok(summary.length > 0, `nothing to say for "${kind}"`);
  }
});

test('the page has the pieces its script fills in', () => {
  const { document } = parseHTML(page);

  assert.ok(document.getElementById('summary'), 'the one-line summary');
  assert.ok(document.getElementById('address'), 'the failed address');
});

/** Every section starts hidden, so only the relevant one is ever revealed. */
test('the sections are hidden until one is chosen', () => {
  const { document } = parseHTML(page);

  for (const [, , kind] of EVERY_KIND) {
    const detail = document.getElementById(`${kind}-detail`);
    assert.ok(detail.hasAttribute('hidden'), `"${kind}" must start hidden`);
  }
});

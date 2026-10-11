import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractArticle, normalizeWhitespace } from '../src/lib/extractor.js';
import { el, fakeDocument } from './helpers/fake-dom.js';

const P1 = 'The council voted on Tuesday to approve the new bridge across the river.';
const P2 = 'Construction is expected to begin in the spring and last about two years.';

const textsOf = (doc) => extractArticle(doc).blocks.map((block) => block.text);

test('reads the paragraphs of an article', () => {
  const doc = fakeDocument([el('article', {}, [el('p', P1), el('p', P2)])]);
  assert.deepEqual(textsOf(doc), [P1, P2]);
});

test('skips the navigation and the footer', () => {
  const doc = fakeDocument([
    el('nav', {}, [el('p', 'Home About Contact Subscribe Login Search the site archive')]),
    el('article', {}, [el('p', P1)]),
    el('footer', {}, [el('p', 'Copyright 2026 Example News. All rights reserved worldwide.')]),
  ]);
  assert.deepEqual(textsOf(doc), [P1]);
});

test('skips a cookie banner and a related-stories sidebar', () => {
  const doc = fakeDocument([
    el('div', { class: 'cookie-consent' }, [
      el('p', 'We use cookies to improve your experience on this website. Accept all?'),
    ]),
    el('article', {}, [
      el('p', P1),
      el('div', { class: 'related-stories' }, [
        el('p', 'You might also like: ten things about bridges you never wanted to know.'),
      ]),
    ]),
  ]);
  assert.deepEqual(textsOf(doc), [P1]);
});

test('picks the real article over a link-heavy sidebar', () => {
  const doc = fakeDocument([
    el('div', { class: 'sidebar' }, [el('p', 'Latest headlines from around the world today.')]),
    el('main', {}, [el('p', P1), el('p', P2)]),
  ]);
  assert.deepEqual(textsOf(doc), [P1, P2]);
});

test('keeps headings even though they are short', () => {
  const doc = fakeDocument([el('article', {}, [el('h1', 'The Bridge'), el('p', P1)])]);
  assert.deepEqual(textsOf(doc), ['The Bridge', P1]);
});

test('drops short fragments that are captions or buttons, not prose', () => {
  const doc = fakeDocument([el('article', {}, [el('p', P1), el('p', 'Share this')])]);
  assert.deepEqual(textsOf(doc), [P1]);
});

test('keeps a short paragraph that is a whole sentence', () => {
  // A rhetorical one-liner is real prose. Judging by length alone dropped these.
  const doc = fakeDocument([el('article', {}, [el('p', P1), el('p', 'Perhaps you haven’t.')])]);
  assert.deepEqual(textsOf(doc), [P1, 'Perhaps you haven’t.']);
});

test('keeps a short pull quote despite its closing quotation mark', () => {
  const doc = fakeDocument([
    el('article', {}, [el('p', P1), el('p', '“Do not obey in advance.”')]),
  ]);
  assert.deepEqual(textsOf(doc), [P1, '“Do not obey in advance.”']);
});

test('still drops a short fragment with no sentence ending', () => {
  // Substack's empty-feed widget: eight characters and no full stop.
  const doc = fakeDocument([el('article', {}, [el('p', P1), el('p', 'No posts')])]);
  assert.deepEqual(textsOf(doc), [P1]);
});

test('reads the title out of the header that wraps it', () => {
  // Ghost puts the title in <header class="gh-article-header"> beside the byline. HEADER is
  // excluded furniture, so the title was being thrown away on exactly such sites.
  const doc = fakeDocument([
    el('article', {}, [
      el('header', {}, [el('h1', 'The Bridge'), el('h4', 'By Jane Doe')]),
      el('p', P1),
    ]),
  ]);
  assert.deepEqual(textsOf(doc), ['The Bridge', P1]);
});

test('the title exemption does not let the site navigation in', () => {
  // The same page has a second header — the site nav — which must stay out.
  const doc = fakeDocument([
    el('header', { class: 'site-nav' }, [el('p', 'Home About Sign in Subscribe to the list')]),
    el('article', {}, [el('header', {}, [el('h1', 'The Bridge')]), el('p', P1), el('p', P2)]),
  ]);
  assert.deepEqual(textsOf(doc), ['The Bridge', P1, P2]);
});

test('does not read hidden text', () => {
  const doc = fakeDocument([
    el('article', {}, [
      el('p', P1),
      el('p', { 'aria-hidden': 'true' }, ['Screen reader skip link that should never be spoken.']),
      el('p', { style: 'display: none' }, ['An off-screen menu full of text nobody can see.']),
    ]),
  ]);
  assert.deepEqual(textsOf(doc), [P1]);
});

test('does not read code blocks', () => {
  const doc = fakeDocument([
    el('article', {}, [
      el('p', P1),
      el('pre', {}, [el('code', 'const x = 1; // not prose at all')]),
    ]),
  ]);
  assert.deepEqual(textsOf(doc), [P1]);
});

test('reads list items that are long enough to be prose', () => {
  const doc = fakeDocument([
    el('article', {}, [
      el('p', P1),
      el('ul', {}, [
        el('li', 'The first reason the bridge matters is that it shortens the commute.'),
      ]),
    ]),
  ]);
  assert.equal(textsOf(doc).length, 2);
});

test('finds the title from the first heading', () => {
  const doc = fakeDocument([el('article', {}, [el('h1', 'The Bridge'), el('p', P1)])], {
    title: 'The Bridge | Example News',
  });
  assert.equal(extractArticle(doc).title, 'The Bridge');
});

test('falls back to the page title without the site name', () => {
  const doc = fakeDocument([el('article', {}, [el('p', P1)])], {
    title: 'The Bridge | Example News',
  });
  assert.equal(extractArticle(doc).title, 'The Bridge');
});

test('returns nothing rather than failing on a page with no article', () => {
  const doc = fakeDocument([el('nav', {}, [el('p', 'Home About Contact Login Search Archive')])]);
  assert.deepEqual(extractArticle(doc).blocks, []);
});

test('collapses the whitespace of source HTML', () => {
  assert.equal(normalizeWhitespace('  The   bridge\n\n  opened.  '), 'The bridge opened.');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createHighlighter } from '../src/lib/highlighter.js';
import { extractArticle, normalizeWhitespace } from '../src/lib/extractor.js';
import { buildSentences } from '../src/lib/reader.js';
import { DEFAULTS } from '../src/lib/config.js';
import { needsPages, loadPage } from './helpers/pages.js';

/**
 * Tests for marking the spoken sentence on the page.
 *
 * The rule these exist to defend is "the page is not ours": we may wrap the article's
 * text but never change it, and everything we add must come off again leaving the page
 * exactly as we found it. The strongest test here is the last one — highlight every
 * sentence of a real article in turn, then compare the whole document to how it started.
 */

const documentFrom = (html) => parseHTML(`<html><head></head><body>${html}</body></html>`).document;

/** A highlighter over a hand-written page, with the browser half stubbed out. */
function setup(html, config = {}, textColorOf = undefined) {
  const doc = documentFrom(html);
  const { blocks } = extractArticle(doc);
  const sentences = buildSentences(blocks);
  const highlighter = createHighlighter({
    doc,
    blocks,
    config: { ...DEFAULTS, ...config },
    viewport: null,
    textColorOf,
  });
  return { doc, blocks, sentences, highlighter };
}

const marked = (doc) => [...doc.querySelectorAll('.ftts-sentence')];
const markedText = (doc) =>
  marked(doc)
    .map((span) => span.textContent)
    .join('');

const LONG = 'This paragraph has to be long enough that the extractor treats it as prose. ';

test('marks the sentence being spoken', () => {
  const { doc, sentences, highlighter } = setup(
    `<article><p>${LONG}And a second one here.</p></article>`
  );

  assert.equal(highlighter.show(sentences[0]), true);
  assert.equal(markedText(doc), sentences[0].text);
});

test('a sentence spanning nested tags is marked in full', () => {
  const html = `<article><p>He said <b>it was <a href="x">very</a> good</b>. ${LONG}</p></article>`;
  const { doc, sentences, highlighter } = setup(html);

  assert.equal(highlighter.show(sentences[0]), true);
  assert.ok(marked(doc).length > 1, 'a sentence crossing tags needs more than one span');
  assert.equal(normalizeWhitespace(markedText(doc)), 'He said it was very good.');
});

test('the article text itself is never altered', () => {
  const html = `<article><p>He said <b>it was <a href="x">very</a> good</b>. ${LONG}</p></article>`;
  const { doc, sentences, highlighter } = setup(html);
  const before = doc.querySelector('p').textContent;

  highlighter.show(sentences[0]);

  assert.equal(doc.querySelector('p').textContent, before);
});

test('clearing puts the page back exactly as it was', () => {
  const html = `<article><p>He said <b>it was <a href="x">very</a> good</b>. ${LONG}</p></article>`;
  const { doc, sentences, highlighter } = setup(html);
  const before = doc.querySelector('p').outerHTML;

  highlighter.show(sentences[0]);
  assert.notEqual(doc.querySelector('p').outerHTML, before, 'nothing was actually marked');

  highlighter.clear();
  assert.equal(doc.querySelector('p').outerHTML, before);
});

test('removal rejoins the text nodes it split, not just the visible markup', () => {
  // outerHTML cannot see this: "one two" serialises identically whether it is one text
  // node or three. But a site walking its own DOM would find a shape it never built, so
  // the node count is asserted directly. Without normalize() this is the only test that
  // fails, which is exactly why it is here.
  const { doc, sentences, highlighter } = setup(
    `<article><p>${LONG}Second sentence here. ${LONG}</p></article>`
  );
  const countTextNodes = () => {
    const walker = doc.createTreeWalker(doc.querySelector('p'), 4);
    let count = 0;
    while (walker.nextNode()) count += 1;
    return count;
  };
  const before = countTextNodes();

  highlighter.show(sentences[1]);
  assert.ok(countTextNodes() > before, 'marking the sentence must split the text node');

  highlighter.clear();
  assert.equal(countTextNodes(), before, 'the split text nodes were left behind');
});

test('a highlight starting and ending mid-text-node is removed cleanly', () => {
  const { doc, sentences, highlighter } = setup(
    `<article><p>${LONG}Second sentence here. ${LONG}</p></article>`
  );
  const before = doc.querySelector('p').outerHTML;

  highlighter.show(sentences[1]);
  assert.equal(markedText(doc), sentences[1].text);

  highlighter.clear();
  assert.equal(doc.querySelector('p').outerHTML, before);
});

test('showing a second sentence unmarks the first', () => {
  const { doc, sentences, highlighter } = setup(
    `<article><p>${LONG}And a second one here.</p></article>`
  );
  const before = doc.querySelector('p').outerHTML;

  highlighter.show(sentences[0]);
  highlighter.show(sentences[1]);

  assert.equal(markedText(doc), sentences[1].text);

  highlighter.clear();
  assert.equal(doc.querySelector('p').outerHTML, before);
});

test('the stylesheet is added on first use, not before, and namespaced', () => {
  const { doc, sentences, highlighter } = setup(`<article><p>${LONG}</p></article>`);

  assert.equal(doc.getElementById('ftts-highlight-style'), null, 'nothing before playing');

  highlighter.show(sentences[0]);
  const style = doc.getElementById('ftts-highlight-style');
  assert.ok(style, 'the highlight needs its stylesheet');
  assert.match(style.textContent, /\.ftts-sentence/);
  // Every selector we add to the page must be ours and obviously ours.
  assert.doesNotMatch(style.textContent.replace(/\.ftts-[a-z-]+/g, ''), /\.[a-z]/i);
});

test('the highlight wrapper sheds whatever a site does to spans in general', () => {
  // The Duolingo blog underlines every `p:has(span) > span` in dashed blue and makes it an
  // inline-block, and our wrapper is a span. Only a browser can show the cascade, so what
  // is checked is that the reset comes first and every later line outranks the site too.
  const { doc, sentences, highlighter } = setup(`<article><p>${LONG}</p></article>`);
  highlighter.show(sentences[0]);

  const rule = /\.ftts-sentence \{([^}]*)\}/.exec(
    doc.getElementById('ftts-highlight-style').textContent
  )[1];
  const lines = rule
    .split(';')
    .map((line) => line.trim())
    .filter(Boolean);

  assert.equal(lines[0], 'all: unset !important');
  for (const line of lines) assert.match(line, /!important$/, `${line} would lose to the site`);
});

test('the highlight is an element no site stylesheet can name', () => {
  // Duolingo pads any paragraph holding a span, `p:has(span:not(.pcontent))`, so a span
  // wrapper made the paragraph being read jump down and in. That rule styles the site's
  // own paragraph, which we must not touch; the fix is not to be a span.
  const { doc, sentences, highlighter } = setup(`<article><p>${LONG}</p></article>`);
  highlighter.show(sentences[0]);

  assert.ok(marked(doc).length > 0);
  for (const wrapper of marked(doc)) assert.equal(wrapper.tagName, 'FTTS-MARK');
});

test('the colour reaches the page as a property, never as stylesheet text', () => {
  const { doc, sentences, highlighter } = setup(`<article><p>${LONG}</p></article>`, {
    highlightColor: 'rgb(1,2,3)',
  });

  highlighter.show(sentences[0]);

  assert.equal(doc.documentElement.style.getPropertyValue('--ftts-highlight'), 'rgb(1,2,3)');
  assert.doesNotMatch(doc.getElementById('ftts-highlight-style').textContent, /rgb\(1,2,3\)/);
});

test('the stylesheet comes back if the site wipes the head', () => {
  const { doc, sentences, highlighter } = setup(
    `<article><p>${LONG}And a second one here.</p></article>`
  );

  highlighter.show(sentences[0]);
  doc.getElementById('ftts-highlight-style').remove();

  highlighter.show(sentences[1]);
  assert.ok(doc.getElementById('ftts-highlight-style'), 'a single-page app must not disarm us');
});

test('destroy removes every trace, and is safe to call twice', () => {
  const { doc, sentences, highlighter } = setup(`<article><p>${LONG}</p></article>`);
  const before = doc.body.outerHTML;

  highlighter.show(sentences[0]);
  highlighter.destroy();
  highlighter.destroy();

  assert.equal(doc.getElementById('ftts-highlight-style'), null);
  assert.equal(doc.documentElement.style.getPropertyValue('--ftts-highlight'), '');
  assert.equal(marked(doc).length, 0);
  assert.equal(doc.body.outerHTML, before);
});

test('nothing is marked after destroy', () => {
  const { doc, sentences, highlighter } = setup(`<article><p>${LONG}</p></article>`);

  highlighter.destroy();

  assert.equal(highlighter.show(sentences[0]), false);
  assert.equal(marked(doc).length, 0);
});

test('a paragraph the site has removed is skipped, not fatal', () => {
  const { doc, blocks, sentences, highlighter } = setup(`<article><p>${LONG}</p></article>`);
  const before = doc.body.outerHTML;

  blocks[0].element.remove();

  assert.equal(highlighter.show(sentences[0]), false);
  assert.notEqual(doc.body.outerHTML, before); // the site's own removal, not ours
  assert.equal(marked(doc).length, 0);
});

test('a paragraph the site has rewritten is skipped, not mismarked', () => {
  const { doc, blocks, sentences, highlighter } = setup(`<article><p>${LONG}</p></article>`);

  blocks[0].element.textContent = 'Something else entirely now.';

  assert.equal(highlighter.show(sentences[0]), false);
  assert.equal(marked(doc).length, 0);
  assert.equal(doc.querySelector('p').textContent, 'Something else entirely now.');
});

test('a mark the site has torn out does not break clearing', () => {
  const { doc, sentences, highlighter } = setup(`<article><p>${LONG}</p></article>`);

  highlighter.show(sentences[0]);
  marked(doc).forEach((span) => span.remove());

  highlighter.clear();
  assert.equal(highlighter.getActiveCount(), 0);
});

test('a whole real article can be read through, leaving no trace', needsPages, () => {
  const doc = loadPage('substack-cognitive-resonance');
  const { blocks } = extractArticle(doc);
  const sentences = buildSentences(blocks);
  const before = doc.body.outerHTML;

  const highlighter = createHighlighter({
    doc,
    blocks,
    config: DEFAULTS,
    viewport: null,
  });

  let missed = 0;
  for (const sentence of sentences) {
    if (!highlighter.show(sentence)) missed += 1;
    else assert.equal(normalizeWhitespace(markedText(doc)), sentence.text);
  }

  assert.equal(missed, 0, `${missed} of ${sentences.length} sentences could not be marked`);
  assert.ok(sentences.length > 100, 'expected a full-length article');

  highlighter.destroy();
  assert.equal(doc.body.outerHTML, before, 'the page was not left exactly as it was found');
});

/*
 * Dark pages. Stanford Report in dark mode writes white text, and white on the light-yellow
 * highlight could not be read. The colour of the text decides, not a guess at the page's
 * background: backgrounds are often transparent all the way up, or an image, while the
 * text colour is always known exactly and is the thing that has to stay readable.
 */
const onDark = (doc) => marked(doc).every((span) => span.classList.contains('ftts-on-dark'));
const anyOnDark = (doc) => marked(doc).some((span) => span.classList.contains('ftts-on-dark'));

test('light text gets the dark highlight', () => {
  const { doc, sentences, highlighter } = setup(
    `<article><p>${LONG}</p></article>`,
    {},
    () => 'rgb(255, 255, 255)'
  );

  highlighter.show(sentences[0]);
  assert.ok(marked(doc).length > 0);
  assert.ok(onDark(doc), 'white text on light yellow cannot be read');
});

test('dark text keeps the light highlight', () => {
  const { doc, sentences, highlighter } = setup(
    `<article><p>${LONG}</p></article>`,
    {},
    () => 'rgb(33, 33, 33)'
  );

  highlighter.show(sentences[0]);
  assert.ok(marked(doc).length > 0);
  assert.ok(!anyOnDark(doc));
});

test('mid-grey text goes to whichever highlight it reads better on', () => {
  // Decided by contrast against the two actual highlight colours, not by a fixed cut-off,
  // so changing either colour in the settings moves the choice with it.
  const light = setup(`<article><p>${LONG}</p></article>`, {}, () => 'rgb(200, 200, 200)');
  light.highlighter.show(light.sentences[0]);
  assert.ok(onDark(light.doc), 'light grey reads better on the dark highlight');

  const dark = setup(`<article><p>${LONG}</p></article>`, {}, () => 'rgb(90, 90, 90)');
  dark.highlighter.show(dark.sentences[0]);
  assert.ok(!anyOnDark(dark.doc), 'dark grey reads better on the light highlight');
});

test('the check is made per sentence, so a page that changes theme is followed', () => {
  let color = 'rgb(20, 20, 20)';
  const { doc, sentences, highlighter } = setup(
    `<article><p>${LONG}And a second one here.</p></article>`,
    {},
    () => color
  );

  highlighter.show(sentences[0]);
  assert.ok(!anyOnDark(doc));

  color = 'rgb(240, 240, 240)'; // the reader switched the site to dark mode mid-article
  highlighter.show(sentences[1]);
  assert.ok(onDark(doc));
});

test('a text colour that cannot be read leaves the ordinary highlight', () => {
  for (const answer of [
    () => '',
    () => 'color(display-p3 1 1 1)',
    () => {
      throw new Error('no');
    },
  ]) {
    const { doc, sentences, highlighter } = setup(`<article><p>${LONG}</p></article>`, {}, answer);
    assert.equal(highlighter.show(sentences[0]), true, 'a failed check must not stop the mark');
    assert.ok(!anyOnDark(doc));
  }
});

test('a text colour chosen in the settings decides instead of the site', () => {
  // If the user forces black text inside the highlight, the site's white text no longer
  // matters: black on the light highlight is what will actually be on screen.
  const { doc, sentences, highlighter } = setup(
    `<article><p>${LONG}</p></article>`,
    { highlightTextColor: '#000000' },
    () => 'rgb(255, 255, 255)'
  );

  highlighter.show(sentences[0]);
  assert.ok(!anyOnDark(doc));
});

test('the dark colour reaches the page as a property and leaves with the rest', () => {
  const { doc, sentences, highlighter } = setup(
    `<article><p>${LONG}</p></article>`,
    { highlightColorDark: 'rgb(4,5,6)' },
    () => 'rgb(255, 255, 255)'
  );

  highlighter.show(sentences[0]);
  assert.equal(doc.documentElement.style.getPropertyValue('--ftts-highlight-dark'), 'rgb(4,5,6)');
  assert.doesNotMatch(doc.getElementById('ftts-highlight-style').textContent, /rgb\(4,5,6\)/);

  highlighter.destroy();
  assert.equal(doc.documentElement.style.getPropertyValue('--ftts-highlight-dark'), '');
});

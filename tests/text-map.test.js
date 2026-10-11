import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { buildRuns, mapRange } from '../src/lib/text-map.js';
import { extractArticle, normalizeWhitespace } from '../src/lib/extractor.js';
import { buildSentences } from '../src/lib/reader.js';
import { needsPages, loadPage } from './helpers/pages.js';

/**
 * Tests for the offset mapping.
 *
 * This is arithmetic that is easy to get wrong by one and hard to notice: an off-by-one
 * puts the highlight half a word out, which looks like a rendering quirk rather than a
 * bug. So it is tested exhaustively rather than by example — every offset of every block
 * of four real articles, roughly 35,000 assertions, against the real normalizer. The
 * fourth, the Duolingo blog, is there for its `<br>`s.
 */

const FIXTURES = ['substack-cognitive-resonance', 'chalkbeat', 'substack-dtw', 'duolingo-blog'];

/** Build a one-paragraph document, the quick way to write an edge case. */
const paragraph = (html) =>
  parseHTML(`<html><body>${html}</body></html>`).document.querySelector('p');

/** The raw text a mapped range actually covers on the page. */
const covered = (slices) => slices.map(({ node, from, to }) => node.data.slice(from, to)).join('');

test(
  'the mapping reproduces the extractor normalizer exactly, on real articles',
  needsPages,
  () => {
    let blocks = 0;
    for (const name of FIXTURES) {
      for (const block of extractArticle(loadPage(name)).blocks) {
        const { normalized } = buildRuns(block.element);
        assert.equal(normalized, block.text, `block ${blocks} of ${name} normalized differently`);
        blocks += 1;
      }
    }
    assert.ok(blocks > 100, `expected the fixtures to yield real articles, got ${blocks} blocks`);
  }
);

test('every offset of every real block resolves to the right character', needsPages, () => {
  let checks = 0;
  for (const name of FIXTURES) {
    for (const block of extractArticle(loadPage(name)).blocks) {
      const { runs, normalized } = buildRuns(block.element);

      // Runs must tile the normalized text: contiguous, no gaps, no overlaps.
      let expectedStart = 0;
      for (const run of runs) {
        assert.equal(run.normStart, expectedStart, `runs are not contiguous in ${name}`);
        expectedStart += run.length;
      }
      assert.equal(expectedStart, normalized.length, `runs do not cover the text in ${name}`);

      for (const run of runs) {
        if (run.node === null) {
          // The space a <br> stands for: one space, and nothing on the page to check.
          assert.equal(normalized.slice(run.normStart, run.normStart + run.length), ' ');
          checks += 1;
          continue;
        }
        for (let k = 0; k < run.length; k += 1) {
          const raw = run.node.data[run.nodeOffset + k];
          const want = normalized[run.normStart + k];
          // A collapsed space stands in for whatever whitespace was actually there.
          if (want === ' ') assert.match(raw, /\s/);
          else assert.equal(raw, want);
          checks += 1;
        }
      }
    }
  }
  assert.ok(checks > 30000, `expected exhaustive coverage, only made ${checks} checks`);
});

test('every real sentence maps back to its own text', needsPages, () => {
  for (const name of FIXTURES) {
    const { blocks } = extractArticle(loadPage(name));
    for (const sentence of buildSentences(blocks)) {
      const block = blocks[sentence.blockIndex];
      const slices = mapRange(block.element, sentence.start, sentence.end, block.text);
      assert.ok(slices, `sentence "${sentence.text.slice(0, 40)}" did not map in ${name}`);
      assert.equal(normalizeWhitespace(covered(slices)), sentence.text);
    }
  }
});

test('leading whitespace is dropped, not collapsed', () => {
  // trim() removes it outright, so offset 0 is the H of Hello, three characters in.
  const element = paragraph('<p>   Hello world.</p>');
  const { normalized, runs } = buildRuns(element);
  assert.equal(normalized, 'Hello world.');
  assert.equal(runs[0].nodeOffset, 3);
  assert.equal(runs[0].normStart, 0);
});

test('trailing whitespace is dropped', () => {
  const element = paragraph('<p>Hello world.   </p>');
  const { normalized } = buildRuns(element);
  assert.equal(normalized, 'Hello world.');
  const slices = mapRange(element, 0, 12, 'Hello world.');
  assert.equal(covered(slices), 'Hello world.');
});

test('a run of whitespace collapses to one space', () => {
  const element = paragraph('<p>Hello \n\n   world.</p>');
  const { normalized } = buildRuns(element);
  assert.equal(normalized, 'Hello world.');
  // "world." starts at offset 6 in the tidy text and offset 11 in the real one.
  const slices = mapRange(element, 6, 12, 'Hello world.');
  assert.equal(covered(slices), 'world.');
  assert.equal(slices[0].from, 11);
});

test('whitespace collapsing across text nodes anchors to where it began', () => {
  const element = paragraph('<p>Hello <b>  </b>  world.</p>');
  const { normalized } = buildRuns(element);
  assert.equal(normalized, 'Hello world.');
  const slices = mapRange(element, 0, 12, 'Hello world.');
  assert.equal(normalizeWhitespace(covered(slices)), 'Hello world.');
});

test('a non-breaking space collapses exactly as the extractor collapses it', () => {
  const element = paragraph('<p>a b</p>');
  const { normalized } = buildRuns(element);
  assert.equal(normalized, 'a b');
  assert.equal(normalized, normalizeWhitespace(element.textContent));
  const slices = mapRange(element, 0, 3, 'a b');
  assert.equal(covered(slices), 'a b');
});

test('adjacent inline tags with no space between are separate slices', () => {
  const element = paragraph('<p><b>Hello</b><i>World</i></p>');
  const { normalized } = buildRuns(element);
  assert.equal(normalized, 'HelloWorld');
  const slices = mapRange(element, 0, 10, 'HelloWorld');
  assert.equal(slices.length, 2);
  assert.equal(covered(slices), 'HelloWorld');
});

test('a sentence spanning nested tags covers every piece of it', () => {
  const element = paragraph('<p>He said <b>it was <a href="x">very</a> good</b>. Then left.</p>');
  const text = normalizeWhitespace(element.textContent);
  const slices = mapRange(element, 0, text.indexOf('.') + 1, text);
  assert.equal(covered(slices), 'He said it was very good.');
  assert.ok(slices.length > 1, 'a sentence crossing tags must map to several text nodes');
});

test('a line break reads as a space, so the words either side stay apart', () => {
  // Duolingo: <strong>Question?</strong><br>Answer. was one sentence, "Question?Answer."
  const element = paragraph('<p><strong>Why?</strong><br>Because.</p>');
  assert.equal(buildRuns(element).normalized, 'Why? Because.');

  const slices = mapRange(element, 5, 13, 'Why? Because.');
  assert.equal(covered(slices), 'Because.', 'the answer is marked from its first letter');
  assert.equal(covered(mapRange(element, 0, 13, 'Why? Because.')), 'Why?Because.');
});

test('a line break next to real whitespace still makes only one space', () => {
  assert.equal(buildRuns(paragraph('<p>one <br> two</p>')).normalized, 'one two');
  assert.equal(buildRuns(paragraph('<p>one<br><br>two</p>')).normalized, 'one two');
  assert.equal(buildRuns(paragraph('<p><br>one<br></p>')).normalized, 'one');
});

test('comments contribute no characters', () => {
  const element = paragraph('<p>one<!-- hidden -->two</p>');
  assert.equal(buildRuns(element).normalized, 'onetwo');
});

test('refuses to map when the page text has changed underneath', () => {
  const element = paragraph('<p>Hello world.</p>');
  assert.equal(mapRange(element, 0, 5, 'Something else entirely.'), null);
});

test('refuses nonsense ranges rather than guessing', () => {
  const element = paragraph('<p>Hello world.</p>');
  assert.equal(mapRange(element, 5, 5, 'Hello world.'), null);
  assert.equal(mapRange(element, 8, 3, 'Hello world.'), null);
  assert.equal(mapRange(element, -1, 4, 'Hello world.'), null);
  assert.equal(mapRange(element, 0, 999, 'Hello world.'), null);
  assert.equal(mapRange(null, 0, 4, 'Hello world.'), null);
});

test('an empty block maps to nothing rather than throwing', () => {
  const element = paragraph('<p>   </p>');
  assert.equal(buildRuns(element).normalized, '');
  assert.equal(mapRange(element, 0, 1, ''), null);
});

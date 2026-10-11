import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { readSelection, sentenceAt } from '../src/lib/selection.js';
import { mapRange } from '../src/lib/text-map.js';
import { buildSentences } from '../src/lib/reader.js';

/**
 * Tests for reading a selection.
 *
 * What matters is that exactly the selected words are read, and that each sentence points at
 * the same characters the highlighter will mark — so every case below also resolves its
 * sentences back onto the page and checks the marked text.
 */

function page(body) {
  const { document } = parseHTML(`<html><head></head><body>${body}</body></html>`);
  return document;
}

/** A selection of one range, the shape the browser hands over. */
function select(startContainer, startOffset, endContainer, endOffset) {
  return {
    rangeCount: 1,
    getRangeAt: () => ({ startContainer, startOffset, endContainer, endOffset }),
  };
}

const textOf = (element) => element.firstChild;

/** The words the highlighter would mark for each sentence. */
function marked({ blocks, sentences }) {
  return sentences.map((sentence) => {
    const block = blocks[sentence.blockIndex];
    const slices = mapRange(block.element, sentence.start, sentence.end, block.text);
    return slices.map(({ node, from, to }) => node.data.slice(from, to)).join('');
  });
}

test('reads from the middle of a paragraph to where the selection ends', () => {
  const doc = page('<p id="a">One two. Three four. Five six.</p>');
  const text = textOf(doc.getElementById('a'));
  const found = readSelection(doc, select(text, 9, text, 20));

  assert.deepEqual(
    found.sentences.map((s) => s.text),
    ['Three four.']
  );
  assert.deepEqual(marked(found), ['Three four.']);
});

test('a selection that starts or ends mid-sentence reads just the selected words', () => {
  const doc = page('<p id="a">The quick brown fox jumps.</p>');
  const text = textOf(doc.getElementById('a'));
  const found = readSelection(doc, select(text, 4, text, 15));

  assert.deepEqual(marked(found), ['quick brown']);
});

test('across paragraphs, each paragraph is its own block', () => {
  const doc = page('<p id="a">First one. First two.</p><p id="b">Second one. Second two.</p>');
  const a = textOf(doc.getElementById('a'));
  const b = textOf(doc.getElementById('b'));
  const found = readSelection(doc, select(a, 11, b, 11));

  assert.equal(found.blocks.length, 2);
  assert.deepEqual(marked(found), ['First two.', 'Second one.']);
  assert.deepEqual(
    found.sentences.map((s) => s.blockIndex),
    [0, 1]
  );
});

test('inline markup inside a paragraph stays one block', () => {
  const doc = page('<p id="a">Hello <b>big</b> <a href="#">wide</a> world. Next.</p>');
  const bold = doc.querySelector('b').firstChild;
  const last = doc.getElementById('a').lastChild;
  const found = readSelection(doc, select(bold, 0, last, last.data.indexOf('.') + 1));

  assert.equal(found.blocks.length, 1);
  assert.deepEqual(marked(found), ['big wide world.']);
});

test('a triple-click selection, ending at the start of the next paragraph, reads one paragraph', () => {
  const doc = page('<p id="a">Only this one.</p><p id="b">Not this.</p>');
  const a = doc.getElementById('a');
  const b = doc.getElementById('b');
  const found = readSelection(doc, select(a, 0, b, 0));

  assert.deepEqual(marked(found), ['Only this one.']);
});

test('code, hidden text and our own bar are never read', () => {
  const doc = page(
    '<div id="w"><p id="a">Read me.</p><script>var x = 1;</script>' +
      '<p hidden>Hidden text.</p><div class="ftts-controls">speaking</div>' +
      '<p id="b">And me.</p></div>'
  );
  const w = doc.getElementById('w');
  const found = readSelection(doc, select(w, 0, w, w.childNodes.length));

  assert.deepEqual(marked(found), ['Read me.', 'And me.']);
});

test('text inside our sentence highlight is still read', () => {
  const doc = page('<p id="a">Before. <ftts-mark class="ftts-sentence">Marked.</ftts-mark></p>');
  const a = doc.getElementById('a');
  const found = readSelection(doc, select(a, 0, a, a.childNodes.length));

  assert.deepEqual(
    found.sentences.map((s) => s.text),
    ['Before.', 'Marked.']
  );
});

test('with nothing findable on the page, the browser’s copy of the text is read unhighlighted', () => {
  const doc = page('<p>Page.</p>');
  const found = readSelection(doc, { rangeCount: 0 }, '  Typed into   a box. Second.  ');

  assert.deepEqual(
    found.sentences.map((s) => s.text),
    ['Typed into a box.', 'Second.']
  );
  assert.equal(found.blocks[0].element, null);
});

test('a backwards range reads nothing rather than the rest of the page', () => {
  const doc = page('<p id="a">One.</p><p id="b">Two.</p><p>Three.</p>');
  const a = textOf(doc.getElementById('a'));
  const b = textOf(doc.getElementById('b'));
  const found = readSelection(doc, select(b, 0, a, 4));

  assert.deepEqual(found.sentences, []);
});

test('no selection and no text reads nothing', () => {
  const doc = page('<p>Page.</p>');
  assert.deepEqual(readSelection(doc, null).sentences, []);
  assert.deepEqual(readSelection(doc, { rangeCount: 0 }, '   ').sentences, []);
});

// ---------------------------------------------------------------------------
// Read from here: which sentence a right-click lands in
// ---------------------------------------------------------------------------

function article(body, ids) {
  const doc = page(body);
  const blocks = ids.map((id) => {
    const element = doc.getElementById(id);
    return { element, text: element.textContent.replace(/\s+/g, ' ').trim() };
  });
  return { doc, blocks, sentences: buildSentences(blocks) };
}

test('a click inside a sentence starts that sentence, not the next', () => {
  const { doc, blocks, sentences } = article(
    '<p id="a">One two. Three four.</p><p id="b">Five six. Seven.</p>',
    ['a', 'b']
  );
  const b = textOf(doc.getElementById('b'));
  // Inside "six" of "Five six."
  assert.equal(
    sentences[sentenceAt({ blocks, sentences, container: b, offset: 6 })].text,
    'Five six.'
  );
  // Inside "Seven."
  assert.equal(
    sentences[sentenceAt({ blocks, sentences, container: b, offset: 12 })].text,
    'Seven.'
  );
  const a = textOf(doc.getElementById('a'));
  // On the space between two sentences: the next one.
  assert.equal(
    sentences[sentenceAt({ blocks, sentences, container: a, offset: 8 })].text,
    'Three four.'
  );
});

test('a click on a word in bold or a link finds its sentence', () => {
  const { doc, blocks, sentences } = article(
    '<p id="a">First here. Then <a href="#">a <b>linked</b> word</a> here.</p>',
    ['a']
  );
  const bold = doc.querySelector('b').firstChild;
  assert.equal(
    sentences[sentenceAt({ blocks, sentences, container: bold, offset: 2 })].text,
    'Then a linked word here.'
  );
});

test('a click outside the article starts at the next paragraph after it', () => {
  const { doc, blocks, sentences } = article(
    '<p id="a">One.</p><aside id="s">Sidebar text.</aside><p id="b">Two. Three.</p>',
    ['a', 'b']
  );
  const side = textOf(doc.getElementById('s'));
  assert.equal(
    sentences[sentenceAt({ blocks, sentences, container: side, offset: 3 })].text,
    'Two.'
  );
});

test('a click after the article, or nowhere, starts at the top', () => {
  const { doc, blocks, sentences } = article(
    '<p id="a">One. Two.</p><footer id="f">Foot.</footer>',
    ['a']
  );
  const foot = textOf(doc.getElementById('f'));
  assert.equal(sentenceAt({ blocks, sentences, container: foot, offset: 1 }), 0);
  assert.equal(sentenceAt({ blocks, sentences, container: null, offset: 0 }), 0);
});

test('a click on an element, not text, uses the text right after it', () => {
  const { doc, blocks, sentences } = article(
    '<div id="w"><p id="a">One.</p><img><p id="b">Two.</p></div>',
    ['a', 'b']
  );
  const w = doc.getElementById('w');
  // Between the image and the second paragraph.
  assert.equal(sentences[sentenceAt({ blocks, sentences, container: w, offset: 2 })].text, 'Two.');
});

test('a click inside our own sentence highlight still finds the sentence', () => {
  const { doc, blocks, sentences } = article(
    '<p id="a">One. <ftts-mark class="ftts-sentence">Two.</ftts-mark> Three.</p>',
    ['a']
  );
  const marked = doc.querySelector('ftts-mark').firstChild;
  assert.equal(
    sentences[sentenceAt({ blocks, sentences, container: marked, offset: 1 })].text,
    'Two.'
  );
});

/** Lay the blocks out top to bottom: each 100px tall, 20px apart, 600px wide at x 100. */
function layOut(blocks) {
  blocks.forEach((block, i) => {
    const top = i * 120;
    block.element.getBoundingClientRect = () => ({
      left: 100,
      right: 700,
      top,
      bottom: top + 100,
      width: 600,
      height: 100,
    });
  });
}

test('the owner’s case: in the gap below a paragraph, the caret snaps to its end, but reading starts below', () => {
  const { doc, blocks, sentences } = article(
    '<p id="a">One. Two.</p><p id="b">Three. Four.</p><p id="c">Five.</p>',
    ['a', 'b', 'c']
  );
  layOut(blocks);
  const a = textOf(doc.getElementById('a'));
  // Caret at the very end of the first paragraph; the pointer is in the gap under it.
  const index = sentenceAt({
    blocks,
    sentences,
    container: a,
    offset: a.data.length,
    x: 300,
    y: 110,
  });
  assert.equal(sentences[index].text, 'Three.');
});

test('in the margin level with a paragraph, that paragraph is read from its start', () => {
  const { doc, blocks, sentences } = article('<p id="a">One. Two.</p><p id="b">Three. Four.</p>', [
    'a',
    'b',
  ]);
  layOut(blocks);
  const b = textOf(doc.getElementById('b'));
  // The caret snapped to the middle of the paragraph beside the pointer, but the pointer is
  // in the margin to its left.
  const index = sentenceAt({ blocks, sentences, container: b, offset: 9, x: 20, y: 170 });
  assert.equal(sentences[index].text, 'Three.');
});

test('over a paragraph, the pointer confirms the caret and its sentence is read', () => {
  const { doc, blocks, sentences } = article('<p id="a">One. Two.</p><p id="b">Three. Four.</p>', [
    'a',
    'b',
  ]);
  layOut(blocks);
  const b = textOf(doc.getElementById('b'));
  const index = sentenceAt({ blocks, sentences, container: b, offset: 9, x: 300, y: 170 });
  assert.equal(sentences[index].text, 'Four.');
});

test('below the whole article, reading starts at the top', () => {
  const { doc, blocks, sentences } = article('<p id="a">One.</p><p id="b">Two.</p>', ['a', 'b']);
  layOut(blocks);
  const b = textOf(doc.getElementById('b'));
  assert.equal(sentenceAt({ blocks, sentences, container: b, offset: 4, x: 300, y: 900 }), 0);
});

test('with no pointer position, a caret at a paragraph’s end means the next paragraph', () => {
  const { doc, blocks, sentences } = article('<p id="a">One.</p><p id="b">Two.</p>', ['a', 'b']);
  const a = textOf(doc.getElementById('a'));
  assert.equal(sentences[sentenceAt({ blocks, sentences, container: a, offset: 4 })].text, 'Two.');
});

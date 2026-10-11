/**
 * Reading what the listener selected, instead of the whole article.
 *
 * The extractor decides for itself what the article is. A selection is the listener deciding
 * instead, so none of the extractor's judgement applies here — no junk rules, no walls, no
 * reference lists. Whatever was selected is read, on any page, including the ones the
 * extractor gets wrong or finds nothing on at all. That is most of the point of the feature.
 *
 * The output has the same shape the article has — blocks, and sentences that point into them
 * — so the reader, the highlighter and the bar need not know where the text came from. The
 * one difference is that a sentence need not start at the start of its block, or run to its
 * end: a selection that begins mid-paragraph is read from where it begins.
 *
 * A block here is a paragraph-like element that holds part of the selection, and its text is
 * the whole element's text measured exactly as the highlighter measures it (`buildRuns`), so
 * the offsets land on the same characters. Only the selected stretch of it is ever read.
 *
 * Pure DOM walking with no layout, like text-map.js, so it runs in the tests as it does on a
 * page. Page order is worked out by walking the tree rather than asked of the browser: the
 * test DOM's `compareDocumentPosition` is wrong (see PROGRESS.md, sixteenth session).
 */

import { buildRuns } from './text-map.js';
import { splitSentences } from './sentences.js';
import { normalizeWhitespace } from './extractor.js';

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** Text in these is never read: code, styling, or the inside of a form field. */
const NEVER_READ = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'TEXTAREA',
  'INPUT',
  'SELECT',
]);

/**
 * Elements that start a new block when the page gives no better answer.
 *
 * The page's own computed `display` is asked first, because sites make `<span>`s into blocks
 * and `<div>`s into inline runs. This list is the fallback for when there is no layout to ask.
 */
const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'BODY',
  'CAPTION',
  'DD',
  'DETAILS',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'SUMMARY',
  'TD',
  'TH',
  'UL',
]);

/**
 * Turn the page's selection into blocks and sentences the reader can use.
 *
 * `fallbackText` is what the browser said was selected (the context menu passes it). It is
 * used only when the selection cannot be found on the page — text selected inside a form
 * field is the usual case — and is then read without a highlight, since there is nothing on
 * the page to put one on.
 *
 * @param {Document} doc
 * @param {{rangeCount: number, getRangeAt: (i: number) => Range}|null} selection
 * @param {string} [fallbackText]
 * @returns {{blocks: Array<{text: string, element: Element|null}>, sentences: Array<{text: string, blockIndex: number, start: number, end: number}>}}
 */
export function readSelection(doc, selection, fallbackText = '') {
  const blocks = [];
  const sentences = [];
  const runsByElement = new Map();
  const skipCache = new Map();

  const count = typeof selection?.rangeCount === 'number' ? selection.rangeCount : 0;
  for (let i = 0; i < count; i += 1) {
    let range;
    try {
      range = selection.getRangeAt(i);
    } catch {
      continue;
    }
    for (const piece of groupByBlock(doc, range, skipCache)) {
      addPiece(piece, blocks, sentences, runsByElement);
    }
  }

  if (sentences.length === 0) {
    const text = normalizeWhitespace(typeof fallbackText === 'string' ? fallbackText : '');
    if (text) {
      blocks.push({ text, element: null });
      for (const sentence of splitSentences(text)) {
        sentences.push({ ...sentence, blockIndex: 0 });
      }
    }
  }

  return { blocks, sentences };
}

/**
 * The selected text of one range, as a list of stretches that each sit in one block:
 * `{ element, from: {node, offset}, to: {node, offset} }`, with both ends on a visible
 * character (never on whitespace), `to` exclusive.
 */
function groupByBlock(doc, range, skipCache) {
  const start = startPoint(range);
  const end = endPoint(range);
  if (!start || !end) return [];

  const pieces = [];
  let current = null;

  for (let node = start.node; node; node = nextInOrder(node)) {
    if (node.nodeType === TEXT_NODE && !isSkipped(node.parentNode, skipCache)) {
      const data = typeof node.data === 'string' ? node.data : '';
      let from = node === start.node ? start.offset : 0;
      let to = node === end.node ? end.offset : data.length;
      // Shrink onto visible characters, so both ends land on something the highlighter can
      // find — a lone space is not reliably a character of its own after normalising.
      while (from < to && /\s/.test(data[from])) from += 1;
      while (to > from && /\s/.test(data[to - 1])) to -= 1;

      if (from < to) {
        const element = blockOf(node, doc);
        if (current && current.element === element) {
          current.to = { node, offset: to };
        } else {
          current = { element, from: { node, offset: from }, to: { node, offset: to } };
          pieces.push(current);
        }
      }
    }
    if (node === end.node) return pieces;
  }

  // Walked off the end of the page without meeting the end: the range was backwards or
  // stale. Reading nothing is the honest answer.
  return [];
}

function addPiece(piece, blocks, sentences, runsByElement) {
  let measured = runsByElement.get(piece.element);
  if (!measured) {
    measured = buildRuns(piece.element);
    runsByElement.set(piece.element, measured);
  }

  const start = normOffset(measured.runs, piece.from.node, piece.from.offset);
  const last = normOffset(measured.runs, piece.to.node, piece.to.offset - 1);
  if (start === null || last === null || last < start) return;
  const end = last + 1;

  const blockIndex = blocks.length;
  blocks.push({ text: measured.normalized, element: piece.element });
  for (const sentence of splitSentences(measured.normalized.slice(start, end))) {
    sentences.push({
      text: sentence.text,
      blockIndex,
      start: start + sentence.start,
      end: start + sentence.end,
    });
  }
}

/** Where a visible character of a text node sits in its block's normalised text. */
function normOffset(runs, node, offset) {
  for (const run of runs) {
    if (run.node !== node) continue;
    if (offset >= run.nodeOffset && offset < run.nodeOffset + run.length) {
      return run.normStart + (offset - run.nodeOffset);
    }
  }
  return null;
}

/** The range's start as a text node and an offset into it. */
function startPoint(range) {
  return textAt(range?.startContainer, range?.startOffset);
}

/** A boundary point as a text node and an offset: the first text at or after it. */
function textAt(container, offset) {
  if (!container) return null;
  if (container.nodeType === TEXT_NODE) return { node: container, offset: offset ?? 0 };

  // An element boundary sits before its child at `offset`; the first text at or after
  // that point is where the selection really begins.
  const child = container.childNodes?.[offset ?? 0];
  let node = child ?? afterSubtree(container);
  while (node && node.nodeType !== TEXT_NODE) node = nextInOrder(node);
  return node ? { node, offset: 0 } : null;
}

/** The range's end as a text node and an offset into it (exclusive). */
function endPoint(range) {
  const container = range?.endContainer;
  if (!container) return null;
  if (container.nodeType === TEXT_NODE) return { node: container, offset: range.endOffset };

  // An element boundary sits after its child at `endOffset - 1`; the last text before that
  // point is where the selection really ends. A triple-click selects a paragraph this way,
  // ending at offset 0 of the next one.
  let node =
    range.endOffset > 0
      ? lastDescendant(container.childNodes[range.endOffset - 1])
      : previousInOrder(container);
  while (node && node.nodeType !== TEXT_NODE) node = previousInOrder(node);
  return node ? { node, offset: node.data.length } : null;
}

function nextInOrder(node) {
  if (node.firstChild) return node.firstChild;
  return afterSubtree(node);
}

/** The first node after everything inside `node`. */
function afterSubtree(node) {
  for (let at = node; at; at = at.parentNode) {
    if (at.nextSibling) return at.nextSibling;
  }
  return null;
}

function previousInOrder(node) {
  if (node.previousSibling) return lastDescendant(node.previousSibling);
  return node.parentNode ?? null;
}

function lastDescendant(node) {
  let at = node;
  while (at?.lastChild) at = at.lastChild;
  return at;
}

/**
 * True for text that is not the page's to read: inside code or a form field, hidden, or
 * part of our own bar. Answers are cached per parent element, since a paragraph's text nodes
 * all ask about the same ancestors.
 */
function isSkipped(element, cache) {
  if (!element || element.nodeType !== ELEMENT_NODE) return false;
  if (cache.has(element)) return cache.get(element);

  let skipped = false;
  if (NEVER_READ.has(element.tagName)) skipped = true;
  else if (element.hasAttribute?.('hidden')) skipped = true;
  else if (
    /\bftts-(controls|trace)/.test(String(element.className?.baseVal ?? element.className ?? ''))
  ) {
    // Our bar and the trace panel — but not the sentence highlight, which wraps page text.
    skipped = true;
  } else {
    try {
      // Firefox 125+; asked of the element itself, it covers display:none on any ancestor.
      if (element.checkVisibility?.() === false) skipped = true;
    } catch {
      // Unknown means visible: better to read a stray word than drop a selected one.
    }
    if (!skipped) skipped = isSkipped(element.parentNode, cache);
  }

  cache.set(element, skipped);
  return skipped;
}

/** The nearest paragraph-like element around a text node. */
function blockOf(node, doc) {
  const view = doc.defaultView;
  for (let at = node.parentNode; at && at.nodeType === ELEMENT_NODE; at = at.parentNode) {
    if (isBlock(at, view)) return at;
  }
  return doc.body ?? doc.documentElement;
}

function isBlock(element, view) {
  try {
    const display = view?.getComputedStyle?.(element)?.display;
    if (typeof display === 'string' && display !== '') {
      return !display.startsWith('inline') && display !== 'contents';
    }
  } catch {
    // Fall back to the tag.
  }
  return BLOCK_TAGS.has(element.tagName);
}

/**
 * Which sentence of the article a right-click means — for "Read from here".
 *
 * Two pieces of evidence, and the second overrules the first:
 *
 *   - the caret: the node and offset the browser puts a text cursor at for the click;
 *   - the pointer: where on screen the click actually was (`x`, `y`).
 *
 * The caret alone misled on the owner's first test. On empty space — a margin, the gap
 * between paragraphs, a picture — the browser still produces a caret, snapped to the
 * nearest text, and that is usually the END of the paragraph ABOVE. So the caret is trusted
 * only when the pointer is over the paragraph it landed in. Otherwise the answer is the first
 * paragraph at or below the pointer's height: level with the pointer, or the next one down.
 *
 * Over a paragraph, the caret picks the sentence under the pointer, measured the way the
 * highlighter measures, so a click mid-sentence starts that sentence rather than the next.
 * Past the article's end, or with nothing to go on, it is the start.
 *
 * With no pointer position (tests of the caret alone, or a browser that gives none) the
 * page order stands in for height: the first paragraph after the caret.
 *
 * @param {{blocks: Array<{element: Element}>, sentences: Array<{blockIndex: number, end: number}>, container: Node|null, offset: number, x?: number, y?: number}} options
 * @returns {number} a sentence index
 */
export function sentenceAt({ blocks, sentences, container, offset, x, y }) {
  if (!Array.isArray(sentences) || sentences.length === 0) return 0;

  const blockOfElement = new Map();
  (blocks ?? []).forEach((block, index) => {
    if (block?.element && !blockOfElement.has(block.element)) {
      blockOfElement.set(block.element, index);
    }
  });
  const firstOf = (blockIndex) => {
    const found = sentences.findIndex((sentence) => sentence.blockIndex >= blockIndex);
    return found === -1 ? 0 : found;
  };
  const hasPointer = Number.isFinite(x) && Number.isFinite(y);

  const point = textAt(container, offset);

  // The caret is in a paragraph of the article, and the pointer is over that paragraph:
  // the sentence under the pointer.
  if (point) {
    for (let at = point.node.parentNode; at; at = at.parentNode) {
      if (!blockOfElement.has(at)) continue;
      if (hasPointer && !contains(rectOf(at), x, y)) break;
      const blockIndex = blockOfElement.get(at);
      const where = offsetIn(buildRuns(at).runs, point.node, point.offset);
      const found = sentences.findIndex(
        (sentence) =>
          sentence.blockIndex > blockIndex ||
          (sentence.blockIndex === blockIndex && sentence.end > where)
      );
      return found === -1 ? 0 : found;
    }
  }

  // Not over the article's text: the first paragraph level with the pointer or below it.
  if (hasPointer) {
    const index = (blocks ?? []).findIndex((block) => {
      const rect = rectOf(block?.element);
      return rect && rect.height > 0 && rect.bottom > y;
    });
    return index === -1 ? 0 : firstOf(index);
  }

  // No pointer to go by: the first paragraph after the caret in page order.
  if (point) {
    for (let node = nextInOrder(point.node); node; node = nextInOrder(node)) {
      if (blockOfElement.has(node)) return firstOf(blockOfElement.get(node));
    }
  }
  return 0;
}

function rectOf(element) {
  try {
    return element?.getBoundingClientRect?.() ?? null;
  } catch {
    return null;
  }
}

function contains(rect, x, y) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return false;
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/**
 * Where a point in a text node sits in its block's normalised text. A point in whitespace
 * counts as the next visible character; a point after the block's last one is past its end,
 * so the next paragraph is the answer rather than the start of this one.
 */
function offsetIn(runs, node, offset) {
  let seen = false;
  for (const run of runs) {
    if (run.node === node) {
      seen = true;
      if (offset < run.nodeOffset + run.length) {
        return run.normStart + Math.max(0, offset - run.nodeOffset);
      }
    } else if (seen) {
      return run.normStart;
    }
  }
  return seen ? Infinity : 0;
}

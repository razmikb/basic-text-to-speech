/**
 * Finding a sentence's exact place in the page's text nodes.
 *
 * The reader knows a sentence as "characters 42 to 98 of block 7". The page holds nothing
 * of the sort: it holds raw text nodes with the newlines and indentation of the original
 * HTML, chopped up by every `<b>`, `<a>` and `<em>` the author used. This file is the
 * bridge, and it is the only place in the add-on that does this arithmetic.
 *
 * The gap exists because the extractor normalises: `text.replace(/\s+/g, ' ').trim()`.
 * So `"Hello \n   world"` becomes `"Hello world"`, and offset 6 in the tidy version is
 * offset 11 in the real one. Get this wrong by one and the highlight lands mid-word.
 *
 * It is kept separate from the highlighter, and free of anything browser-only, because it
 * is pure arithmetic over text — the part that is easy to get subtly wrong and easy to
 * test exhaustively. It is tested against every block of the real article fixtures, at
 * every offset.
 */

/**
 * @typedef {object} Run
 * A stretch where normalised text and raw text run character-for-character, so an offset
 * inside it resolves with a single addition and no searching.
 * @property {Text|null} node the text node these characters live in; null for a `<br>`
 * @property {number} nodeOffset where they start inside that node
 * @property {number} normStart where they start in the normalised text
 * @property {number} length how many characters
 */

/**
 * Walk an element's text and record how the normalised version lines up with the real one.
 *
 * This reproduces `normalizeWhitespace` exactly, as a scan rather than a regex:
 *
 *   - a run of whitespace, however long and however many text nodes it crosses, emits ONE
 *     space, anchored to its first whitespace character;
 *   - unless nothing has been emitted yet, in which case it emits nothing at all — which
 *     is precisely what `trim()` does to leading whitespace;
 *   - trailing whitespace is never followed by a character, so it is never emitted, which
 *     is the other half of `trim()`.
 *
 * A `<br>` counts as whitespace too, though it has no character on the page. The Duolingo
 * blog writes each interview answer as `<strong>Question?</strong><br>Answer.`, and read as
 * `textContent` that is "Question?Answer." — one sentence, spoken with no pause, one
 * highlight across both. A space that stands for a `<br>` has no text node to live in, so
 * its run has `node: null`: it takes its place in the normalised text and is never drawn.
 * The extractor takes its block text from here, so the two cannot disagree about it.
 *
 * Note `/\s/` is used rather than a hand-written list of space characters, because that is
 * what the extractor uses: it means a non-breaking space collapses here exactly as it does
 * there. A hand-rolled list would disagree about a non-breaking space, and put the
 * highlight in the wrong place on every page that uses one.
 *
 * @param {Element} element
 * @returns {{runs: Run[], normalized: string}}
 */
export function buildRuns(element) {
  const runs = [];
  let normalized = '';

  const walker = createTextWalker(element);
  if (!walker) return { runs, normalized };

  /** The first whitespace character of the run we are currently inside, if any. */
  let pendingSpace = null;

  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeType !== TEXT_NODE) {
      if (node.tagName === 'BR' && pendingSpace === null) pendingSpace = { node: null, offset: 0 };
      continue;
    }
    // Text that is never shown: the CSS inside a <style>, a script. Wikipedia puts its
    // style sheets inside the article, wrapped in empty spans, and they were read aloud.
    if (UNSPOKEN_PARENTS.has(node.parentNode?.tagName)) continue;
    const data = typeof node.data === 'string' ? node.data : '';

    for (let i = 0; i < data.length; i += 1) {
      const char = data[i];

      if (WHITESPACE.test(char)) {
        if (pendingSpace === null) pendingSpace = { node, offset: i };
        continue;
      }

      if (pendingSpace !== null) {
        // Whitespace before any real character is dropped by trim(), not collapsed.
        if (normalized.length > 0) {
          runs.push({
            node: pendingSpace.node,
            nodeOffset: pendingSpace.offset,
            normStart: normalized.length,
            length: 1,
          });
          normalized += ' ';
        }
        pendingSpace = null;
      }

      // Extend the previous run when this character simply continues it. Runs must break
      // at a text node boundary even with no whitespace between: `<b>Hello</b><i>World</i>`
      // is one word in the normalised text and two nodes on the page.
      const last = runs[runs.length - 1];
      if (
        last &&
        last.node === node &&
        last.nodeOffset + last.length === i &&
        last.normStart + last.length === normalized.length
      ) {
        last.length += 1;
      } else {
        runs.push({ node, nodeOffset: i, normStart: normalized.length, length: 1 });
      }

      normalized += char;
    }
  }

  return { runs, normalized };
}

/**
 * Resolve a normalised range onto the real text nodes it covers.
 *
 * `expectedText` is what the extractor recorded for this block. It is checked against the
 * page as it is right now, and a mismatch means the site has changed the paragraph under
 * us — lazy loading, an ad reflowing, a single-page app re-rendering. The honest answer
 * then is not to guess: return null, highlight nothing, and let the article carry on being
 * read. A dropped highlight is acceptable; a highlight sprayed across the wrong words is
 * not.
 *
 * @param {Element} element the block's element on the page
 * @param {number} start normalised offset, inclusive
 * @param {number} end normalised offset, exclusive
 * @param {string} expectedText the block text the offsets were measured against
 * @returns {Array<{node: Text, from: number, to: number}>|null} slices in document order
 */
export function mapRange(element, start, end, expectedText) {
  if (!element) return null;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end <= start) return null;

  const { runs, normalized } = buildRuns(element);
  if (typeof expectedText === 'string' && normalized !== expectedText) return null;
  if (end > normalized.length) return null;

  const slices = [];

  for (const run of runs) {
    const runEnd = run.normStart + run.length;
    if (runEnd <= start) continue;
    if (run.normStart >= end) break;
    if (run.node === null) continue; // the space a <br> stands for has nothing to mark

    const from = run.nodeOffset + Math.max(start, run.normStart) - run.normStart;
    const to = run.nodeOffset + Math.min(end, runEnd) - run.normStart;
    if (to <= from) continue;

    // A range that starts or ends on a collapsed space lands on that whitespace run, whose
    // node is genuinely part of the sentence — so it is kept, and the highlight covers the
    // space the reader would expect it to.
    const previous = slices[slices.length - 1];
    if (previous && previous.node === run.node && previous.to === from) previous.to = to;
    else slices.push({ node: run.node, from, to });
  }

  return slices.length > 0 ? slices : null;
}

/** Elements whose text is code for the browser, never words on the page. */
const UNSPOKEN_PARENTS = new Set(['STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE']);

/** Whitespace exactly as the extractor's `\s+` sees it, non-breaking spaces included. */
const WHITESPACE = /\s/;

/**
 * `NodeFilter.SHOW_ELEMENT | SHOW_TEXT`, and `Node.TEXT_NODE`. Spelled as numbers because
 * NodeFilter and Node are not everywhere. Elements are walked only to see the `<br>`s.
 */
const SHOW_ELEMENTS_AND_TEXT = 1 | 4;
const TEXT_NODE = 3;

/**
 * A walker over the element's text nodes and elements, or null if this document cannot
 * make one. Pages are other people's, so nothing here may throw.
 */
function createTextWalker(element) {
  const doc = element.ownerDocument;
  if (!doc || typeof doc.createTreeWalker !== 'function') return null;
  try {
    return doc.createTreeWalker(element, SHOW_ELEMENTS_AND_TEXT);
  } catch {
    return null;
  }
}

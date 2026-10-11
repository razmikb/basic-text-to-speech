/**
 * Finding the article on a page.
 *
 * This is the part most likely to break on real sites, so it is deliberately simple and
 * deliberately separate. The strategy is scoring, not rules: score every candidate
 * container by how much sentence-like text it holds, and take the winner. Sites vary
 * endlessly in their markup but agree on one thing — the article is where the prose is.
 *
 * Phase 1 returns plain text blocks. Phase 2 will need each block's element as well,
 * which is why blocks carry their element rather than just a string.
 */

import { buildRuns } from './text-map.js';

/**
 * Elements that never contain article prose, whatever the site does.
 *
 * `SMALL` is here for image credits. beehiiv wraps them in
 * `<small class="dream-post-content-figcaption">`, which `caption` in the junk list does not
 * catch because the word is glued to a prefix rather than standing on its own. The tag is
 * the reliable signal: `<small>` is for fine print — credits, disclaimers, legal notes — and
 * a sentence the author meant to be read aloud is not marked up as fine print.
 */
const EXCLUDED_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'NAV',
  'HEADER',
  'FOOTER',
  'ASIDE',
  'FORM',
  'BUTTON',
  'SELECT',
  'TEXTAREA',
  'IFRAME',
  'SVG',
  'FIGURE',
  'FIGCAPTION',
  'SMALL',
  'CODE',
  'PRE',
]);

/**
 * Words in a class or id that mean "this is furniture, not the article".
 *
 * Every word here is a loaded gun pointed at real articles. Substack marks its article
 * `class="typography newsletter-post post"`, so listing `post` or `newsletter` here threw
 * away the entire article and left only the "Discussion about this post" footer. A word
 * earns its place only if it is far more often furniture than content — when in doubt,
 * leave it out and let the prose scoring sort it out instead.
 */
const JUNK_PATTERN =
  /(^|[-_ ])(nav|navbar|menu|sidebar|side-bar|comments?|footer|banner|advert|advertisement|ads?|promo|share|sharing|social|related|recommended|subscribe|subscription|cookie|consent|popup|modal|toast|breadcrumb|pagination|paywall|byline|caption|widget|toolbar|masthead|skip|login|signup|search)([-_ ]|$)/i;

/** Containers likely to be the article, best guess first. */
const CANDIDATE_SELECTORS = [
  'article',
  '[role="main"]',
  'main',
  '[itemprop="articleBody"]',
  '.post-content',
  '.entry-content',
  '.article-body',
  '.article-content',
  '#content',
  '.content',
  'body',
];

/** Tags whose text we read, in the order they appear. */
const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, dd, div, span';

/**
 * Tags that are prose by intent, and tags that only sometimes hold it.
 *
 * `div` and `span` say nothing about their contents — they are the markup equivalent of a
 * cardboard box — so they are read only when nothing better is available inside them. A
 * ScholarSpace record puts its abstract in a bare
 * `<span class="dont-break-out preserve-line-breaks">`, the only prose on the whole page,
 * and a selector of real prose tags walked straight past it and read nothing at all.
 *
 * Reading every box, though, reads the article once per layer it is wrapped in. The test
 * that separates the two cases is whether the box contains a block of its own: a `div`
 * holding paragraphs is scaffolding and its paragraphs are read instead, while a `div` or
 * `span` holding only text is the deepest container there is, and that text is its own.
 */
/** Prose tags that may themselves be built from paragraphs; see `holdsParagraphs`. */
const CONTAINER_PROSE = new Set(['LI', 'BLOCKQUOTE', 'DD']);

const ALWAYS_PROSE = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'DD']);

/**
 * A short paragraph is only furniture if it does not also end like a sentence.
 *
 * Length alone was the test here, and it was aiming at buttons and hitting prose: a
 * rhetorical one-liner is a common style, and the 40-character floor was silently eating
 * ten real sentences across the four pages we have captured — "Perhaps you haven't.",
 * "No longer.", "If you build it, they may not use it." A short paragraph is not a button;
 * a short paragraph with no full stop is.
 *
 * The closing quote or bracket has to be allowed after the stop, or a one-line pull quote
 * like "Do not obey in advance." fails the test on its own quotation mark.
 *
 * The counter-example that keeps the length floor honest is Substack's empty-feed widget,
 * "No posts" — eight characters and no terminator, so both halves of the rule reject it.
 */
const ENDS_LIKE_PROSE = /[.!?]["'”’)\]]*$/;

/**
 * A paragraph shorter than this, and not ending like a sentence, is almost always a label,
 * caption, or button — not prose. Headings are exempt because "Introduction" is a
 * legitimate thing to read aloud.
 */
const MIN_PARAGRAPH_LENGTH = 40;

/**
 * Extract the readable article from a document.
 *
 * @param {Document} doc
 * @returns {{title: string, blocks: Array<{text: string, element: Element}>}}
 */
export function extractArticle(doc) {
  wrapperAnswers = new WeakMap();
  const root = findArticleRoot(doc);
  const titleElement = findTitleElement(doc, root);
  const title = findTitle(doc, root, titleElement);
  const articleHeader = findArticleHeader(titleElement, root);
  const collected = root ? collectBlocks(root, articleHeader) : [];
  // Trailing furniture goes before empty headings, and the order is load-bearing: an empty
  // heading is recognised by what follows it, so a widget heading left in place makes the
  // real block above it look like a label. beehiiv ends on an <h6> sign-off followed by
  // "Keep Reading", and trimming in the other order read that sign-off as furniture.
  const visible = cutAtWall(trimBeforeTitle(collected, titleElement), root);
  const blocks = trimEmptyHeadings(trimTrailingFurniture(dropReferenceLists(visible)));
  return { title, blocks };
}

/**
 * Drop anything that comes before the article's own title.
 *
 * The mirror image of `trimTrailingFurniture`, and it exists for the same reason: the
 * widget sits *inside* the winning container, so no class-name filter reaches it.
 * retrievalpractice.org is a Squarespace site whose page-header block — "Want research-based
 * tips in your inbox? Subscribe for my newsletter." — renders above the post and was read
 * aloud before the title.
 *
 * The title is the anchor rather than a list of banner phrases, because the phrases are a
 * loaded gun: that article is itself *about* newsletters and AI, and a `subscribe` or
 * `newsletter` rule would cut real sentences out of it. Position is the safer test. On all
 * five pages captured so far the title is the very first block, so anything above it is
 * furniture by construction — nothing of the article can precede its own headline.
 *
 * Does nothing when the title is not among the blocks, which is the case on a page with no
 * heading at all; there is no anchor to trust, so nothing is cut.
 */
function trimBeforeTitle(blocks, titleElement) {
  if (!titleElement) return blocks;
  const start = blocks.findIndex((block) => block.element === titleElement);
  return start > 0 ? blocks.slice(start) : blocks;
}

/**
 * A login or paywall box: the class or id names it as a wall.
 *
 * Deliberately not `data-*` attributes: Nature marks the article body itself
 * `data-test="main-access-wall"`, and only its real wall box carries `app-access-wall` as
 * a class.
 */
const WALL_PATTERN =
  /(^|[-_ ])(paywall|pay-wall|access-wall|regwall|reg-wall|registration-wall|login-wall|subscription-wall)([-_ ]|$)/i;

/**
 * Stop reading where a login or paywall box starts.
 *
 * The owner's decision (2026-09-27): a page that shows only part of an article is read up
 * to where the visible text stops, and getting past walls is not a feature for the first
 * version. Without this, Nature's teaser ran straight on into "Log in or create an
 * account", then related stories, then job adverts — the wall is not always named in a way
 * the junk filter catches, and what follows it was never the article anyway.
 *
 * Only a wall the browser actually draws counts. A subscriber's copy may keep the box in
 * the page, switched off, and cutting there would cut the article they paid for.
 */
function cutAtWall(blocks, root) {
  const wall = findWall(root);
  if (!wall) return blocks;
  const order = documentOrder(root);
  const wallAt = order.get(wall);
  if (wallAt === undefined) return blocks;
  const end = blocks.findIndex((block) => (order.get(block.element) ?? -1) >= wallAt);
  return end === -1 ? blocks : blocks.slice(0, end);
}

/**
 * Every element under `root`, numbered in page order.
 *
 * Worked out by hand rather than with `compareDocumentPosition`, which the test DOM gets
 * wrong — it reports elements before the wall as after it, and every page with a wall would
 * have read nothing. Only built when a wall has been found.
 */
function documentOrder(root) {
  const order = new Map();
  try {
    let index = 0;
    for (const element of root.querySelectorAll('*')) order.set(element, index++);
  } catch {
    // An empty map cuts nothing, which leaves the reading as it was.
  }
  return order;
}

function findWall(root) {
  if (!root || !root.querySelectorAll) return null;
  let candidates;
  try {
    candidates = root.querySelectorAll('[class*="wall" i], [id*="wall" i]');
  } catch {
    return null;
  }
  for (const candidate of candidates) {
    const className = typeof candidate.className === 'string' ? candidate.className : '';
    const id = typeof candidate.id === 'string' ? candidate.id : '';
    if (!WALL_PATTERN.test(className) && !WALL_PATTERN.test(id)) continue;
    if (isDrawn(candidate, root)) return candidate;
  }
  return null;
}

/** False when the element, or anything around it, is switched off. */
function isDrawn(element, root) {
  for (let node = element; node && node !== root; node = node.parentElement) {
    if (isHidden(node)) return false;
  }
  try {
    // Only a browser can say whether a stylesheet hides it; outside one, assume drawn.
    if (typeof element.getClientRects === 'function' && element.getClientRects().length === 0) {
      return false;
    }
  } catch {
    // Unknown is treated as drawn: the wall's own markup is the evidence we have.
  }
  return true;
}

/** Headings that introduce a list of citations. The whole heading, never words in prose. */
const REFERENCE_HEADING =
  /^(references|reference list|bibliography|works cited|literature cited|citations)$/i;

/**
 * Leave out reference lists: the heading and everything under it, up to the next heading
 * of the same rank or higher.
 *
 * The owner's decision (2026-09-27): citations read aloud — "Bastani, H. et al. Proc. Natl
 * Acad. Sci. USA 122" — are noise to a listener. Bounded by heading rank rather than cut to
 * the end, because some pages put an author's note or a correction after the references,
 * and that is prose.
 */
function dropReferenceLists(blocks) {
  const kept = [];
  let skippingBelow = 0; // the rank of the references heading being skipped, or 0

  for (const block of blocks) {
    const rank = headingRank(block.element);
    if (skippingBelow && rank && rank <= skippingBelow) skippingBelow = 0;
    if (!skippingBelow && rank && REFERENCE_HEADING.test(block.text)) skippingBelow = rank;
    if (!skippingBelow) kept.push(block);
  }
  return kept;
}

/** 1 to 6 for a heading, 0 for anything else. */
function headingRank(element) {
  const match = /^H([1-6])$/.exec(element?.tagName ?? '');
  return match ? Number(match[1]) : 0;
}

/**
 * Text that marks the end of the article and the start of the page's footer widgets.
 *
 * These sit *inside* the article container on some sites, so no amount of class-name
 * filtering removes them — but they are always last, so everything from here down goes.
 */
const END_OF_ARTICLE = [
  /^discussion about this (post|episode)$/i,
  /^ready for more\??$/i,
  /^share this (post|story)$/i,
  /^leave a comment$/i,
  /^subscribe to /i,
  /^(previous|next) post$/i,
  /^keep reading$/i,
  /^more from /i,
  /^read next$/i,
];

/**
 * Drop the widgets that trail the end of an article.
 *
 * Only the tail is examined: a phrase like "Leave a comment" in the middle of an article
 * is the author writing prose, not a button, and must still be read.
 */
function trimTrailingFurniture(blocks) {
  let end = blocks.length;
  while (end > 0 && END_OF_ARTICLE.some((pattern) => pattern.test(blocks[end - 1].text))) {
    end -= 1;
  }
  return end === blocks.length ? blocks : blocks.slice(0, end);
}

/**
 * Pick the container holding the most article-like text.
 */
export function findArticleRoot(doc) {
  wrapperAnswers = new WeakMap();
  let best = null;
  let bestScore = 0;

  for (const selector of CANDIDATE_SELECTORS) {
    let candidates;
    try {
      candidates = doc.querySelectorAll(selector);
    } catch {
      continue; // A selector the browser dislikes must not take the whole run down.
    }

    for (const candidate of candidates) {
      const score = scoreElement(candidate);
      // Ties go to the earlier selector, which is the more specific guess.
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
  }

  return best;
}

/**
 * How much article-like text an element holds. Scoring by prose rather than by raw
 * character count is what keeps a nav-heavy `body` from beating the real article.
 */
function scoreElement(element) {
  if (!element || isJunk(element)) return 0;

  let score = 0;
  for (const block of collectBlocks(element)) {
    score += block.text.length;
  }
  return score;
}

/**
 * Read an element's text as an ordered list of blocks, skipping page furniture.
 *
 * `articleHeader` is the one `<header>` whose contents are allowed through; see `isExcluded`.
 */
function collectBlocks(root, articleHeader = null) {
  const blocks = [];
  const seen = new Set();

  let elements;
  try {
    elements = root.querySelectorAll(BLOCK_SELECTOR);
  } catch {
    return blocks;
  }

  for (const element of elements) {
    if (isExcluded(element, root, articleHeader)) continue;
    if (!ALWAYS_PROSE.has(element.tagName) && !isDeepestTextContainer(element, root)) continue;
    if (holdsParagraphs(element)) continue;

    const text = blockText(element);
    if (text === '') continue;

    const isHeading = /^H[1-6]$/.test(element.tagName);
    if (!isHeading && text.length < MIN_PARAGRAPH_LENGTH && !ENDS_LIKE_PROSE.test(text)) continue;

    // A list item inside a paragraph, or nested lists, would otherwise be read twice.
    if (seen.has(text)) continue;
    seen.add(text);

    blocks.push({ text, element });
  }

  return blocks;
}

/**
 * True for a quote, list item or definition that is built out of paragraphs of its own.
 *
 * Those paragraphs are read one by one, so reading the container as well says everything
 * twice — the first time with the paragraphs glued together. Every multi-paragraph
 * `<blockquote>` did this, and Nature's `<li><p>` references were each heard twice.
 */
function holdsParagraphs(element) {
  if (!CONTAINER_PROSE.has(element.tagName)) return false;
  try {
    return element.querySelector('p') !== null;
  } catch {
    return false;
  }
}

/**
 * True when a `div` or `span` holds text that nothing else will read for us.
 *
 * Two ways a box fails that. It may hold a block of its own, in which case the block is
 * read and the box is scaffolding. Or it may sit inside a real prose tag already being
 * read — beehiiv writes `<p class="…paragraph"><span>…</span></p>`, and reading both says
 * the sponsor's paragraph twice in a row.
 *
 * Looking upward for a prose ancestor is what distinguishes that from the ScholarSpace
 * abstract, whose `<span>` has no `<p>` above it anywhere and so is the only thing that
 * will ever read those words.
 */
function isDeepestTextContainer(element, root) {
  try {
    if (element.querySelector(BLOCK_SELECTOR) !== null) return false;
  } catch {
    return false;
  }

  let node = element.parentElement;
  while (node && node !== root) {
    if (ALWAYS_PROSE.has(node.tagName)) return false;
    node = node.parentElement;
  }

  return normalizeWhitespace(textOf(element)) !== '';
}

/**
 * A heading that introduces nothing is a label, not prose.
 *
 * DSpace repository records list every metadata field they support and fill in the few the
 * item actually has: a ScholarSpace page offers 52 headings — "Performer", "Interviewee",
 * "Transcriber" — and fills 17. Headings are exempt from the minimum-length rule, because
 * "Introduction" is a real thing to read aloud, so all 35 empty labels were read out in a
 * row while the abstract they surrounded was skipped.
 *
 * What makes a heading furniture is emptiness *after* it, so that is what is tested: the
 * blocks are already in document order, and a heading followed immediately by another
 * heading of the same level or higher introduced nothing. "Abstract" keeps its place,
 * because the abstract follows it.
 *
 * A heading that ends the article is kept, which looks like an oversight and is not. A
 * label with nothing under it is only recognisable as a label because the next label
 * follows it; at the end of the document there is no such evidence, and the beehiiv
 * newsletter spends its last block on an `<h6>` sign-off that is the genuine closing
 * paragraph of the post. Dropping trailing headings read that page's ending as furniture
 * and cut three real sentences. Silence is not evidence, so the last block stays.
 */
function trimEmptyHeadings(blocks) {
  const levelOf = (block) => {
    const match = /^H([1-6])$/.exec(block.element.tagName);
    return match ? Number(match[1]) : 0;
  };

  return blocks.filter((block, index) => {
    const level = levelOf(block);
    if (level === 0) return true;

    const next = blocks[index + 1];
    if (!next) return true;
    const nextLevel = levelOf(next);
    return nextLevel === 0 || nextLevel > level;
  });
}

/**
 * The `<header>` that holds the article's own title, as opposed to the site's header.
 *
 * `<header>` is excluded furniture because it is usually the site's masthead — Chalkbeat's
 * holds about sixty navigation links. But sites also wrap the article's title, subtitle and
 * byline in a `<header>` of their own, so excluding the tag outright throws away real prose
 * on exactly the sites that mark their articles up most clearly.
 *
 * The title heading is what tells the two apart, and it is the anchor precisely because
 * nothing else does. "Inside the article root" does not work: on a Ghost blog the root is
 * `<body>`, so the site nav is inside it too. The header that contains the article's own
 * `<h1>` is the article's header; every other header on the page stays furniture.
 *
 * The Duolingo blog adds a second kind: no `<header>` at all, but the title and subtitle in
 * `<div class="post-banner">` inside the `<article>`, and "banner" is a junk word. A banner
 * holding the article's own title is the article's header by the same reasoning, so the
 * outermost such box below the root is the one returned. Only "banner" earns this: a title
 * found inside a `modal` or `cookie` box is not a headline worth reading out, and every
 * other furniture word stays as strict as it was.
 */
function findArticleHeader(titleElement, root) {
  let header = null;
  let node = titleElement;
  while (node && node !== root) {
    if (isTitleBox(node)) header = node;
    node = node.parentElement;
  }
  return header;
}

/** A box that may hold an article's title: a `<header>`, or one named after a banner. */
function isTitleBox(node) {
  return node.tagName === 'HEADER' || junkWord(node) === 'banner';
}

/**
 * True if this element, or anything it sits inside up to `root`, is page furniture.
 *
 * One exception: the article's own header, found by `findArticleHeader`. It was first
 * written to let just the title `<h1>` out, which read the title but still dropped the
 * subtitle sitting beside it in the same header — Edutopia puts its standfirst there as a
 * plain `<p>`. A subtitle is prose and belongs in the reading.
 *
 * What comes out of that header is the title and any paragraphs, but not other headings,
 * because the thing sharing the header with a title is usually the byline and both real
 * pages write it as a small heading with nothing else to catch it: Ghost writes
 * `<h4 class="gh-article-author-name">`. "Subtitles are paragraphs, bylines are headings"
 * is what the two pages agree on, and reading the author's name aloud before every article
 * is exactly the noise the `<header>` exclusion exists to prevent. Nature added a third
 * case: a subtitle in a plain `<div>`, let out because it ends like a sentence — see
 * `isSentenceBox`.
 *
 * Every other test still applies inside the header: a `<nav>` ancestor, a junk class or
 * hidden styling excludes as usual. That is what keeps Edutopia's byline `<div>` and its
 * "Your content has been saved!" toast out while the subtitle comes through.
 */
function isExcluded(element, root, articleHeader = null) {
  const inArticleHeader =
    articleHeader !== null &&
    articleHeader.contains(element) &&
    (element === articleHeader.querySelector('h1') ||
      element.tagName === 'P' ||
      isSentenceBox(element));

  let node = element;
  while (node && node !== root) {
    const letOut = inArticleHeader && articleHeader.contains(node) && isTitleBox(node);
    if (EXCLUDED_TAGS.has(node.tagName) && !letOut) return true;
    if (isJunk(node) && !letOut) return true;
    if (isHidden(node)) return true;
    node = node.parentElement;
  }
  return false;
}

/**
 * A plain box whose text is written as a sentence — a subtitle that did not use a `<p>`.
 *
 * Nature puts its standfirst in `<div class="c-article-teaser-text">`. The same header holds
 * "NEWS FEATURE" and the date, also in plain boxes, so the box alone proves nothing; ending
 * like a sentence is what separates a subtitle from a label.
 */
function isSentenceBox(element) {
  return (
    (element.tagName === 'DIV' || element.tagName === 'SPAN') &&
    ENDS_LIKE_PROSE.test(normalizeWhitespace(textOf(element)))
  );
}

function isJunk(element) {
  const word = junkWord(element);
  return word !== null && !isWrapperAround(element, word);
}

/** The furniture word an element's class or id names it after, or null. */
function junkWord(element) {
  const className = typeof element.className === 'string' ? element.className : '';
  const id = typeof element.id === 'string' ? element.id : '';
  const match = JUNK_PATTERN.exec(className) || JUNK_PATTERN.exec(id);
  return match ? match[2].toLowerCase() : null;
}

/**
 * True when an element named after some furniture holds that furniture *and* more besides.
 *
 * Stanford Report names its layout boxes after their neighbour: `<main class="…su-page-has-sidebar">`
 * and `<div class="su-sidebar-content-wrap">` both contain the article as well as the real
 * `<aside class="su-page-sidebar">`. Reading "sidebar" in their names threw the whole article
 * away, and the only prose left on the page was one related-story headline.
 *
 * A thing named after X that contains X is not X — it is the box X sits in. It only counts
 * as a wrapper when most of its text lies outside X, so a real sidebar that happens to hold
 * a `sidebar-widget` is still a sidebar.
 */
/**
 * Answers `isWrapperAround` has already given during this extraction, by element.
 *
 * The question recurses — whether a box is a wrapper depends on whether the boxes inside it
 * are — and ad slots nest. Asked fresh every time, eight nested `ad-` boxes took minutes and
 * Firefox warned the owner, on Nature, that the add-on was slowing it down. Remembered, each
 * box is weighed once. Reset at every entry point, because the page may have changed since.
 */
let wrapperAnswers = new WeakMap();

function isWrapperAround(element, word) {
  let answers = wrapperAnswers.get(element);
  if (!answers) {
    answers = new Map();
    wrapperAnswers.set(element, answers);
  }
  if (!answers.has(word)) answers.set(word, weighWrapper(element, word));
  return answers.get(word);
}

function weighWrapper(element, word) {
  let inner;
  try {
    inner = element.querySelectorAll(`[class*="${word}" i], [id*="${word}" i]`);
  } catch {
    return false;
  }

  let insideLength = 0;
  let counted = null;
  for (const candidate of inner) {
    // Another wrapper of the same kind is not the furniture; the thing inside it is.
    if (junkWord(candidate) !== word || isWrapperAround(candidate, word)) continue;
    // Count only the outermost match, or text in nested ones is counted twice. Matches come
    // in document order, so anything inside the last one counted comes straight after it.
    if (counted && counted.contains(candidate)) continue;
    counted = candidate;
    insideLength += normalizeWhitespace(textOf(candidate)).length;
  }

  if (insideLength === 0) return false;
  const totalLength = normalizeWhitespace(textOf(element)).length;
  return totalLength - insideLength > insideLength;
}

/**
 * Hidden text must not be spoken — cookie banners and off-screen menus are full of it.
 * Only cheap attribute checks are used; computed styles are far too slow for every node.
 */
function isHidden(element) {
  if (element.hidden === true) return true;
  if (element.getAttribute && element.getAttribute('aria-hidden') === 'true') return true;
  // A live region is a status announcement, not the article: DSpace renders its loading
  // spinner as role="status" wrapping a visually-hidden "Loading...", which is a message
  // about the page rather than a part of it.
  if (element.getAttribute && element.getAttribute('role') === 'status') return true;
  const style = element.getAttribute && element.getAttribute('style');
  if (style && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return true;
  return false;
}

/**
 * A block's text as it will be read and highlighted: whitespace collapsed, and a `<br>`
 * counted as a space. Taken from the highlighter's own mapping so the two always agree;
 * see `buildRuns`. Falls back to plain text where the document cannot walk itself.
 */
function blockText(element) {
  const { normalized } = buildRuns(element);
  // Only fall back where the document cannot walk itself. An empty answer from a walk is
  // an answer — a span holding nothing but a <style> — and textContent would put its CSS
  // straight back.
  if (normalized !== '' || typeof element.ownerDocument?.createTreeWalker === 'function') {
    return normalized;
  }
  return normalizeWhitespace(textOf(element));
}

function textOf(element) {
  return typeof element.textContent === 'string' ? element.textContent : '';
}

/** Collapse the newlines and indentation of source HTML into ordinary spacing. */
export function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The heading on the page that holds the article's title, if there is one.
 *
 * Kept separate from the title *text* because two callers need different things from one
 * decision: `findTitle` wants the words, and `collectBlocks` wants the element, so it can
 * let that one heading out of a `<header>` and read the title aloud. Deciding it twice
 * would be two rules free to disagree.
 *
 * An `<h1>` clear of page furniture beats one inside it. Stanford Report repeats the
 * headline in its sticky site header, ahead of the real one; taking that copy let the rest
 * of the site header out as "the article's header", and the reading opened on a
 * "Stories for you" teaser and a preferences blurb. Ghost and Edutopia keep their only
 * `<h1>` inside a `<header>`, so the first heading is still the answer when every one of
 * them sits in furniture.
 */
function findTitleElement(doc, root) {
  if (!root || !root.querySelectorAll) return null;
  const headings = [...root.querySelectorAll('h1')].filter(
    (heading) => normalizeWhitespace(textOf(heading)) !== ''
  );
  return headings.find((heading) => !isExcluded(heading, root)) ?? headings[0] ?? null;
}

/**
 * The page's own title, cleaned of the site name that most pages append to it.
 */
function findTitle(doc, root, titleElement = findTitleElement(doc, root)) {
  // The heading inside the article beats the first h1 on the page: on Substack the page's
  // first h1 is the publication's masthead, so that rule alone titles every post with the
  // author's name.
  const inArticleText = titleElement ? normalizeWhitespace(textOf(titleElement)) : '';
  if (inArticleText !== '') return inArticleText;

  const raw = typeof doc.title === 'string' ? doc.title : '';
  const fromDocument = normalizeWhitespace(raw.split(/\s[|–—-]\s/)[0]);
  if (fromDocument !== '') return fromDocument;

  const heading = doc.querySelector && doc.querySelector('h1');
  return heading ? normalizeWhitespace(textOf(heading)) : '';
}

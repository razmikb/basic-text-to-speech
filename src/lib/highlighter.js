/**
 * Marking the sentence being spoken, and following it down the page.
 *
 * Two jobs that belong together because they share one fact — where the current sentence
 * is — and nothing else in the add-on needs to know it.
 *
 * The governing rule here is that the page is not ours. Every class is prefixed `ftts-`,
 * the article's own text is never altered (only wrapped), and everything added comes off
 * again leaving the page byte-for-byte as it was found. That last claim is not a hope: it
 * is a test that highlights every sentence of a real article and then compares the whole
 * document to how it started.
 *
 * The reader does not know this file exists. It announces which sentence it is speaking,
 * and content.js connects that to this. Keeping the direction of knowledge one-way is what
 * lets the voice, the reader and the page each change without disturbing the others.
 */

import { mapRange } from './text-map.js';

/** Everything we add to the page carries this, so it can always be found and removed. */
const HIGHLIGHT_CLASS = 'ftts-sentence';

/**
 * The wrapper is an element of our own, not a `<span>`, because sites style spans — and
 * style what holds them. The Duolingo blog gives every `p:has(span:not(.pcontent))` 31px of
 * padding above and 29.5px to the left, meant for its sound-clip words, so the paragraph
 * being read jumped down and in the moment a span appeared inside it. That rule is aimed at
 * the site's own paragraph, which we must not restyle; the only fix in our hands is to be
 * something no site stylesheet can name. An unknown hyphenated tag is a valid inline element
 * in every browser, and the `ftts-` prefix keeps it ours.
 */
const HIGHLIGHT_TAG = 'ftts-mark';
const STYLE_ID = 'ftts-highlight-style';

/** Names the colours so the stylesheet is a constant and no setting ever becomes CSS. */
const COLOR_VAR = '--ftts-highlight';
const DARK_COLOR_VAR = '--ftts-highlight-dark';
const TEXT_COLOR_VAR = '--ftts-highlight-text';

/** Added beside HIGHLIGHT_CLASS when the sentence is written in light text. */
const ON_DARK_CLASS = 'ftts-on-dark';

/**
 * `!important` because we are a guest in someone else's stylesheet: without it any site
 * rule more specific than a bare class silently wins and the highlight never appears.
 *
 * `color: inherit` leaves the site's own text colour alone. That is why light text needs a
 * highlight of its own: a site in dark mode writes white, and white on light yellow cannot
 * be read — `ON_DARK_CLASS` swaps in the dark colour for those sentences.
 *
 * `box-decoration-break` matters because a sentence usually wraps across lines, and
 * without it the highlight gets rounded corners and padding only on the first fragment.
 *
 * `all: unset` comes first because a site rule can still reach our wrapper through `*` or
 * a descendant selector like `.post-content p *`. It was written when the wrapper was a
 * `<span>` and the Duolingo blog gave every `p:has(span) > span` a dashed blue underline
 * and `display: inline-block`; see `HIGHLIGHT_TAG`. Unset, the wrapper is a plain inline
 * that inherits everything and draws nothing but the highlight.
 * Only the wrapper's own styling is cleared: an underline on a link inside or around the
 * sentence belongs to that link and still shows.
 */
const STYLE_TEXT = `
.${HIGHLIGHT_CLASS} {
  all: unset !important;
  background-color: var(${COLOR_VAR}, #ffe57f) !important;
  color: var(${TEXT_COLOR_VAR}, inherit) !important;
  border-radius: 2px !important;
  box-decoration-break: clone !important;
  -webkit-box-decoration-break: clone !important;
}
.${HIGHLIGHT_CLASS}.${ON_DARK_CLASS} {
  background-color: var(${DARK_COLOR_VAR}, #5c4a00) !important;
}
`;

/**
 * Create a highlighter for one article.
 *
 * @param {object} options
 * @param {Document} options.doc the page being read
 * @param {Array<{text: string, element: Element}>} options.blocks from the extractor
 * @param {object} options.config resolved settings; see lib/config.js
 * @param {object} [options.viewport] the browser seam; built from `doc` when omitted
 * @param {() => number} [options.now] the clock, injectable so tests need not wait
 * @param {(element: Element) => string} [options.textColorOf] the colour an element's text
 *   is drawn in, as the browser reports it; injectable because only a browser can answer
 */
export function createHighlighter({
  doc,
  blocks = [],
  config = {},
  viewport,
  now = Date.now,
  textColorOf = (element) => doc.defaultView.getComputedStyle(element).color,
}) {
  /** Every wrapper we have put on the page for the current sentence. */
  let active = [];
  let styleElement = null;
  let stopListeningToScroll = null;

  /** When the reader last moved the page itself, so its own scrolling is not mistaken. */
  let scrollingUntil = 0;
  /** When the user last moved the page, so we can leave them alone for a while. */
  let userScrolledAt = 0;

  let destroyed = false;

  /**
   * The browser-only half, built once and lazily.
   *
   * Everything that measures or moves the window lives behind this, which is what keeps
   * the rest of the file testable outside a browser — and what lets the tests drive
   * scrolling decisions without a real viewport.
   */
  function getViewport() {
    if (viewport === undefined) {
      try {
        viewport = createDomViewport(doc?.defaultView, config);
      } catch {
        viewport = null;
      }
    }
    return viewport;
  }

  /**
   * A page that nobody reads gets nothing added to it, so the stylesheet waits until the
   * first highlight. Re-checked every time because a single-page app may replace `head`
   * wholesale between one sentence and the next.
   */
  function ensureStyle() {
    try {
      if (styleElement && styleElement.parentNode) return;

      if (!styleElement) {
        styleElement = doc.createElement('style');
        styleElement.id = STYLE_ID;
        styleElement.textContent = STYLE_TEXT;
      }

      const root = doc.documentElement;
      if (root && typeof root.style?.setProperty === 'function') {
        if (config.highlightColor) root.style.setProperty(COLOR_VAR, config.highlightColor);
        if (config.highlightColorDark) {
          root.style.setProperty(DARK_COLOR_VAR, config.highlightColorDark);
        }
        if (config.highlightTextColor) {
          root.style.setProperty(TEXT_COLOR_VAR, config.highlightTextColor);
        }
      }

      (doc.head ?? doc.documentElement)?.appendChild(styleElement);
    } catch {
      // No stylesheet means no visible highlight, which is a shame but not a broken page.
    }
  }

  /**
   * Wrap one stretch of one text node, leaving the text itself untouched.
   *
   * The node is replaced by up to three siblings — what came before, the marked part, and
   * what came after — because the page has no `splitText` we may rely on and because this
   * is exactly reversible.
   */
  /**
   * True when this sentence reads better on the dark highlight than on the light one.
   *
   * Asked of the sentence's own paragraph, every time, rather than once for the page: a page
   * can put a dark banner above a light body, and a reader can switch a site to dark mode
   * halfway through an article. The text colour is the evidence because it is always known
   * exactly; a page's background is often transparent all the way up, or an image.
   *
   * Anything that cannot be worked out — an unfamiliar colour format, a browser that will
   * not say — answers false, which is the ordinary highlight and the old behaviour.
   */
  function isOnDark(element) {
    try {
      const text = parseColor(config.highlightTextColor || textColorOf(element));
      if (!text) return false;
      const light = parseColor(config.highlightColor) ?? parseColor('#ffe57f');
      const dark = parseColor(config.highlightColorDark) ?? parseColor('#5c4a00');
      return contrast(text, dark) > contrast(text, light);
    } catch {
      return false;
    }
  }

  function wrapSlice({ node, from, to }, onDark) {
    const parent = node.parentNode;
    if (!parent) return null;

    const data = node.data;
    const mark = doc.createElement(HIGHLIGHT_TAG);
    mark.className = onDark ? `${HIGHLIGHT_CLASS} ${ON_DARK_CLASS}` : HIGHLIGHT_CLASS;
    mark.appendChild(doc.createTextNode(data.slice(from, to)));

    // Put the wrapper where the node was first, so the surrounding pieces have an anchor.
    parent.replaceChild(mark, node);
    if (from > 0) parent.insertBefore(doc.createTextNode(data.slice(0, from)), mark);
    if (to < data.length) parent.insertBefore(doc.createTextNode(data.slice(to)), mark.nextSibling);

    return mark;
  }

  /**
   * Take every wrapper back out and stitch the text nodes together again.
   *
   * `normalize()` is what makes the removal complete rather than merely invisible: without
   * it the page keeps the split text nodes forever, and a site walking its own DOM would
   * find a shape it never created. It is called on each wrapper's parent rather than on the
   * whole article, so text nodes the site deliberately kept apart stay apart.
   */
  function unwrap() {
    const parents = new Set();

    for (const mark of active) {
      try {
        const parent = mark.parentNode;
        if (!parent) continue; // The site already removed it; nothing left to undo.
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
        parents.add(parent);
      } catch {
        // A page that fights us is not worth breaking over.
      }
    }

    for (const parent of parents) {
      try {
        parent.normalize();
      } catch {
        // Leaves split text nodes behind at worst; the text is unchanged either way.
      }
    }

    active = [];
  }

  /**
   * Bring the highlight back into view, but only if the reader has not just been
   * scrolling the page themselves.
   *
   * The subtle part is telling our own scrolling apart from theirs. A smooth scroll fires
   * scroll events for its whole animation, and if those counted as the user we would
   * disable our own following the first time we used it.
   */
  function followHighlight() {
    if (config.scrollToSentence === false) return;

    const view = getViewport();
    if (!view) return;

    const anchor = active[0];
    if (!anchor) return;

    try {
      if (now() - userScrolledAt < (config.scrollRespectUserMs ?? 0)) return;
      if (view.isVisible(anchor)) return;

      scrollingUntil = now() + (config.scrollSettleMs ?? 0);
      view.scrollTo(anchor);
    } catch {
      // Scrolling is a convenience; never let it interrupt the reading.
    }
  }

  /** Start noticing the reader scrolling by hand, once, and only if we might scroll. */
  function ensureScrollWatch() {
    if (stopListeningToScroll || config.scrollToSentence === false) return;

    const view = getViewport();
    if (!view || typeof view.onUserScroll !== 'function') return;

    try {
      stopListeningToScroll = view.onUserScroll(() => {
        // Our own smooth scroll fires these too; ignore them or we would think the user
        // had grabbed the page every time we moved it, and never follow again.
        if (now() < scrollingUntil) return;
        userScrolledAt = now();
      });
    } catch {
      stopListeningToScroll = null;
    }
  }

  return {
    /**
     * Mark a sentence, replacing whatever was marked before.
     *
     * @param {{blockIndex: number, start: number, end: number}} sentence
     * @returns {boolean} false when the page has moved on and nothing could be marked
     */
    show(sentence) {
      if (destroyed || !sentence) return false;

      unwrap();

      const block = blocks[sentence.blockIndex];
      if (!block || !block.element) return false;

      // A paragraph the site has since removed cannot be highlighted, and asking the
      // browser about a detached element is how we find out cheaply.
      if (block.element.isConnected === false) return false;

      let slices;
      try {
        slices = mapRange(block.element, sentence.start, sentence.end, block.text);
      } catch {
        return false;
      }
      if (!slices) return false;

      ensureStyle();
      // One answer for the whole sentence: a link or a bold word in another shade must not
      // leave the highlight patchy.
      const onDark = isOnDark(block.element);

      try {
        // Backwards, so wrapping one slice cannot disturb the ones not yet done.
        for (let i = slices.length - 1; i >= 0; i -= 1) {
          const mark = wrapSlice(slices[i], onDark);
          if (mark) active.unshift(mark);
        }
      } catch {
        unwrap();
        return false;
      }

      if (active.length === 0) return false;

      ensureScrollWatch();
      followHighlight();
      return true;
    },

    /** Remove the mark, but leave the stylesheet — playback is paused, not over. */
    clear() {
      unwrap();
    },

    /** Remove every trace of us from the page. Safe to call twice. */
    destroy() {
      destroyed = true;
      unwrap();

      try {
        stopListeningToScroll?.();
      } catch {
        // Nothing more we can do about a listener that will not detach.
      }
      stopListeningToScroll = null;

      try {
        styleElement?.remove();
        const root = doc?.documentElement;
        if (root && typeof root.style?.removeProperty === 'function') {
          root.style.removeProperty(COLOR_VAR);
          root.style.removeProperty(DARK_COLOR_VAR);
          root.style.removeProperty(TEXT_COLOR_VAR);
        }
      } catch {
        // Same again: a page that will not let go of a <style> is not worth breaking.
      }
      styleElement = null;
    },

    /** For tests and for anyone debugging a page: what we currently have on it. */
    getActiveCount() {
      return active.length;
    },
  };
}

/**
 * The only part of the add-on that measures or moves the window.
 *
 * Everything here is browser-only and therefore untestable in Node, which is precisely
 * why it is a dozen lines in one place rather than spread through the highlighter.
 *
 * @param {Window} win
 * @param {object} config
 */
export function createDomViewport(win, config = {}) {
  if (!win) return null;

  return {
    /**
     * Is the sentence comfortably in view — not merely one pixel on screen?
     *
     * The margins are what stop the page lurching on every other sentence: a sentence
     * clinging to the bottom edge is technically visible and practically not.
     *
     * When we cannot tell (a window of no height, an element with no box because it or an
     * ancestor is hidden) the answer is "yes", because scrolling to something we cannot
     * measure is how a page ends up jumping to the wrong place.
     */
    isVisible(element) {
      const height = win.innerHeight || 0;
      if (height === 0) return true;

      const rect = element.getBoundingClientRect?.();
      if (!rect) return true;
      if (rect.width === 0 && rect.height === 0) return true;

      const top = height * (config.scrollTopMargin ?? 0);
      const bottom = height * (1 - (config.scrollBottomMargin ?? 0));
      return rect.top >= top && rect.bottom <= bottom;
    },

    /**
     * Centre the sentence rather than putting it at the top. Centring is what makes
     * scrolling rare: it leaves several sentences of room below, so the page moves once
     * every few sentences instead of nudging at every one.
     */
    scrollTo(element) {
      element.scrollIntoView?.({
        behavior: prefersReducedMotion(win) ? 'auto' : (config.scrollBehavior ?? 'smooth'),
        block: 'center',
        inline: 'nearest',
      });
    },

    onUserScroll(listener) {
      // Passive: we only want to know, never to interfere with the page scrolling.
      win.addEventListener('scroll', listener, { passive: true });
      return () => win.removeEventListener('scroll', listener);
    },
  };
}

/** Someone who has asked for less motion should not get a gliding page. */
function prefersReducedMotion(win) {
  try {
    return win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  } catch {
    return false;
  }
}

/**
 * Read `rgb()`, `rgba()` or a hex colour into [r, g, b], each 0–255, or null.
 *
 * Browsers report computed colours as `rgb()`; hex is for the defaults and the settings.
 * Named colours and newer formats are deliberately not understood — null sends the caller
 * back to the ordinary highlight, which is what every page got before this existed.
 */
function parseColor(value) {
  if (typeof value !== 'string') return null;
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(value.trim());
  if (rgb) return rgb.slice(1, 4).map(Number);

  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (!hex) return null;
  const digits = hex[1].length <= 4 ? [...hex[1]].map((d) => d + d) : hex[1].match(/../g);
  return digits.slice(0, 3).map((pair) => parseInt(pair, 16));
}

/** The WCAG contrast ratio between two colours: 1 is identical, 21 is black on white. */
function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

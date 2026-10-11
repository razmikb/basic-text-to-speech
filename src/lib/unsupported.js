/**
 * Why a page could not be read.
 *
 * Some pages can never be read aloud, and until now the add-on handled that by saying
 * nothing at all: the toolbar click failed, a line went to the background console, and to
 * anyone watching the screen the add-on simply did not exist. A PDF looked exactly as
 * broken as a crash.
 *
 * This works out which kind of page it was, so the failure can be explained instead of
 * swallowed. It is deliberately a pure function of two strings — no browser, no tabs, no
 * messaging — because the alternative is a rule that can only be checked by opening
 * Firefox and clicking, and this one has to be right about the difference between "a PDF"
 * and "an ordinary article that failed for some other reason".
 *
 * It is only ever consulted AFTER a click has already failed. It never decides whether a
 * page is readable — the page itself does that, by answering or not answering. That
 * ordering is what keeps a wrong guess here cheap: the worst it can do is mislabel a
 * failure that had already happened.
 */

/**
 * The most important case, and the one a naive rule gets wrong.
 *
 * A PDF does not have to have `.pdf` in its address. The paper that prompted all this is
 * served from `…/bitstreams/7e16b9e4-…/content` — no extension anywhere, and by URL alone
 * indistinguishable from an article. What gives it away is the tab title: Firefox names
 * the tab after the file, which the server supplies in a `Content-Disposition` header, so
 * the tab is called `30_01_10125-73712.pdf` even though the address is not.
 *
 * So both are checked and either is enough. A false positive costs a slightly wrong
 * explanation on a page that had already failed; a false negative costs the exact silence
 * this whole module exists to remove.
 */
const LOOKS_LIKE_PDF = /\.pdf(\?|#|$)/i;

/** Firefox's own viewer, when the address is visible rather than the original file's. */
const PDF_VIEWER = /(^resource:\/\/pdf\.js|\/pdf\.js\/|pdfjs)/i;

/**
 * Addresses no add-on may touch, whatever it asks for in its manifest.
 *
 * `moz-extension:` is in here because it includes our own settings page: pressing the
 * button there is a natural thing to try, and being told why is better than nothing
 * happening.
 */
const INTERNAL_SCHEME = /^(about|resource|chrome|view-source|moz-extension|jar):/i;

/** Mozilla's own site, which forbids add-ons on its pages as a security measure. */
const MOZILLA_SITE = /^https?:\/\/(addons\.mozilla\.org|accounts\.firefox\.com)/i;

/**
 * Explain a failed click.
 *
 * @param {string} url The tab's address, from `activeTab` at the moment of the click.
 * @param {string} [title] The tab's title, which for a PDF is usually the file's name.
 * @returns {{kind: string, badge: string, tooltip: string, summary: string}}
 */
export function explainUnreadable(url, title = '') {
  const address = typeof url === 'string' ? url : '';
  const name = typeof title === 'string' ? title : '';

  if (LOOKS_LIKE_PDF.test(address) || LOOKS_LIKE_PDF.test(name) || PDF_VIEWER.test(address)) {
    return {
      kind: 'pdf',
      badge: '!',
      tooltip: 'Firefox does not allow add-ons inside its PDF viewer — click again to read why',
      summary:
        'PDFs cannot be read aloud, because Firefox does not let add-ons run in its PDF viewer.',
    };
  }

  if (MOZILLA_SITE.test(address)) {
    return {
      kind: 'mozilla',
      badge: '!',
      tooltip: 'Mozilla does not allow add-ons to run on this site — click again to read why',
      summary: 'Mozilla blocks all add-ons on its own sites, so this page cannot be read aloud.',
    };
  }

  if (INTERNAL_SCHEME.test(address)) {
    return {
      kind: 'internal',
      badge: '!',
      tooltip: 'This is one of Firefox’s own pages, which add-ons cannot read',
      summary: 'This is one of Firefox’s own pages. Add-ons are not allowed to run on them.',
    };
  }

  // An ordinary page that did not answer. Genuinely unexpected, and said as such rather
  // than dressed up as a known limitation — this is the case where something may really
  // be wrong, and claiming otherwise would hide a real fault.
  return {
    kind: 'unknown',
    badge: '?',
    tooltip: 'This page would not let the add-on run — click again to read why',
    summary: 'This page did not let the add-on start. That is unusual, and may be worth reporting.',
  };
}

/**
 * The explanation page.
 *
 * One page answers for every kind of unreadable page, so the only job here is to reveal
 * the right section and fill in the one-line summary.
 *
 * The kind is decided by `explainUnreadable` — the SAME function the background script
 * used to set the badge — rather than being passed in as a ready-made verdict. Two places
 * deciding "is this a PDF" is two rules free to drift apart, and the badge saying one
 * thing while the page says another is worse than either being wrong alone.
 */

import { explainUnreadable } from './lib/unsupported.js';

const params = new URLSearchParams(location.search);
const url = params.get('url') ?? '';
const title = params.get('title') ?? '';

const { kind, summary } = explainUnreadable(url, title);

const summaryElement = document.getElementById('summary');
if (summaryElement) summaryElement.textContent = summary;

const detail = document.getElementById(`${kind}-detail`);
if (detail) detail.hidden = false;

/*
 * The address of the page that failed, shown only when there is one.
 *
 * Set as text, never as a link and never as markup: this string comes from whatever page
 * the button was pressed on, and the one thing an untrusted address must not do is become
 * something clickable on a page of ours.
 */
const addressElement = document.getElementById('address');
if (addressElement && url !== '') {
  addressElement.textContent = url;
  addressElement.hidden = false;
}

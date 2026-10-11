import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainUnreadable } from '../src/lib/unsupported.js';

/**
 * What a toolbar click does on a page that cannot be read.
 *
 * `explainUnreadable` is tested on its own next door; this is about the behaviour built on
 * top of it — the badge, the escalation on a second press, and above all the guarantee
 * that a page which reads normally is never marked at all.
 *
 * The click handler lives in `src/background.js`, which cannot be imported outside a
 * browser (it reaches for `api.action` at load). So the handler is mirrored here, the same
 * way `tab-coordination.test.js` mirrors the referee. The mirror is deliberately a faithful
 * copy of the real control flow: message the tab, and explain only if nobody answers.
 */

/** A stand-in for the toolbar button, recording what it was told to show. */
function makeButton() {
  const badges = new Map();
  const titles = new Map();

  return {
    badges,
    titles,
    setBadgeText: async ({ text, tabId }) => badges.set(tabId, text),
    setBadgeBackgroundColor: async () => {},
    setTitle: async ({ title, tabId }) => titles.set(tabId, title),
    badgeOn: (tabId) => badges.get(tabId) ?? '',
  };
}

/**
 * The real handler's logic, mirrored from `api.action.onClicked` in src/background.js.
 *
 * `answers` decides the one thing that matters: whether a content script replies. A page
 * with no content script — a PDF, an about: page — rejects, exactly as `tabs.sendMessage`
 * does in Firefox when nobody is listening.
 */
function makeClicker({ button, answers }) {
  const explained = new Map();
  const opened = [];

  return {
    opened,
    async click(tab) {
      try {
        if (!answers(tab)) throw new Error('Could not establish connection.');

        // It answered, so it is readable. Clear any earlier warning.
        if (explained.delete(tab.id)) {
          await button.setBadgeText({ text: '', tabId: tab.id });
          await button.setTitle({ title: null, tabId: tab.id });
        }
        return 'read';
      } catch {
        const { kind, badge, tooltip } = explainUnreadable(tab.url, tab.title);
        await button.setBadgeText({ text: badge, tabId: tab.id });
        await button.setTitle({ title: `Basic Text-to-Speech — ${tooltip}`, tabId: tab.id });

        if (explained.get(tab.id) === kind) {
          opened.push({ tabId: tab.id, kind, url: tab.url });
          explained.delete(tab.id);
          return 'explained';
        }

        explained.set(tab.id, kind);
        return 'marked';
      }
    },
  };
}

const PDF_TAB = {
  id: 1,
  url: 'https://scholarspace.manoa.hawaii.edu/server/api/core/bitstreams/7e16b9e4/content',
  title: '30_01_10125-73712.pdf',
};

const ARTICLE_TAB = {
  id: 2,
  url: 'https://www.edutopia.org/article/sneaky-charts',
  title: 'Will these 6 sneaky charts deceive your students?',
};

/**
 * The fault that started this. Pressing the button on a PDF used to do nothing visible
 * whatsoever — the add-on was indistinguishable from broken.
 */
test('a PDF is marked on the button instead of failing silently', async () => {
  const button = makeButton();
  const clicker = makeClicker({ button, answers: (tab) => tab.id !== PDF_TAB.id });

  const outcome = await clicker.click(PDF_TAB);

  assert.equal(outcome, 'marked');
  assert.equal(button.badgeOn(PDF_TAB.id), '!');
  assert.match(button.titles.get(PDF_TAB.id), /PDF viewer/);
});

/** A whisper first, a shout only when asked. One click must not throw a tab at you. */
test('the explanation opens on the second press, not the first', async () => {
  const button = makeButton();
  const clicker = makeClicker({ button, answers: (tab) => tab.id !== PDF_TAB.id });

  assert.equal(await clicker.click(PDF_TAB), 'marked');
  assert.equal(clicker.opened.length, 0, 'one press must not open a tab');

  assert.equal(await clicker.click(PDF_TAB), 'explained');
  assert.equal(clicker.opened.length, 1);
  assert.equal(clicker.opened[0].kind, 'pdf');
});

/** Having shouted once, it goes back to whispering rather than opening a tab per press. */
test('a third press does not open a second tab', async () => {
  const button = makeButton();
  const clicker = makeClicker({ button, answers: () => false });

  await clicker.click(PDF_TAB);
  await clicker.click(PDF_TAB);
  await clicker.click(PDF_TAB);

  assert.equal(clicker.opened.length, 1, 'a tab per press would be intolerable');
});

/**
 * The most important test here. The risk in this whole change is a false positive: an
 * article that reads perfectly well being labelled unreadable.
 */
test('a page that reads normally is never marked', async () => {
  const button = makeButton();
  const clicker = makeClicker({ button, answers: () => true });

  assert.equal(await clicker.click(ARTICLE_TAB), 'read');
  assert.equal(button.badgeOn(ARTICLE_TAB.id), '', 'no badge on a working page');
  assert.equal(clicker.opened.length, 0);
});

/**
 * A page clicked while still loading has no content script yet, and answers on the retry.
 * The warning from the first press must not stick to it.
 */
test('a warning is cleared once the page answers', async () => {
  const button = makeButton();
  let loaded = false;
  const clicker = makeClicker({ button, answers: () => loaded });

  await clicker.click(ARTICLE_TAB);
  assert.equal(button.badgeOn(ARTICLE_TAB.id), '?', 'marked while it was not answering');

  loaded = true;
  assert.equal(await clicker.click(ARTICLE_TAB), 'read');
  assert.equal(button.badgeOn(ARTICLE_TAB.id), '', 'the warning must not stick');
});

/** Two tabs, two separate verdicts. A PDF must not put a badge on an article. */
test('one tab’s warning does not reach another', async () => {
  const button = makeButton();
  const clicker = makeClicker({ button, answers: (tab) => tab.id === ARTICLE_TAB.id });

  await clicker.click(PDF_TAB);
  await clicker.click(ARTICLE_TAB);

  assert.equal(button.badgeOn(PDF_TAB.id), '!');
  assert.equal(button.badgeOn(ARTICLE_TAB.id), '');
});

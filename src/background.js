/**
 * Background script.
 *
 * Two jobs. The obvious one is turning a toolbar click into a message to the page. The
 * less obvious one is being the referee between tabs.
 *
 * Why a referee is needed: the browser has ONE speech engine shared by every tab, but a
 * content script can only see its own page. Two pages that both start reading push their
 * sentences into the same queue and the browser plays them in arrival order, so the two
 * articles alternate, a sentence at a time, in one garbled stream. No page can prevent
 * that alone, because no page knows the others exist.
 *
 * This script does know. It is the only part of the add-on that sees every tab, so it is
 * the only place the rule "one tab reads at a time" can live. When a tab is about to
 * start reading it says so, and every other tab that has ever read is told to let go.
 *
 * It deliberately does NOT use tabs.query() to find the other tabs. That would need the
 * broad "tabs" permission — and a scary install warning — to learn something we already
 * know: a tab that has never claimed the voice cannot be holding it, so the only tabs
 * worth messaging are the ones that have introduced themselves.
 */

const api = globalThis.browser ?? globalThis.chrome;

/**
 * Where the neural voice lives.
 *
 * The voice needs a real page to run in: it uses WebAssembly and an audio element, and it
 * has to run under OUR security rules rather than those of whatever website is being read
 * — some sites forbid WebAssembly outright, and a voice that only works on friendly sites
 * would be worse than no voice at all.
 *
 * It goes in a hidden frame inside this background page rather than a visible tab, for the
 * obvious reason that nobody wants a stray tab appearing when they press play. Firefox
 * background pages have a full DOM, so this needs no new permission at all.
 *
 * Created on first use, never on browser start: an add-on that loads 30MB of WebAssembly
 * for someone who has not asked to hear anything is being a bad guest.
 */
const VOICE_PAGE = 'piper/host.html';

/** The frame the voice runs in, so its continued existence can be checked rather than assumed. */
let voiceFrame = null;

/**
 * Is the voice frame still on this page?
 *
 * `isConnected` is the honest answer: a frame removed from the document, or belonging to
 * a document that has since been replaced, reports false. Believing a remembered promise
 * instead is what let a reader connect to a background page whose voice had gone, get an
 * instant disconnect, and fall silent while every layer reported success.
 */
function voiceFrameIsAlive() {
  return Boolean(voiceFrame?.isConnected && voiceFrame.contentWindow);
}

/** Loading a page that pulls in ~30MB of WebAssembly is not instant, but it is not slow. */
const VOICE_PAGE_TIMEOUT_MS = 15000;

let voicePageReady = null;

/**
 * Create the voice page, and do not claim it exists until it is actually listening.
 *
 * The waiting is the whole point. Creating a frame is instant, but the page inside it
 * takes a moment to load and start listening for connections — and a connection made
 * before then does not queue up, it is refused on the spot. So a caller that did not wait
 * would connect to nothing, be disconnected immediately, and conclude that the voice was
 * ready when nothing had been loaded at all. That is exactly the silence this fixes.
 */
function ensureVoicePage() {
  // A cached promise is only as good as the frame it promised. The frame can go without
  // telling anyone — Firefox may end this whole page after a long stall and start it
  // again empty — so what is actually on the page is checked rather than remembered.
  if (voicePageReady && !voiceFrameIsAlive()) {
    voicePageReady = null;
  }
  if (voicePageReady) return voicePageReady;

  // No document means no DOM to put the voice in — nothing to do but say so plainly.
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('the background page has no document to host the voice'));
  }

  voicePageReady = new Promise((resolve, reject) => {
    // The page announces itself once its listener is registered. Waiting for the frame's
    // own load event is not enough: that fires when the document is loaded, which can be
    // a moment before the script inside it is ready to answer.
    const onReady = (message) => {
      if (message?.type !== 'ftts:voice-page-ready') return;
      api.runtime.onMessage.removeListener(onReady);
      clearTimeout(giveUp);
      resolve(true);
    };

    const giveUp = setTimeout(() => {
      api.runtime.onMessage.removeListener(onReady);
      voicePageReady = null; // Let a later attempt try again rather than fail forever.
      reject(new Error('the voice page did not start'));
    }, VOICE_PAGE_TIMEOUT_MS);

    api.runtime.onMessage.addListener(onReady);

    const frame = document.createElement('iframe');
    frame.style.display = 'none';
    frame.src = api.runtime.getURL(VOICE_PAGE);
    document.body.appendChild(frame);
    voiceFrame = frame;
  });

  return voicePageReady;
}

/**
 * The tab currently holding the voice, or null. Advisory only — the truth is whatever
 * the tabs are actually doing, and a tab can vanish without warning (closed, crashed,
 * navigated away), so this is never trusted for anything but who to notify.
 */
let readingTabId = null;

/**
 * Every tab that has ever claimed the voice. A tab is only added when it starts
 * reading, so this stays small: it is not a list of open tabs, it is a list of tabs
 * that have played an article at some point.
 */
const knownReaders = new Set();

/** Tell every other known reader to give up the voice, keeping its place. */
async function askOthersToYield(exceptTabId) {
  const others = [...knownReaders].filter((id) => id !== exceptTabId);

  await Promise.all(
    others.map(async (tabId) => {
      try {
        await api.tabs.sendMessage(tabId, { type: 'ftts:yield' });
      } catch {
        // The tab is gone, was navigated away, or never had a content script. Either
        // way it cannot be holding the voice, so forget it and move on.
        knownReaders.delete(tabId);
      }
    })
  );
}

/**
 * Tabs we have already explained ourselves on, and what we said.
 *
 * Kept so the second click on the same tab can do more than the first. It holds only tabs
 * where a click has already failed, so like `knownReaders` it stays small on its own.
 */
const explained = new Map();

/**
 * Say why a page cannot be read, in the place the owner is actually looking.
 *
 * Silence was the old behaviour and it was the whole fault: the click failed, a line went
 * to the background console — which you have to go into about:debugging to see — and on
 * screen nothing whatsoever happened. A PDF looked exactly like a crashed add-on.
 *
 * Three channels, and the third is deliberately held back. The badge and the tooltip are a
 * whisper: they appear on the button you just pressed, cost nothing, and clear themselves
 * when you navigate. Opening a whole tab is a shout, and a shout at someone who merely
 * mis-clicked is obnoxious — so the page only opens if you press the button AGAIN, which
 * is what someone does when the whisper was not enough.
 *
 * Nothing here can touch the page itself. On exactly these pages we have no content script
 * — that IS the failure — so the toolbar button is the only surface we own.
 */
async function explainFailure(tab, error) {
  const { explainUnreadable } = await import('./lib/unsupported.js');
  const { kind, badge, tooltip, summary } = explainUnreadable(tab.url, tab.title);

  console.warn(
    `Basic Text-to-Speech: cannot read this page (${kind}).`,
    tab.url ?? '',
    error?.message ?? error
  );

  // Per-tab throughout: another tab reading an article normally must not be marked with
  // a warning meant for this one. Firefox clears both by itself when the tab navigates.
  try {
    await api.action.setBadgeText({ text: badge, tabId: tab.id });
    await api.action.setBadgeBackgroundColor?.({ color: '#8f8f9d', tabId: tab.id });
    await api.action.setTitle({ title: `Basic Text-to-Speech — ${tooltip}`, tabId: tab.id });
  } catch {
    // A badge that will not set is a small loss; the second click still explains itself.
  }

  if (explained.get(tab.id) === kind) {
    // The second press on the same tab. The whisper was not enough, so say it properly.
    const page = api.runtime.getURL('unsupported.html');
    const query = `?url=${encodeURIComponent(tab.url ?? '')}&title=${encodeURIComponent(tab.title ?? '')}`;
    try {
      await api.tabs.create({ url: page + query });
    } catch (openError) {
      console.warn('Basic Text-to-Speech:', summary, openError?.message ?? openError);
    }
    explained.delete(tab.id);
    return;
  }

  explained.set(tab.id, kind);
}

/**
 * Send a message to a tab's page script, putting the script there first if need be, and
 * explain on the toolbar button when the page cannot take one at all.
 *
 * Shared by the toolbar icon and the right-click menu: both are "do something on this page",
 * and both meet the same pages that were open before the add-on loaded, or cannot be read.
 */
async function sendToPage(tab, message) {
  if (!tab || typeof tab.id !== 'number') return;

  try {
    try {
      await api.tabs.sendMessage(tab.id, message);
    } catch (firstError) {
      // No content script answered. On a readable page that means it was not there yet — the
      // tab was open before the add-on (re)loaded, or is still loading — so put it in now
      // and try once more. Pages that cannot take a script (PDFs, about:) fail here too and
      // fall through to the explanation below.
      //
      // Firefox may be injecting it at this very moment: this same press is what lets it
      // run on a site not granted outright. So this can put a SECOND copy in the page.
      // content.js knows to step aside when it finds itself already loaded.
      try {
        await api.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      } catch {
        throw firstError;
      }
      await api.tabs.sendMessage(tab.id, message);
    }
    // It answered, so it is readable after all. Clear any warning left from an earlier
    // click — a page that was still loading the first time must not stay marked.
    if (explained.delete(tab.id)) {
      try {
        await api.action.setBadgeText({ text: '', tabId: tab.id });
        await api.action.setTitle({ title: null, tabId: tab.id });
      } catch {
        // Cosmetic only, and the badge clears on the next navigation regardless.
      }
    }
  } catch (error) {
    // Nobody was listening: no content script on this tab. That is a PDF, one of
    // Firefox's own pages, or something genuinely unexpected — and until now all three
    // were indistinguishable from the add-on being broken.
    try {
      await explainFailure(tab, error);
    } catch (explainError) {
      // The explanation is a courtesy, not the job. If explaining the failure itself
      // fails we are back to the old console-only behaviour, which is bad but quiet —
      // whereas letting this reject would raise an unhandled error on every click.
      console.warn(
        'Basic Text-to-Speech: cannot read this page.',
        explainError?.message ?? explainError
      );
    }
  }
}

api.action.onClicked.addListener((tab) => sendToPage(tab, { type: 'ftts:toggle' }));

/**
 * The right-click menu: "Read selection aloud" when text is selected, and "Read from here"
 * when it is not.
 *
 * Made afresh every time this script starts, after clearing whatever was there. Firefox may
 * stop and restart this page on its own, and may or may not have kept the menu from last
 * time; creating it twice would be an error, and not creating it would lose it.
 */
const READ_SELECTION = 'ftts-read-selection';
const READ_FROM_HERE = 'ftts-read-from-here';

async function createMenus() {
  try {
    await api.menus.removeAll();
    api.menus.create({
      id: READ_SELECTION,
      title: 'Read selection aloud',
      contexts: ['selection'],
    });
    // With nothing selected: on the page's text, or on a link within it. Firefox shows
    // "page" only when no more specific kind of click applies, so it never appears
    // alongside "Read selection aloud".
    api.menus.create({
      id: READ_FROM_HERE,
      title: 'Read from here',
      contexts: ['page', 'link'],
    });
  } catch (error) {
    // No menu is a lost shortcut, not a broken add-on: the toolbar icon still works.
    console.warn(
      'Basic Text-to-Speech: could not add the right-click menu.',
      error?.message ?? error
    );
  }
}

createMenus();

api.menus?.onClicked.addListener((info, tab) => {
  if (info?.menuItemId === READ_FROM_HERE) {
    // Where exactly was clicked is known only to the page, which noted it as it happened.
    sendToPage(tab, { type: 'ftts:read-from-here' });
    return;
  }
  if (info?.menuItemId !== READ_SELECTION) return;
  // The browser's copy of the selected text travels too, for a selection the page script
  // cannot find as text on the page — one inside a form field.
  sendToPage(tab, { type: 'ftts:read-selection', text: info.selectionText ?? '' });
});

api.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message.type !== 'string') return undefined;

  if (message.type === 'ftts:voice-page') {
    // A page is about to use the neural voice and needs somewhere for it to run. The
    // answer is deliberately withheld until the voice page is genuinely listening —
    // replying early is what previously made a tab connect to nothing and hear silence.
    return ensureVoicePage().then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error: String(error?.message ?? error) })
    );
  }

  if (message.type === 'ftts:voices-on-disk') {
    /*
     * The settings page asking which voices are already downloaded.
     *
     * It goes through here rather than straight to the voice page for one reason: the
     * voice page may not exist yet. It is created on first use and never on browser start,
     * so someone who opens settings before ever pressing play would otherwise be asking a
     * question of a page that is not there and getting silence back.
     *
     * A failure answers with an empty list rather than an error. Not knowing what is
     * stored means showing every voice as possibly needing a download, which is merely
     * pessimistic — refusing to open the settings page would be worse.
     */
    return ensureVoicePage()
      .then(() => api.runtime.sendMessage({ type: 'ftts:stored-voices' }))
      .then(
        (reply) => ({ ok: true, voices: Array.isArray(reply?.voices) ? reply.voices : [] }),
        (error) => ({ ok: false, voices: [], error: String(error?.message ?? error) })
      );
  }

  if (message.type === 'ftts:fetch-voice') {
    /*
     * The settings page asking for a voice to be downloaded.
     *
     * Passed to the voice page as a plain message rather than over the connection a reader
     * uses, because that connection means "I speak now" and would stop an article that is
     * playing. Someone choosing a new voice while listening must not be cut off by the
     * download that choice needs.
     */
    /*
     * NOTE THE TWO DIFFERENT NAMES, which is not tidiness but a loop that would otherwise
     * hang the add-on. This script and the voice page share one message bus, and this
     * script is itself a listener on it — so re-broadcasting the name it just received
     * would deliver the message straight back to this branch, forever. The voice page
     * therefore answers to a name nothing else sends.
     */
    return ensureVoicePage()
      .then(() =>
        api.runtime.sendMessage({ type: 'ftts:do-fetch-voice', voiceId: message.voiceId })
      )
      .then(
        (reply) => reply ?? { ok: false, error: 'the voice did not answer' },
        (error) => ({ ok: false, error: String(error?.message ?? error) })
      );
  }

  if (message.type === 'ftts:remove-voice') {
    /*
     * The settings page asking for a voice to be deleted from this machine.
     *
     * Relayed under a different name than it arrives as, like the fetch above, because
     * this script listens on the same bus it sends on and would otherwise hear itself.
     */
    return ensureVoicePage()
      .then(() =>
        api.runtime.sendMessage({ type: 'ftts:do-remove-voice', voiceId: message.voiceId })
      )
      .then(
        (reply) => reply ?? { ok: false, error: 'the voice did not answer' },
        (error) => ({ ok: false, error: String(error?.message ?? error) })
      );
  }

  // Everything below is a message from a specific article tab. The voice page has no tab
  // of its own, so this check comes after it rather than before.
  const tabId = sender?.tab?.id;
  if (typeof tabId !== 'number') return undefined;

  if (message.type === 'ftts:claim') {
    // A tab is about to speak. Clear the others out of the way FIRST, then let it
    // start — the reply is what unblocks it, so the order here is what prevents the
    // overlap. Returning the promise keeps the message channel open until it resolves.
    knownReaders.add(tabId);
    readingTabId = tabId;
    return askOthersToYield(tabId).then(() => ({ ok: true }));
  }

  if (message.type === 'ftts:released' && readingTabId === tabId) {
    // Guarded on purpose: a late "I have stopped" from a tab that has already been
    // taken over must not clear the new reader's claim.
    readingTabId = null;
  }

  return undefined;
});

// A tab that closes cannot tell us it has stopped reading.
api.tabs.onRemoved.addListener((tabId) => {
  knownReaders.delete(tabId);
  explained.delete(tabId);
  if (readingTabId === tabId) readingTabId = null;
});

/**
 * The settings page.
 *
 * One job for now: choosing which voice reads articles. It is deliberately thin — it reads
 * the voices from config.js, asks the voice page which of them are already downloaded, and
 * writes the choice back to stored settings. It does not speak, and it never holds the
 * voice: a reading tab must not lose its place because someone opened settings.
 *
 * How the choice reaches an article already playing: it does not, directly. This page
 * writes the setting, and every reading tab is listening for that write (see
 * watchSettings in content.js). Two tabs that cannot see each other sharing one piece of
 * storage is the whole mechanism, and it is why this file has no idea what is playing.
 */

import { PIPER_VOICE_LIST, PIPER_VOICE_SIZE_MB, resolveConfig } from '../lib/config.js';

const api = globalThis.browser ?? globalThis.chrome;

/** How long to wait for a voice to download before saying so. Matches the engine's own. */
const DOWNLOAD_TIMEOUT_MS = 180000;

const voicesEl = document.getElementById('voices');
const loadingEl = document.getElementById('loading');
const noteEl = document.getElementById('note');

/** Which voices are on this machine. Empty until the voice page answers. */
let stored = new Set();

/** The chosen voice, as stored settings have it. */
let chosen = null;

/** The voice being downloaded right now, or null. Only one at a time. */
let downloading = null;

/** The voice being deleted right now, or null. Deleting is quick, but not instant. */
let removing = null;

function say(message) {
  if (!noteEl) return;
  noteEl.textContent = message ?? '';
  noteEl.hidden = !message;
}

/** Read the current choice out of stored settings, falling back to the default. */
async function readChosen() {
  try {
    const settings = await api.storage.local.get('settings');
    return resolveConfig(settings?.settings).piperVoiceId;
  } catch {
    return resolveConfig(null).piperVoiceId;
  }
}

/**
 * Ask which voices are already downloaded.
 *
 * An empty answer is treated as "we do not know" rather than "none are here", which is why
 * a failure is not reported to the person: every voice then simply shows its download size,
 * and picking one that is in fact already present is instant. Being pessimistic about this
 * costs nothing; being wrong the other way would promise an instant switch and then stall.
 */
async function readStored() {
  try {
    const reply = await api.runtime.sendMessage({ type: 'ftts:voices-on-disk' });
    return new Set(Array.isArray(reply?.voices) ? reply.voices : []);
  } catch {
    return new Set();
  }
}

/** How a voice is described in the list: who it is, and how good it sounds. */
function about(voice) {
  return voice.quality === 'high'
    ? `${voice.description} · higher quality, slower to build each sentence`
    : voice.description;
}

/** What the right-hand side of a row says. */
function stateText(voice) {
  if (downloading === voice.id) return 'downloading…';
  if (removing === voice.id) return 'removing…';
  if (stored.has(voice.id)) return 'on this machine';
  const size = PIPER_VOICE_SIZE_MB[voice.quality] ?? PIPER_VOICE_SIZE_MB.medium;
  return `${size}MB download`;
}

/** Build the list once; after that only the rows' state changes. */
function render() {
  if (!voicesEl) return;
  loadingEl?.remove();

  voicesEl.textContent = '';

  for (const voice of PIPER_VOICE_LIST) {
    const row = document.createElement('label');
    row.className = 'voice';
    row.dataset.voice = voice.id;

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'voice';
    radio.value = voice.id;
    radio.checked = voice.id === chosen;

    const text = document.createElement('span');
    text.className = 'voice-text';

    const name = document.createElement('span');
    name.className = 'voice-name';
    name.textContent = voice.name;

    const description = document.createElement('span');
    description.className = 'voice-about';
    description.textContent = about(voice);

    const state = document.createElement('span');
    state.className = 'voice-state';

    /*
     * The remove button, and the one fiddly thing on this page.
     *
     * The row is a <label>, so a click ANYWHERE inside it — this button included — also
     * selects the radio it wraps. That is exactly what makes the rest of the row pleasant
     * to click and exactly what would make remove select the voice it is about to delete.
     * Hence preventDefault and stopPropagation below: the press must reach this button and
     * go no further.
     */
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'voice-remove';
    remove.textContent = '✕';
    remove.title = `Remove ${voice.name} from this machine`;
    remove.setAttribute('aria-label', `Remove ${voice.name} from this machine`);

    remove.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      forget(voice);
    });

    text.append(name, description);
    row.append(radio, text, state, remove);

    radio.addEventListener('change', () => {
      if (radio.checked) choose(voice);
    });

    voicesEl.append(row);
  }

  paint();
}

/** Bring every row up to date with what is chosen, stored and downloading. */
function paint() {
  for (const row of voicesEl?.querySelectorAll('.voice') ?? []) {
    const voice = PIPER_VOICE_LIST.find((entry) => entry.id === row.dataset.voice);
    if (!voice) continue;

    const current = voice.id === chosen;
    const busy = downloading ?? removing;
    row.dataset.current = String(current);
    row.dataset.state = downloading === voice.id || removing === voice.id ? 'working' : 'idle';
    // Every other row is made unclickable while one is downloading or being removed,
    // rather than left live and silently ignored. A control that looks pressable and does
    // nothing is the exact fault that cost two sessions on the speed button.
    row.dataset.busy = String(Boolean(busy) && busy !== voice.id);

    const state = row.querySelector('.voice-state');
    if (state) state.textContent = stateText(voice);

    const radio = row.querySelector('input');
    if (radio) radio.checked = current;

    /*
     * Remove is offered only where it would actually work: the voice is on this machine,
     * it is not the one in use, and nothing is busy.
     *
     * HIDDEN RATHER THAN DISABLED for the voice in use, because the two say different
     * things. A disabled button says "not now"; no button at all says "not this one" —
     * and the way to remove this voice is to choose another first, which a greyed-out
     * button would not communicate. The note below says so when someone tries.
     */
    const remove = row.querySelector('.voice-remove');
    if (remove) {
      const removable = stored.has(voice.id) && !current && !downloading && removing !== voice.id;
      remove.hidden = !removable;
    }
  }
}

/**
 * Remember the chosen voice.
 *
 * Merged into whatever else is stored rather than written over it, because this page knows
 * about one setting and the bar owns several others — writing the whole object would wipe
 * the speed someone set while listening.
 */
async function save(voiceId) {
  const settings = await api.storage.local.get('settings');
  await api.storage.local.set({
    settings: { ...(settings?.settings ?? {}), piperVoiceId: voiceId },
  });
}

/**
 * Pick a voice, downloading it first if this machine does not have it.
 *
 * THE ORDER MATTERS. The setting is saved only once the voice is actually here, because
 * saving it is what tells a playing article to switch. Saving first would point a reading
 * tab at a voice that does not exist yet, and it would sit in silence waiting for a 60MB
 * download nobody had told it about.
 */
async function choose(voice) {
  if (downloading) return;
  if (voice.id === chosen) return;

  if (stored.has(voice.id)) {
    chosen = voice.id;
    paint();
    await save(voice.id);
    say(`Articles will now be read by ${voice.name}.`);
    return;
  }

  downloading = voice.id;
  paint();
  const size = PIPER_VOICE_SIZE_MB[voice.quality] ?? PIPER_VOICE_SIZE_MB.medium;
  say(`Downloading ${voice.name} — about ${size}MB, once. You can leave this page open.`);

  try {
    await download(voice.id);
    stored.add(voice.id);
    chosen = voice.id;
    await save(voice.id);
    say(`${voice.name} is ready. Articles will now be read by ${voice.name}.`);
  } catch (error) {
    say(`${voice.name} could not be downloaded: ${error?.message ?? error}`);
  } finally {
    downloading = null;
    paint();
  }
}

/**
 * Delete a voice from this machine.
 *
 * Confirmed first, because the ✕ sits inches from the row you click to CHOOSE a voice, and
 * the cost of a slip is a 60MB download all over again. Nothing is lost that cannot be got
 * back, which is why one confirm is enough and there is no undo.
 *
 * The voice in use has no remove button at all, so reaching this with one is only possible
 * by a race — choosing a voice in another window between the button being drawn and
 * pressed. The voice page refuses that case on its own, since it knows what is actually
 * loaded rather than what a setting says, and its refusal is simply reported.
 */
async function forget(voice) {
  if (downloading || removing) return;
  if (voice.id === chosen) {
    say(`${voice.name} is the voice being used. Choose another voice first, then remove it.`);
    return;
  }

  const sure = globalThis.confirm(
    `Remove ${voice.name} from this machine?\n\n` +
      `It can be downloaded again later, but that means waiting for the download once more.`
  );
  if (!sure) return;

  removing = voice.id;
  paint();
  say(`Removing ${voice.name}…`);

  try {
    const reply = await api.runtime.sendMessage({ type: 'ftts:remove-voice', voiceId: voice.id });
    if (!reply?.ok) throw new Error(reply?.error ?? 'it failed');
    stored.delete(voice.id);
    say(`${voice.name} was removed. It can be downloaded again whenever you want it.`);
  } catch (error) {
    /*
     * Ask the disk what is really there before saying anything.
     *
     * A removal that failed leaves this page's idea of what is stored possibly wrong, and
     * a WRONG list is what caused the original fault — a voice shown as present that was
     * not, offering no download. Re-reading costs one message and makes the row honest
     * whichever way the delete went.
     */
    stored = await readStored();
    say(`${voice.name} could not be removed: ${error?.message ?? error}`);
  } finally {
    removing = null;
    paint();
  }
}

/**
 * Download one voice.
 *
 * DELIBERATELY NOT OVER THE READER'S CONNECTION, and this is the one thing about this page
 * that is easy to get wrong. Connecting as `ftts:piper` means "I am the page that speaks
 * now", and the voice page stops whatever the previous connection was playing. Downloading
 * a voice that way would silence the article the listener is in the middle of — killing
 * the very thing choosing a voice mid-article exists to allow.
 *
 * So it is a plain request instead: fetch this onto the machine, disturb nothing. The
 * background script passes it on, because the voice page may not exist yet.
 */
function download(voiceId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stopListening();
      reject(new Error('it took too long'));
    }, DOWNLOAD_TIMEOUT_MS);

    // Progress arrives as its own broadcast rather than in the reply, because the reply
    // comes once and only at the end — which is precisely when progress stops mattering.
    const onProgress = (message) => {
      if (message?.type !== 'ftts:voice-progress') return;
      if (message.voiceId !== voiceId) return;
      if (message.phase !== 'downloading') return;
      const voice = PIPER_VOICE_LIST.find((entry) => entry.id === voiceId);
      say(`Downloading ${voice?.name ?? voiceId} — ${message.percent}%`);
    };

    const stopListening = () => {
      clearTimeout(timer);
      try {
        api.runtime.onMessage.removeListener(onProgress);
      } catch {
        // Nothing left to detach.
      }
    };

    try {
      api.runtime.onMessage.addListener(onProgress);
    } catch {
      // No progress display, but the download itself can still go ahead.
    }

    api.runtime.sendMessage({ type: 'ftts:fetch-voice', voiceId }).then(
      (reply) => {
        stopListening();
        if (reply?.ok) resolve(true);
        else reject(new Error(reply?.error ?? 'it failed'));
      },
      (error) => {
        stopListening();
        reject(new Error(String(error?.message ?? error)));
      }
    );
  });
}

async function start() {
  chosen = await readChosen();
  stored = await readStored();
  render();
}

start().catch((error) => {
  loadingEl?.remove();
  say(`The voices could not be listed: ${error?.message ?? error}`);
});

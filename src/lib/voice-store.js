/**
 * The rules about which voices may be deleted.
 *
 * Split out of the voice page for the same reason the pipeline was: that page cannot be
 * loaded in a test — it reaches for WebAssembly, an AudioContext and 60MB of model on the
 * way in — so a decision left inside it can only be checked by hand, on a real machine,
 * by deleting a real voice. This one is worth more certainty than that.
 *
 * It holds no state and touches no files. It answers one question — may this voice be
 * removed, and if not why — and the page does the deleting.
 */

/**
 * Whether a voice may be deleted from this machine.
 *
 * @param {string} voiceId the voice someone wants to remove
 * @param {object} [state]
 * @param {string|null} [state.loadedVoiceId] the voice actually loaded and able to speak
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function canRemoveVoice(voiceId, state = {}) {
  if (typeof voiceId !== 'string' || voiceId === '') {
    return { ok: false, error: 'no voice was named' };
  }

  /*
   * THE CHECK THAT MATTERS, and the reason it lives on the voice page's side rather than
   * only in the settings page.
   *
   * The settings page hides remove for the voice in use, but it decides that from a
   * STORED SETTING. This asks what is actually LOADED — the model parsed and ready to
   * speak. The two can disagree: a second window changing voice, a setting written but
   * not yet acted on, a reader still finishing a sentence in the old voice.
   *
   * Deleting the loaded voice would leave the reader holding a model whose files are
   * gone. It would not fail loudly; it would simply stop making sound, which is exactly
   * the kind of silent fault this project has already spent sessions chasing.
   */
  if (state.loadedVoiceId && voiceId === state.loadedVoiceId) {
    return { ok: false, error: 'that voice is the one being used' };
  }

  return { ok: true };
}

/** Where the voice library keeps its files. */
const STORAGE_DIRECTORY = 'piper';

/**
 * The files one voice is made of, as they are named on disk.
 *
 * A voice is a model and a small `.json` beside it, both stored under their plain
 * basename. Derived from the library's own path map so this cannot drift from where the
 * download actually put them.
 *
 * @param {string} voiceId
 * @param {Record<string, string>} pathMap the library's PATH_MAP
 * @returns {string[]}
 */
export function voiceFileNames(voiceId, pathMap) {
  const path = pathMap?.[voiceId];
  if (typeof path !== 'string' || path === '') return [];
  const name = path.split('/').at(-1);
  return [name, `${name}.json`];
}

/**
 * Delete one voice's files from the browser's private storage.
 *
 * WHY THIS EXISTS RATHER THAN THE LIBRARY'S OWN `remove`. The vendored library deletes a
 * file by calling `handle.remove()` — a method Firefox does not implement. It throws, and
 * the library catches the error and writes it to the console, so the call RESOLVES exactly
 * as it would have on success. The add-on reported a voice deleted, the disk kept it, and
 * the settings page went on saying "on this machine" with no download offered. Nothing in
 * that chain lied except the library, and it lied by succeeding.
 *
 * `removeEntry` on the DIRECTORY is the call Firefox supports, and it is the standard one.
 *
 * Every failure is reported rather than swallowed, which is the whole point of not using
 * the library's version. A file that was already gone is NOT a failure — that is the
 * desired state — so it is the only error tolerated.
 *
 * @param {string[]} names files to delete
 * @param {object} deps
 * @param {() => Promise<FileSystemDirectoryHandle>} deps.getDirectory the storage root
 * @returns {Promise<{removed: string[], missing: string[]}>}
 */
export async function deleteVoiceFiles(names, { getDirectory }) {
  const root = await getDirectory();
  const directory = await root.getDirectoryHandle(STORAGE_DIRECTORY, { create: true });

  const removed = [];
  const missing = [];

  for (const name of names) {
    try {
      await directory.removeEntry(name);
      removed.push(name);
    } catch (error) {
      // Already gone is success by another name: the caller wanted it absent, and it is.
      if (error?.name === 'NotFoundError') {
        missing.push(name);
        continue;
      }
      throw error;
    }
  }

  return { removed, missing };
}

/** No real model is smaller than this; a smaller file is an error page or a cut-off write. */
const MIN_MODEL_BYTES = 1024 * 1024;

/**
 * Download one voice and save it, resolving only once BOTH files are safely on disk.
 *
 * WHY THIS EXISTS RATHER THAN THE LIBRARY'S OWN `download`. The library starts saving each
 * file but does not wait for the save to finish, so its download "finished" while 60MB was
 * still being written. The voice was then loaded straight away from a half-written file —
 * "No graph was found in the protobuf" — and the first article ever read fell back to a
 * silent voice; after a reload the write had long finished and everything worked. It also
 * never checked the server's answer, so an error page could be saved as a voice and kept
 * for good. Found 2026-10-02 in a fresh-profile run.
 *
 * The model is written LAST, because "is this voice on this machine" is answered by the
 * model's presence: until it exists, the voice is simply not there and is downloaded again.
 *
 * @param {object} options
 * @param {string} options.voiceId
 * @param {Record<string, string>} options.pathMap the library's PATH_MAP
 * @param {string} options.base where voices are downloaded from (the library's HF_BASE)
 * @param {typeof fetch} options.fetch
 * @param {() => Promise<FileSystemDirectoryHandle>} options.getDirectory the storage root
 * @param {(progress: {loaded: number, total: number}) => void} [options.onProgress]
 */
export async function downloadVoiceFiles({
  voiceId,
  pathMap,
  base,
  fetch,
  getDirectory,
  onProgress,
}) {
  const [modelName, configName] = voiceFileNames(voiceId, pathMap);
  if (!modelName) throw new Error(`unknown voice "${voiceId}"`);
  const modelUrl = `${base}/${pathMap[voiceId]}`;

  const config = await fetchWhole(fetch, `${modelUrl}.json`);
  try {
    JSON.parse(await config.text());
  } catch {
    throw new Error('the voice settings file did not arrive intact');
  }

  const model = await fetchWhole(fetch, modelUrl, onProgress);
  if (model.size < MIN_MODEL_BYTES) throw new Error('the voice did not arrive intact');

  const root = await getDirectory();
  const directory = await root.getDirectoryHandle(STORAGE_DIRECTORY, { create: true });
  try {
    await writeFile(directory, configName, config);
    await writeFile(directory, modelName, model);
  } catch (error) {
    // Leave nothing half-saved behind to be mistaken for a voice later.
    await deleteVoiceFiles([modelName, configName], { getDirectory }).catch(() => {});
    throw error;
  }
}

/**
 * Whether a saved voice is whole: both files there, and the model a plausible size.
 *
 * Asked before trusting the library's `stored`, which only checks that a model file
 * EXISTS — an empty one left by a browser closed mid-save would count, and would then
 * fail to load every time with nothing ever downloading it again.
 */
export async function voiceFilesAreWhole(voiceId, pathMap, { getDirectory }) {
  const [modelName, configName] = voiceFileNames(voiceId, pathMap);
  if (!modelName) return false;
  try {
    const root = await getDirectory();
    const directory = await root.getDirectoryHandle(STORAGE_DIRECTORY, { create: true });
    const model = await (await directory.getFileHandle(modelName)).getFile();
    await directory.getFileHandle(configName);
    return model.size >= MIN_MODEL_BYTES;
  } catch {
    return false;
  }
}

async function fetchWhole(fetch, url, onProgress) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`the voice download failed (HTTP ${response.status})`);

  // Only comparable to what arrives when the server did not compress it on the way.
  const compressed = Boolean(response.headers.get('Content-Encoding'));
  const total = Number(response.headers.get('Content-Length') ?? 0) || 0;

  const chunks = [];
  let loaded = 0;
  const reader = response.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.({ loaded, total });
  }

  if (!compressed && total > 0 && loaded !== total) {
    throw new Error('the voice download was cut short');
  }
  return new Blob(chunks);
}

async function writeFile(directory, name, blob) {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

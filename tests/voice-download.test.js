/**
 * Tests for downloading a voice — the step the library got wrong.
 *
 * The library's download said "done" before the 60MB model was written, so the first
 * article ever read loaded a half-written file and fell back to a silent voice. These
 * check that our own download only finishes once both files are really saved, and that a
 * failed or cut-short download leaves nothing behind that could pass for a voice.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/* global TextEncoder, Response */

import { downloadVoiceFiles, voiceFilesAreWhole } from '../src/lib/voice-store.js';

const PATH_MAP = { 'en_US-amy-medium': 'en/en_US/amy/medium/en_US-amy-medium.onnx' };
const BASE = 'https://huggingface.co/x';
const MODEL = 'en_US-amy-medium.onnx';
const CONFIG = 'en_US-amy-medium.onnx.json';
const MB = 1024 * 1024;

/** Private storage whose saves take a while to land, like a real 60MB write. */
function fakeStorage({ failWriting } = {}) {
  const files = new Map();
  const directory = {
    files,
    async getFileHandle(name, { create } = {}) {
      if (!files.has(name) && !create) {
        throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
      }
      if (!files.has(name)) files.set(name, new Blob([]));
      return {
        getFile: async () => files.get(name),
        createWritable: async () => {
          let pending = null;
          return {
            write: async (blob) => {
              pending = blob;
            },
            close: async () => {
              await new Promise((resolve) => setTimeout(resolve, 20));
              if (failWriting === name) throw new Error('disk full');
              files.set(name, pending);
            },
          };
        },
      };
    },
    async removeEntry(name) {
      if (!files.delete(name)) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
    },
  };
  return { directory, getDirectory: async () => ({ getDirectoryHandle: async () => directory }) };
}

/** A server that answers with the given bodies, optionally lying about their length. */
function fakeFetch({ modelBytes = 2 * MB, status = 200, claimedModelBytes } = {}) {
  return async (url) => {
    const body = url.endsWith('.json')
      ? new TextEncoder().encode('{"audio":{}}')
      : new Uint8Array(modelBytes);
    const length = url.endsWith('.json') ? body.length : (claimedModelBytes ?? body.length);
    return new Response(status === 200 ? body : 'Not found', {
      status,
      headers: { 'Content-Length': String(length) },
    });
  };
}

const download = (storage, fetch, onProgress) =>
  downloadVoiceFiles({
    voiceId: 'en_US-amy-medium',
    pathMap: PATH_MAP,
    base: BASE,
    fetch,
    getDirectory: storage.getDirectory,
    onProgress,
  });

test('the download finishes only once both files are saved in full', async () => {
  const storage = fakeStorage();
  const progress = [];
  await download(storage, fakeFetch(), (p) => progress.push(p));

  assert.equal(storage.directory.files.get(MODEL).size, 2 * MB, 'the whole model is on disk');
  assert.ok(storage.directory.files.get(CONFIG).size > 0);
  assert.equal(progress.at(-1).loaded, 2 * MB);
  assert.equal(progress.at(-1).total, 2 * MB);
  assert.equal(
    await voiceFilesAreWhole('en_US-amy-medium', PATH_MAP, storage),
    true,
    'and it counts as a voice on this machine'
  );
});

test('a server error is not saved as a voice', async () => {
  const storage = fakeStorage();
  await assert.rejects(download(storage, fakeFetch({ status: 404 })), /HTTP 404/);
  assert.equal(storage.directory.files.size, 0);
  assert.equal(await voiceFilesAreWhole('en_US-amy-medium', PATH_MAP, storage), false);
});

test('a download cut short is not saved', async () => {
  const storage = fakeStorage();
  await assert.rejects(download(storage, fakeFetch({ claimedModelBytes: 3 * MB })), /cut short/);
  assert.equal(storage.directory.files.size, 0);
});

test('a save that fails leaves nothing half-saved behind', async () => {
  const storage = fakeStorage({ failWriting: MODEL });
  await assert.rejects(download(storage, fakeFetch()), /disk full/);
  assert.equal(storage.directory.files.has(MODEL), false);
  assert.equal(storage.directory.files.has(CONFIG), false);
});

test('an empty or lone model file does not count as a voice', async () => {
  const empty = fakeStorage();
  empty.directory.files.set(MODEL, new Blob([]));
  empty.directory.files.set(CONFIG, new Blob(['{}']));
  assert.equal(await voiceFilesAreWhole('en_US-amy-medium', PATH_MAP, empty), false);

  const lone = fakeStorage();
  lone.directory.files.set(MODEL, new Blob([new Uint8Array(2 * MB)]));
  assert.equal(await voiceFilesAreWhole('en_US-amy-medium', PATH_MAP, lone), false);
});

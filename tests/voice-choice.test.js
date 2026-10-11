/**
 * Tests for choosing a voice.
 *
 * Three things are worth pinning here, and they are the three that would be expensive to
 * discover by ear:
 *
 *   - the voice list is DATA the settings page reads, so a voice added to config must
 *     appear without anything else being touched;
 *   - a voice id that came off disk is not trusted, because stored settings can be stale
 *     or hand-edited and this one is handed to a model loader;
 *   - the engine can be TOLD a new voice mid-article, and re-stating the one already
 *     speaking costs nothing — because acting on a change throws away every sentence
 *     banked ahead and may download 60MB.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULTS,
  describeVoice,
  PIPER_VOICE_LIST,
  PIPER_VOICE_SIZE_MB,
  PIPER_VOICES,
  resolveConfig,
} from '../src/lib/config.js';
import { createPiperEngine } from '../src/lib/engines/piper.js';
import { canRemoveVoice, deleteVoiceFiles, voiceFileNames } from '../src/lib/voice-store.js';

/** A stand-in for the extension's connection to the voice page. */
function fakeApi() {
  const ports = [];

  return {
    ports,
    get port() {
      return ports[ports.length - 1];
    },
    runtime: {
      connect() {
        const port = {
          sent: [],
          messageListeners: [],
          disconnectListeners: [],
          postMessage(message) {
            this.sent.push(message);
          },
          disconnect() {},
          onMessage: {
            addListener(fn) {
              port.messageListeners.push(fn);
            },
          },
          onDisconnect: {
            addListener(fn) {
              port.disconnectListeners.push(fn);
            },
          },
          lastOf(type) {
            return [...this.sent].reverse().find((message) => message.type === type);
          },
          allOf(type) {
            return this.sent.filter((message) => message.type === type);
          },
        };
        ports.push(port);
        return port;
      },
    },
  };
}

test('every voice offered has everything the settings page needs to describe it', () => {
  assert.ok(PIPER_VOICE_LIST.length > 0);

  for (const voice of PIPER_VOICE_LIST) {
    assert.equal(typeof voice.id, 'string', `${voice.name} needs an id`);
    assert.notEqual(voice.id, '');
    assert.equal(typeof voice.name, 'string', `${voice.id} needs a name a person recognises`);
    assert.notEqual(voice.name, '');
    assert.equal(typeof voice.description, 'string');
    // The size shown before someone commits to a download comes from this, so a quality
    // with no size would silently show "undefined MB".
    assert.ok(
      PIPER_VOICE_SIZE_MB[voice.quality],
      `${voice.id} has quality "${voice.quality}" with no known download size`
    );
  }
});

test('the id list is derived from the voices, so the two cannot disagree', () => {
  assert.deepEqual(
    PIPER_VOICES,
    PIPER_VOICE_LIST.map((voice) => voice.id)
  );
});

test('no two voices share an id', () => {
  assert.equal(new Set(PIPER_VOICES).size, PIPER_VOICES.length);
});

test('the default voice is one we actually offer', () => {
  assert.ok(PIPER_VOICES.includes(DEFAULTS.piperVoiceId));
});

test('describeVoice explains a voice we offer, and refuses one we do not', () => {
  assert.equal(describeVoice('en_US-amy-medium')?.name, 'Amy');
  assert.equal(describeVoice('en_US-nobody-medium'), null);
  assert.equal(describeVoice(undefined), null);
});

test('a stored voice we do not offer is ignored rather than trusted', () => {
  // This value reaches a model loader, and stored settings come off disk where they may
  // be stale — a voice removed in a later version, or simply mistyped by hand.
  for (const bad of ['en_US-nobody-medium', '', null, 42, { id: 'amy' }]) {
    assert.equal(resolveConfig({ piperVoiceId: bad }).piperVoiceId, DEFAULTS.piperVoiceId);
  }
});

test('Lessac is no longer offered, and a saved choice of it falls back to the default', () => {
  // Removed 2026-09-30: its recordings are licensed for research only, so a published
  // add-on must not offer it. Anyone who had picked it gets the default voice instead.
  for (const id of ['en_US-lessac-medium', 'en_US-lessac-high']) {
    assert.equal(describeVoice(id), null);
    assert.equal(resolveConfig({ piperVoiceId: id }).piperVoiceId, DEFAULTS.piperVoiceId);
  }
});

test('a stored voice we do offer is honoured', () => {
  assert.equal(resolveConfig({ piperVoiceId: 'en_US-ryan-high' }).piperVoiceId, 'en_US-ryan-high');
});

test('changing voice mid-article tells the voice page, and reports that it changed', () => {
  const api = fakeApi();
  const engine = createPiperEngine({ api, voiceId: 'en_US-amy-medium' });

  assert.equal(engine.voice(), 'en_US-amy-medium');
  assert.equal(engine.setVoice('en_US-ryan-high'), true);
  assert.equal(engine.voice(), 'en_US-ryan-high');

  assert.equal(api.port.lastOf('voice')?.voiceId, 'en_US-ryan-high');
});

test('re-stating the voice already speaking costs nothing', () => {
  // Acting on this would bin every sentence banked ahead and, on a first run, download
  // 60MB. A setting written again with the same value must therefore be silent — the same
  // rule the speed change follows for the same reason.
  const api = fakeApi();
  const engine = createPiperEngine({ api, voiceId: 'en_US-amy-medium' });

  assert.equal(engine.setVoice('en_US-amy-medium'), false);
  assert.equal(api.ports.length, 0, 'it should not even open a connection');
});

test('a voice change that is not a voice is refused', () => {
  const api = fakeApi();
  const engine = createPiperEngine({ api, voiceId: 'en_US-amy-medium' });

  for (const bad of ['', null, undefined, 7]) {
    assert.equal(engine.setVoice(bad), false);
  }
  assert.equal(engine.voice(), 'en_US-amy-medium');
});

test('the new voice is used by what is sent afterwards, not the one built with', async () => {
  // The whole point of making voiceId a let: prepare used to close over the id captured at
  // construction, so a switch would tell the voice page one thing and then ask it for
  // audio in the old voice.
  const api = fakeApi();
  const engine = createPiperEngine({ api, voiceId: 'en_US-amy-medium' });

  engine.setVoice('en_US-joe-medium');

  const prepared = engine.prepare({ rate: 1, articleId: 'x' });
  await new Promise((resolve) => setImmediate(resolve));

  const sent = api.port.lastOf('prepare');
  assert.equal(sent.voiceId, 'en_US-joe-medium');

  // Let the pending request settle so the test does not leave a promise hanging.
  api.port.messageListeners.forEach((listener) => listener({ type: 'ready', id: sent.id }));
  await prepared;
});

/* ---------------------------------------------------------------------------------------
 * Removing a voice.
 * ------------------------------------------------------------------------------------ */

test('a voice that is not in use may be removed', () => {
  assert.deepEqual(canRemoveVoice('en_US-joe-medium', { loadedVoiceId: 'en_US-amy-medium' }), {
    ok: true,
  });
});

test('the voice actually loaded may never be removed', () => {
  // Deleting it would leave the reader holding a model whose files are gone. It would not
  // fail loudly — it would simply stop making sound, which is the worst kind of fault this
  // project has had.
  const answer = canRemoveVoice('en_US-amy-medium', { loadedVoiceId: 'en_US-amy-medium' });
  assert.equal(answer.ok, false);
  assert.match(answer.error, /being used/);
});

test('removal is judged on what is LOADED, not on what is merely stored as a setting', () => {
  // The settings page hides remove for the voice its SETTING names. This side asks what is
  // parsed and able to speak, and the two can disagree — a second window changing voice, or
  // a reader still finishing a sentence in the voice it is being switched away from.
  assert.equal(canRemoveVoice('en_US-ryan-high', { loadedVoiceId: 'en_US-ryan-high' }).ok, false);
  assert.equal(canRemoveVoice('en_US-ryan-high', { loadedVoiceId: null }).ok, true);
  assert.equal(canRemoveVoice('en_US-ryan-high', {}).ok, true);
});

test('a removal that names no voice is refused rather than guessed at', () => {
  for (const bad of ['', null, undefined, 7, {}]) {
    assert.equal(canRemoveVoice(bad, { loadedVoiceId: 'en_US-amy-medium' }).ok, false);
  }
});

test('a voice is deleted by the files the download actually wrote', () => {
  // Derived from the library's own path map so the two cannot drift: a voice is the model
  // and the small .json beside it, both under their plain basename.
  const pathMap = { 'en_US-amy-medium': 'en/en_US/amy/medium/en_US-amy-medium.onnx' };

  assert.deepEqual(voiceFileNames('en_US-amy-medium', pathMap), [
    'en_US-amy-medium.onnx',
    'en_US-amy-medium.onnx.json',
  ]);
});

test('a voice the library does not know has no files to delete', () => {
  assert.deepEqual(voiceFileNames('en_US-nobody-medium', {}), []);
  assert.deepEqual(voiceFileNames('en_US-amy-medium', undefined), []);
});

test('deleting uses removeEntry on the directory, which is what Firefox implements', async () => {
  /*
   * THE BUG THIS EXISTS FOR, and it is worth stating exactly because nothing reported it.
   *
   * The vendored library deletes by calling `handle.remove()`. Firefox has no such method,
   * so it throws — and the library catches that, writes it to the console, and RESOLVES.
   * The add-on then said the voice was removed, the disk kept it, and the settings page
   * went on offering it as "on this machine" with no download. The library lied by
   * succeeding, which is the hardest kind of lie to notice.
   */
  const removed = [];
  const directory = {
    removeEntry: async (name) => {
      removed.push(name);
    },
    // Present so that a return to handle.remove() would be caught rather than silently
    // working: a file handle here throws, exactly as Firefox does.
    getFileHandle: async () => ({}),
  };

  const result = await deleteVoiceFiles(['a.onnx', 'a.onnx.json'], {
    getDirectory: async () => ({ getDirectoryHandle: async () => directory }),
  });

  assert.deepEqual(removed, ['a.onnx', 'a.onnx.json']);
  assert.deepEqual(result.removed, ['a.onnx', 'a.onnx.json']);
});

test('a file that was already gone is not a failure', async () => {
  // The caller wanted it absent and it is absent. Treating this as an error would make a
  // second removal, or a half-finished one, look broken.
  const directory = {
    removeEntry: async () => {
      const error = new Error('no such file');
      error.name = 'NotFoundError';
      throw error;
    },
  };

  const result = await deleteVoiceFiles(['gone.onnx'], {
    getDirectory: async () => ({ getDirectoryHandle: async () => directory }),
  });

  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.missing, ['gone.onnx']);
});

test('a delete that genuinely fails is reported, never swallowed', async () => {
  // The whole reason this code exists instead of the library's. A failure that resolves
  // like a success is what put a deleted voice back on the settings page.
  const directory = {
    removeEntry: async () => {
      throw new TypeError('directory.removeEntry is not a function');
    },
  };

  await assert.rejects(
    deleteVoiceFiles(['stuck.onnx'], {
      getDirectory: async () => ({ getDirectoryHandle: async () => directory }),
    }),
    /removeEntry/
  );
});

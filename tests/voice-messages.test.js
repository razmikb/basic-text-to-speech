/**
 * Tests for the messages that carry a voice choice between pages.
 *
 * These exist because of two faults found while building this, both invisible to every
 * other kind of test and both fatal at runtime:
 *
 *   1. The settings page originally downloaded a voice over the reader's own connection.
 *      That connection means "I speak now", so downloading a voice SILENCED the article
 *      the listener was in the middle of — destroying the one thing choosing a voice
 *      mid-article exists to allow.
 *
 *   2. The background script relayed a message under the SAME name it listens for. It
 *      shares a message bus with the voice page and is itself a listener on that bus, so
 *      it heard its own broadcast and relayed it again, forever.
 *
 * Neither is visible by reading one file, which is why they are pinned by reading the
 * files against each other. These assertions are about wiring between pages, so they work
 * on the source rather than by importing it — a background script and a voice page cannot
 * both be loaded into one test process.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...parts) => fs.readFileSync(path.join(here, '..', 'src', ...parts), 'utf8');

const background = read('background.js');
const host = read('piper', 'host.js');
const settings = read('settings', 'settings.js');

/** Every `type: 'ftts:...'` a file SENDS. */
function sends(source) {
  return new Set([...source.matchAll(/type: '(ftts:[^']+)'/g)].map((match) => match[1]));
}

/** Every `ftts:...` a file compares a message type AGAINST, i.e. listens for. */
function listensFor(source) {
  return new Set(
    [...source.matchAll(/message\??\.type\s*[=!]==\s*'(ftts:[^']+)'/g)].map((match) => match[1])
  );
}

test('no page relays a message under the name it listens for', () => {
  // The loop that hung the add-on. The background script and the voice page share one
  // message bus and both listen on it, so a branch that re-broadcasts the name that woke
  // it delivers the message straight back to itself.
  for (const [name, source] of [
    ['background.js', background],
    ['host.js', host],
  ]) {
    for (const type of sends(source)) {
      assert.ok(
        !listensFor(source).has(type),
        `${name} both sends and listens for "${type}" — it will relay to itself forever`
      );
    }
  }
});

test('everything the settings page asks for is answered by something', () => {
  const answered = new Set([...listensFor(background), ...listensFor(host)]);

  for (const type of sends(settings)) {
    assert.ok(answered.has(type), `nothing listens for "${type}", which settings.js sends`);
  }
});

test('everything the background relays onward is heard by the voice page', () => {
  // The relayed names differ from the received ones on purpose (see the loop above), so
  // a rename on one side alone would leave the settings page waiting forever.
  for (const type of ['ftts:stored-voices', 'ftts:do-fetch-voice', 'ftts:do-remove-voice']) {
    assert.ok(background.includes(type), `background.js no longer relays "${type}"`);
    assert.ok(listensFor(host).has(type), `host.js no longer answers "${type}"`);
  }
});

test('the settings page never connects as a reader', () => {
  /*
   * THE FAULT THIS EXISTS FOR. `runtime.connect({ name: 'ftts:piper' })` is how a page
   * claims the voice, and the voice page stops whatever the previous claimant was playing.
   * The settings page must never make that claim: someone changing voice while listening
   * would have their article cut off by the download their choice required.
   *
   * Comments are stripped before looking, because this file EXPLAINS the connection it
   * must not open — and a rule that trips over its own explanation teaches the next
   * person to delete the explanation.
   */
  const code = settings.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');

  assert.ok(
    !/runtime\.connect/.test(code),
    'settings.js opens a connection — it must ask by message instead, or it will stop playback'
  );
  assert.ok(
    !code.includes('ftts:piper'),
    'settings.js claims the reader connection, which silences a playing article'
  );
});

test('the voice page answers the settings page outside the connection that takes over', () => {
  /*
   * `serve` is the function that stops whatever was playing, and it is reached only from
   * onConnect. So the requirement is that the settings page's download is answered by the
   * PAGE-WIDE message listener instead — the one registered at the top level, after serve
   * is defined — and never from inside serve itself.
   */
  const insideServe = host.slice(
    host.indexOf('function serve('),
    host.indexOf('async function storedVoices(')
  );

  assert.ok(
    !insideServe.includes('ftts:do-fetch-voice'),
    'the settings download is handled inside serve(), which stops a playing article'
  );

  const pageWide = host.slice(host.indexOf('async function storedVoices('));
  assert.ok(
    pageWide.includes('ftts:do-fetch-voice'),
    'nothing outside serve() answers the settings download'
  );
});

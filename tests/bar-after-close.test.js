import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The bug the owner hit: close the bar with its ✕, press the toolbar icon, nothing comes back.
 * Closing destroys the bar for good, but the reading session lives on, so the next press has
 * to build a fresh bar. This models the content script's stop/toggle logic directly, since the
 * content script itself cannot be imported outside a browser.
 */
function makeSession() {
  const made = { bars: 0, barClosed: false, shown: 0 };
  made.rebuildBar = () => {
    made.bars += 1;
    made.barClosed = false;
    made.shown += 1;
  };
  made.rebuildBar();
  return made;
}

const stop = (session) => {
  session.barClosed = true;
};
const press = (session) => {
  if (session.barClosed) session.rebuildBar();
};

test('pressing the icon after closing the bar builds a fresh bar', () => {
  const session = makeSession();
  stop(session);
  press(session);
  assert.equal(session.bars, 2);
  assert.equal(session.barClosed, false);
});

test('pressing the icon while the bar is open does not build a second one', () => {
  const session = makeSession();
  press(session);
  assert.equal(session.bars, 1);
});

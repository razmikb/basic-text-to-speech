import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createControls, formatSpeed, placeSpot, spotAt, stepSpeed } from '../src/lib/controls.js';
import { createReader, buildSentences } from '../src/lib/reader.js';
import { DEFAULTS } from '../src/lib/config.js';
import { createFakeEngine } from './helpers/fake-engine.js';

/**
 * Tests for the floating control bar.
 *
 * Two rules from PLAN.md are what these exist to defend, and they are the reasons the bar
 * is riskier than anything else we put on a page:
 *
 *   "the page is not ours" — everything we add is prefixed `ftts-` and comes off again
 *   leaving the page exactly as it was found. The strongest test here is the last group.
 *
 *   the bar must work under a finger — which is testable to a real degree, because most
 *   of what makes touch work is structural: how big the targets are, which event a press
 *   listens to, and whether anything is reachable only by hovering.
 */

const settle = () => new Promise((resolve) => setImmediate(resolve));

const PARAGRAPHS = [
  { text: 'One begins. One middles. One ends.' },
  { text: 'Two begins. Two ends.' },
  { text: 'Three begins. Three ends.' },
];

/** Timers the test drives, so nothing waits in real time. */
function createFakeTimers() {
  let next = 1;
  const scheduled = new Map();
  return {
    setTimeout(fn, ms) {
      const id = next++;
      scheduled.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      scheduled.delete(id);
    },
    /** Run everything that was due, as if that long had passed. */
    fire() {
      for (const [id, { fn }] of [...scheduled]) {
        scheduled.delete(id);
        fn();
      }
    },
    pending() {
      return scheduled.size;
    },
  };
}

function setup(config = {}, { blocks = PARAGRAPHS } = {}) {
  const { document: doc } = parseHTML(
    '<html><head></head><body><article><p>Site content.</p></article></body></html>'
  );
  const engine = createFakeEngine();
  const reader = createReader({ engine, sentences: buildSentences(blocks) });
  const timers = createFakeTimers();
  const speeds = [];
  const stops = [];

  const controls = createControls({
    doc,
    reader,
    config: { ...DEFAULTS, ...config },
    timers,
    onSpeedChange: (rate) => speeds.push(rate),
    onStop: () => stops.push(true),
  });

  return { doc, engine, reader, controls, timers, speeds, stops };
}

/** Find a button by the name it carries, the way a person would find it by its icon. */
const button = (doc, name) => doc.querySelector(`[data-ftts="${name}"]`);

/** Tap a button the way a finger does: pointerdown, then pointerup. */
function tap(doc, name) {
  const target = button(doc, name);
  assert.ok(target, `no such button: ${name}`);
  target.dispatchEvent(
    new doc.defaultView.Event('pointerdown', { bubbles: true, cancelable: true })
  );
  target.dispatchEvent(new doc.defaultView.Event('pointerup', { bubbles: true, cancelable: true }));
  return target;
}

// ---------------------------------------------------------------------------
// What it puts on the page
// ---------------------------------------------------------------------------

test('shows a bar with every control on it', () => {
  const { doc, controls } = setup();

  assert.equal(controls.show(), true);
  assert.equal(controls.isShowing(), true);

  for (const name of [
    'prev-paragraph',
    'prev-sentence',
    'play',
    'next-sentence',
    'next-paragraph',
    'speed',
    'close',
  ]) {
    assert.ok(button(doc, name), `missing the ${name} button`);
  }
});

test('everything added to the page is namespaced ftts-', () => {
  const { doc, controls } = setup();
  controls.show();

  const ours = [...doc.querySelectorAll('[class]')].filter(
    (el) => !el.closest('article') // the site's own content
  );

  for (const el of ours) {
    for (const name of el.className.split(/\s+/).filter(Boolean)) {
      assert.ok(name.startsWith('ftts-'), `class "${name}" is not namespaced`);
    }
  }
  assert.ok(ours.length > 0, 'the test would pass vacuously if we added nothing');
});

test('showing twice does not build a second bar', () => {
  const { doc, controls } = setup();

  controls.show();
  controls.show();

  assert.equal(doc.querySelectorAll('.ftts-controls').length, 1);
});

test('the bar is not shown when the setting is off', () => {
  const { doc, controls } = setup({ showControls: false });

  assert.equal(controls.show(), false);
  assert.equal(doc.querySelector('.ftts-controls'), null);
});

// ---------------------------------------------------------------------------
// Built for a finger
// ---------------------------------------------------------------------------

test('every button is at least 44px, the smallest reliably touchable target', () => {
  // The number both Apple and Google publish. A control you have to aim at is worse than
  // no control when you are holding a tablet one-handed, so this is a hard floor rather
  // than a preference — and the config validator refuses to store anything smaller.
  const { doc, controls } = setup();
  controls.show();

  const bar = doc.querySelector('.ftts-controls');
  const declared = bar.style.getPropertyValue('--ftts-button-size');
  assert.equal(declared, '48px', 'the size must survive the bar being positioned');
  assert.ok(parseInt(declared, 10) >= 44);

  // Placing the bar and sizing its buttons are separate properties. They were once
  // assembled into one string of style text, and positioning silently corrupted the size.
  assert.match(bar.style.getPropertyValue('bottom'), /^calc\(/);
});

test('a stored button size below the touchable floor is refused', async () => {
  const { resolveConfig } = await import('../src/lib/config.js');

  assert.equal(resolveConfig({ controlsButtonSize: 12 }).controlsButtonSize, 48);
  assert.equal(resolveConfig({ controlsButtonSize: 44 }).controlsButtonSize, 44);
  assert.equal(resolveConfig({ controlsButtonSize: 64 }).controlsButtonSize, 64);
  assert.equal(resolveConfig({ controlsButtonSize: 500 }).controlsButtonSize, 48);
});

test('a press acts on pointerdown, not on click', () => {
  // On a tablet the browser holds `click` back until it knows the tap is not the start of
  // a scroll or a double-tap zoom. Waiting for it is felt as lag on every button, so the
  // command runs on pointerdown — and this test is what stops that regressing to `click`.
  const { doc, reader, controls } = setup();
  controls.show();

  const target = button(doc, 'next-sentence');
  target.dispatchEvent(
    new doc.defaultView.Event('pointerdown', { bubbles: true, cancelable: true })
  );

  assert.equal(reader.getIndex(), 1, 'pointerdown alone must move the reader');
});

test('the click that follows a press does not run the command twice', () => {
  // A mouse fires pointerdown *and* click. Without swallowing the click, every button
  // would skip two sentences per press with a mouse and one with a finger.
  const { doc, reader, controls } = setup();
  controls.show();

  const target = button(doc, 'next-sentence');
  const view = doc.defaultView;
  target.dispatchEvent(new view.Event('pointerdown', { bubbles: true, cancelable: true }));
  target.dispatchEvent(new view.Event('click', { bubbles: true, cancelable: true }));

  assert.equal(reader.getIndex(), 1, 'one press, one sentence');
});

test('a press does not reach the page underneath', () => {
  // Sites bind their own handlers to the document and throw up overlays on a tap. A
  // control bar that also sets those off is worse than useless.
  const { doc, controls } = setup();
  controls.show();

  let pageSaw = 0;
  doc.body.addEventListener('pointerdown', () => (pageSaw += 1));

  tap(doc, 'play');

  assert.equal(pageSaw, 0, 'the site must not see our presses');
});

test('a press is cancelled, so the browser does not also scroll or zoom', () => {
  const { doc, controls } = setup();
  controls.show();

  const event = new doc.defaultView.Event('pointerdown', { bubbles: true, cancelable: true });
  button(doc, 'play').dispatchEvent(event);

  assert.equal(event.defaultPrevented, true);
});

test('no control is reachable only by hovering', () => {
  // A finger cannot hover, so anything that only appears or only works on hover does not
  // exist on a tablet. Every button carries its own label instead.
  const { doc, controls } = setup();
  controls.show();

  for (const el of doc.querySelectorAll('.ftts-controls button')) {
    assert.ok(el.getAttribute('aria-label'), 'every button needs a label of its own');
    // A tooltip is a bonus for a mouse, never the only way to know what a button does:
    // the icon carries the meaning, and aria-label carries it for a screen reader.
    assert.ok(el.getAttribute('title'), 'a mouse should still get a tooltip');
  }
});

test('the pressed state appears on pointerdown and clears on pointerup', () => {
  // Immediate feedback matters more with a finger than with a mouse: the finger covers
  // the button it is pressing, so the only proof a tap registered is the button changing.
  const { doc, controls } = setup();
  controls.show();

  const target = button(doc, 'play');
  const view = doc.defaultView;

  target.dispatchEvent(new view.Event('pointerdown', { bubbles: true, cancelable: true }));
  assert.equal(target.getAttribute('data-pressed'), 'true');

  target.dispatchEvent(new view.Event('pointerup', { bubbles: true, cancelable: true }));
  assert.equal(target.getAttribute('data-pressed'), null);
});

test('a press that becomes a scroll clears the pressed state', () => {
  // pointercancel is what the browser sends when it decides the touch was a scroll.
  // Without handling it the button would stay looking pressed for the rest of the article.
  const { doc, controls } = setup();
  controls.show();

  const target = button(doc, 'play');
  const view = doc.defaultView;
  target.dispatchEvent(new view.Event('pointerdown', { bubbles: true, cancelable: true }));
  target.dispatchEvent(new view.Event('pointercancel', { bubbles: true, cancelable: true }));

  assert.equal(target.getAttribute('data-pressed'), null);
});

test('the keyboard works too, for anyone not using a finger', () => {
  // pointerdown never fires for space or enter, so without its own handler the bar would
  // be completely unreachable from a keyboard.
  const { doc, reader, controls } = setup();
  controls.show();

  // linkedom has no KeyboardEvent, so the key is attached to a plain event. The handler
  // only ever reads `event.key`, which is what makes that substitution honest.
  const target = button(doc, 'next-sentence');
  const event = new doc.defaultView.Event('keydown', { bubbles: true, cancelable: true });
  event.key = 'Enter';
  target.dispatchEvent(event);

  assert.equal(reader.getIndex(), 1);
});

test('the bar keeps clear of a tablet’s own on-screen furniture', () => {
  // Without safe-area insets the bar on a tablet in landscape can sit under the system
  // swipe bar, where taps go to the operating system. The button looks fine and simply
  // does not work, which is the hardest kind of fault to diagnose from a bug report.
  const { doc, controls } = setup();
  controls.show();

  const style = doc.querySelector('.ftts-controls').getAttribute('style');
  assert.match(style, /env\(safe-area-inset-bottom/);
});

test('the bar announces itself as one group of controls', () => {
  const { doc, controls } = setup();
  controls.show();

  const bar = doc.querySelector('.ftts-controls');
  assert.equal(bar.getAttribute('role'), 'toolbar');
  assert.ok(bar.getAttribute('aria-label'));
});

test('icons never take a tap that was meant for the button', () => {
  const { doc, controls } = setup();
  controls.show();

  const css = doc.querySelector('#ftts-controls-style').textContent;
  assert.match(css, /svg[\s\S]*?pointer-events: none/, 'an icon must not swallow taps');
});

test('no button is made deaf by a rule meant for something inside it', () => {
  /*
   * THE BUG THIS EXISTS FOR. The speed label was given the class `ftts-speed` so a tap on
   * the text would fall through to the button — correct in intent. But every button also
   * carries its own name as a class, and the speed button's name IS `ftts-speed`. The
   * selector matched the button as well as the label, so `pointer-events: none` made the
   * speed button ignore every press. It looked exactly like a button wired to nothing,
   * and two sessions were spent downstream of a press that never happened.
   *
   * Checked structurally rather than by naming the one class, because the trap is general:
   * any future label whose class collides with its button's name would be silenced the
   * same way, and a test naming `ftts-speed-label` would not notice.
   */
  const { doc, controls } = setup();
  controls.show();

  const css = doc.querySelector('#ftts-controls-style').textContent;

  // Every class that a `pointer-events: none` rule applies to.
  const deafened = new Set();
  for (const rule of css.split('}')) {
    if (!/pointer-events:\s*none/.test(rule)) continue;
    for (const [, name] of rule.matchAll(/\.([\w-]+)/g)) deafened.add(name);
  }

  for (const button of doc.querySelectorAll('.ftts-controls button')) {
    for (const name of button.classList) {
      assert.ok(
        !deafened.has(name),
        `the ${button.getAttribute('data-ftts')} button carries .${name}, which is ` +
          'silenced by a pointer-events: none rule — it cannot be pressed'
      );
    }
  }
});

test('every button on the bar actually runs its command when pressed', () => {
  // The companion to the test above, from the other end: the bar is only as good as the
  // presses that reach it, and a button that is silently inert is indistinguishable from
  // one wired to nothing. The speed controls are the ones that were broken, so they are
  // asserted by name — plus and minus by the speed they report, and the number by the
  // list it opens.
  const { doc, controls, speeds } = setup({ rate: 1.0 });
  controls.show();

  tap(doc, 'speed-up');
  assert.deepEqual(speeds, [1.05], 'plus must step the speed');

  tap(doc, 'speed-down');
  assert.deepEqual(speeds, [1.05, 1.0], 'and minus must step it back');

  tap(doc, 'speed');
  assert.ok(doc.querySelector('[data-ftts="speed-menu"]'), 'the number must open the list');
});

test('a double tap on a button does not zoom the article', () => {
  const { doc, controls } = setup();
  controls.show();

  const css = doc.querySelector('#ftts-controls-style').textContent;
  assert.match(css, /touch-action: manipulation/);
});

// ---------------------------------------------------------------------------
// What the buttons do
// ---------------------------------------------------------------------------

test('play starts the article and the button becomes pause', async () => {
  const { doc, engine, reader, controls } = setup();
  controls.show();

  tap(doc, 'play');
  await settle();

  assert.equal(reader.getState(), 'playing');
  assert.equal(engine.spoken.at(-1).text, 'One begins.');
  assert.equal(button(doc, 'play').getAttribute('aria-label'), 'Pause');
});

test('pressing play again pauses, and the button becomes play', async () => {
  const { doc, reader, controls } = setup();
  controls.show();

  tap(doc, 'play');
  await settle();
  tap(doc, 'play');
  await settle();

  assert.equal(reader.getState(), 'paused');
  assert.equal(button(doc, 'play').getAttribute('aria-label'), 'Play');
});

test('the button follows the reader even when something else pauses it', async () => {
  // The toolbar button and another tab claiming the voice both pause us without going
  // near the bar. A bar showing "pause" on a paused article is how a person concludes
  // the add-on is broken.
  const { doc, reader, controls } = setup();
  controls.show();

  reader.play();
  await settle();
  assert.equal(button(doc, 'play').getAttribute('aria-label'), 'Pause');

  reader.pause();
  await settle();
  assert.equal(button(doc, 'play').getAttribute('aria-label'), 'Play');
});

test('the sentence buttons move one sentence at a time', async () => {
  const { doc, reader, controls } = setup();
  controls.show();

  tap(doc, 'play');
  await settle();

  tap(doc, 'next-sentence');
  await settle();
  assert.equal(reader.getIndex(), 1);

  tap(doc, 'prev-sentence');
  await settle();
  assert.equal(reader.getIndex(), 0);
});

test('the paragraph buttons move a whole paragraph at a time', async () => {
  const { doc, engine, reader, controls } = setup();
  controls.show();

  tap(doc, 'play');
  await settle();

  tap(doc, 'next-paragraph');
  await settle();
  assert.equal(reader.getIndex(), 3, 'the first sentence of paragraph two');
  assert.equal(engine.spoken.at(-1).text, 'Two begins.');

  tap(doc, 'next-paragraph');
  await settle();
  assert.equal(reader.getIndex(), 5, 'the first sentence of paragraph three');

  tap(doc, 'prev-paragraph');
  await settle();
  assert.equal(reader.getIndex(), 3, 'back to the start of paragraph two');
});

test('the paragraph and sentence buttons are not the same button twice', async () => {
  // The one confusion worth a test of its own: if paragraph skip quietly fell back to
  // sentence skip, every test above about paragraphs would still read plausibly.
  const { doc, reader, controls } = setup();
  controls.show();

  tap(doc, 'play');
  await settle();

  tap(doc, 'next-sentence');
  await settle();
  const afterSentence = reader.getIndex();

  tap(doc, 'next-paragraph');
  await settle();
  const afterParagraph = reader.getIndex();

  assert.equal(afterSentence, 1);
  assert.equal(afterParagraph, 3);
  assert.notEqual(afterParagraph - afterSentence, 1, 'a paragraph is more than one sentence');
});

test('the buttons work before anything has been played', async () => {
  // Someone finding their place before pressing play is normal, and the bar is how they
  // would do it. Nothing should need playback to have started first.
  const { doc, reader, controls } = setup();
  controls.show();

  tap(doc, 'next-paragraph');
  await settle();

  assert.equal(reader.getIndex(), 3);
  assert.equal(reader.getState(), 'idle');
});

test('plus and minus move the speed one fine step at a time', () => {
  // 0.05 rather than a jump between presets: the owner asked for it because the
  // difference between 1.35x and 1.4x is genuinely audible over a long article.
  const { doc, controls, speeds } = setup({ rate: 1.0 });
  controls.show();

  assert.equal(button(doc, 'speed').textContent, '1x');

  tap(doc, 'speed-up');
  assert.equal(button(doc, 'speed').textContent, '1.05x');

  tap(doc, 'speed-up');
  assert.equal(button(doc, 'speed').textContent, '1.1x');

  tap(doc, 'speed-down');
  assert.equal(button(doc, 'speed').textContent, '1.05x');

  assert.deepEqual(speeds, [1.05, 1.1, 1.05]);
});

test('repeated steps do not drift off the grid', () => {
  /*
   * NOT A THEORETICAL WORRY. Adding 0.05 repeatedly in binary floating point gives
   * 1.0000000000000002, and that number would reach the label, the stored setting, and
   * the comparison that decides whether a speed change is worth rebuilding eight banked
   * sentences for. A label reading "1.0000000000000002x" is the visible half; the wasted
   * rebuild is the expensive one.
   */
  const { doc, controls, speeds } = setup({ rate: 1.0 });
  controls.show();

  for (let i = 0; i < 6; i += 1) tap(doc, 'speed-up');
  for (let i = 0; i < 6; i += 1) tap(doc, 'speed-down');

  assert.equal(button(doc, 'speed').textContent, '1x', 'back exactly where it started');
  assert.deepEqual(speeds.at(-1), 1, 'and the value reported is exactly 1, not nearly 1');
  for (const speed of speeds) {
    assert.equal(speed, Math.round(speed * 100) / 100, `${speed} is off the 0.05 grid`);
  }
});

test('the speed stops at both ends instead of wrapping round', () => {
  /*
   * REVERSED DELIBERATELY. Wrapping made sense when one button cycled six speeds and a
   * dead end would have stranded the listener with no way back. With a plus and a minus
   * there is always a way back, and a plus that jumped from 3x to 0.5x mid-article would
   * be a nasty surprise rather than a convenience.
   */
  const fast = setup({ rate: 3.0 });
  fast.controls.show();
  tap(fast.doc, 'speed-up');
  assert.equal(button(fast.doc, 'speed').textContent, '3x', 'the maximum holds');
  assert.deepEqual(fast.speeds, [], 'and a press that changes nothing is not announced');

  const slow = setup({ rate: 0.5 });
  slow.controls.show();
  tap(slow.doc, 'speed-down');
  assert.equal(button(slow.doc, 'speed').textContent, '0.5x', 'the minimum holds');
  assert.deepEqual(slow.speeds, []);
});

test('a button at the end of its range says so rather than looking live', () => {
  // The lesson from the speed button that could not be pressed: a control that looks
  // usable and silently does nothing is worse than one that admits it is spent.
  const { doc, controls } = setup({ rate: 3.0 });
  controls.show();

  assert.equal(button(doc, 'speed-up').disabled, true);
  assert.equal(button(doc, 'speed-up').getAttribute('aria-disabled'), 'true');
  assert.equal(button(doc, 'speed-down').disabled, false, 'the other way is still open');
});

test('tapping the speed number opens the presets, and choosing one applies it', () => {
  // The list is what stops fine control becoming a chore: nobody wants to tap plus ten
  // times to get from 1x to 1.5x.
  const { doc, controls, speeds } = setup({ rate: 1.0, speedSteps: [0.75, 1.0, 1.5] });
  controls.show();

  assert.equal(doc.querySelector('[data-ftts="speed-menu"]'), null, 'shut to begin with');

  tap(doc, 'speed');
  const menu = doc.querySelector('[data-ftts="speed-menu"]');
  assert.ok(menu, 'the list opens');
  assert.deepEqual(
    [...menu.querySelectorAll('.ftts-menu-item')].map((item) => item.textContent),
    ['0.75x', '1x', '1.5x']
  );

  tap(doc, 'speed-preset-1.5');

  assert.deepEqual(speeds, [1.5]);
  assert.equal(button(doc, 'speed').textContent, '1.5x');
  assert.equal(doc.querySelector('[data-ftts="speed-menu"]'), null, 'and shuts behind it');
});

test('the preset list marks the speed currently in force', () => {
  const { doc, controls } = setup({ rate: 1.5, speedSteps: [1.0, 1.5, 2.0] });
  controls.show();

  tap(doc, 'speed');

  const checked = [...doc.querySelectorAll('.ftts-menu-item')]
    .filter((item) => item.getAttribute('aria-checked') === 'true')
    .map((item) => item.textContent);
  assert.deepEqual(checked, ['1.5x'], 'exactly one, and the right one');
});

test('the preset list shuts on a press elsewhere, and on Escape', () => {
  const { doc, controls } = setup();
  controls.show();

  tap(doc, 'speed');
  assert.ok(doc.querySelector('[data-ftts="speed-menu"]'));

  doc.dispatchEvent(new doc.defaultView.Event('pointerdown', { bubbles: true }));
  assert.equal(doc.querySelector('[data-ftts="speed-menu"]'), null, 'a tap away shuts it');

  tap(doc, 'speed');
  assert.ok(doc.querySelector('[data-ftts="speed-menu"]'));

  const escape = new doc.defaultView.Event('keydown', { bubbles: true });
  escape.key = 'Escape';
  doc.dispatchEvent(escape);
  assert.equal(doc.querySelector('[data-ftts="speed-menu"]'), null, 'and so does Escape');
});

test('the speed says what it is on, out loud', () => {
  const { doc, controls } = setup({ rate: 1.0 });
  controls.show();

  tap(doc, 'speed-up');
  assert.match(button(doc, 'speed').getAttribute('aria-label'), /1\.05x/);
});

test('taking the bar down takes an open preset list with it', () => {
  // The list is appended to the bar and listens on the document. Leaving either behind
  // would break the promise that everything we add is fully removable.
  const { doc, controls } = setup();
  controls.show();
  tap(doc, 'speed');
  assert.ok(doc.querySelector('[data-ftts="speed-menu"]'));

  controls.destroy();

  assert.equal(doc.querySelector('[data-ftts="speed-menu"]'), null);
});

test('the close button reports the press rather than stopping by itself', () => {
  // Stopping means tearing down the highlight and releasing the voice too, and only
  // content.js knows about those. A bar that stopped playback itself would leave the
  // highlight on the page.
  const { doc, controls, stops } = setup();
  controls.show();

  tap(doc, 'close');

  assert.deepEqual(stops, [true]);
  assert.equal(controls.isShowing(), true, 'the owner decides when the bar goes');
});

test('the play button redraws on the press itself, not when the voice gets round to it', () => {
  /*
   * The neural voice lives in a page of its own, so pausing it is a message to another
   * document. This models the honest worst case: an engine whose pause has not taken effect
   * by the time the press returns.
   *
   * The bar must not wait for it. It asks the reader what state it is in and repaints from
   * that, which is known immediately — the reader announces the pause before it asks the
   * engine to do anything. A button that waited for the sound to actually stop would lag
   * behind the finger that pressed it, which is exactly what this guards.
   *
   * The ordinary fake engine cannot catch this, because it pauses instantly and so the
   * announcement always arrives in time. That is the trap: the lag is invisible in tests
   * and obvious in the browser.
   */
  const { document: doc } = parseHTML(
    '<html><head></head><body><article><p>Site content.</p></article></body></html>'
  );

  const engine = createFakeEngine();
  let sluggishPauses = 0;
  const slowEngine = {
    ...engine,
    isSpeaking: () => engine.isSpeaking(),
    isPaused: () => engine.isPaused(),
    // Takes effect later, the way a message to another document does.
    pause() {
      sluggishPauses += 1;
    },
  };

  const reader = createReader({ engine: slowEngine, sentences: buildSentences(PARAGRAPHS) });
  const controls = createControls({
    doc,
    reader,
    config: { ...DEFAULTS },
    timers: createFakeTimers(),
  });
  controls.show();

  tap(doc, 'play');
  assert.equal(button(doc, 'play').getAttribute('aria-label'), 'Pause');

  tap(doc, 'play');

  assert.equal(sluggishPauses, 1, 'the voice was asked to stop');
  assert.equal(
    button(doc, 'play').getAttribute('aria-label'),
    'Play',
    'the icon must already show paused, without waiting for the sound to stop'
  );
});

// ---------------------------------------------------------------------------
// Getting out of the way
// ---------------------------------------------------------------------------

test('the bar fades after a while of not being touched, while playing', async () => {
  const { doc, reader, controls, timers } = setup({ controlsIdleMs: 5000 });
  controls.show();

  reader.play();
  await settle();

  assert.equal(controls.isIdle(), false);
  timers.fire();
  assert.equal(controls.isIdle(), true);
  assert.equal(doc.querySelector('.ftts-controls').getAttribute('data-idle'), 'true');
});

test('a paused bar never fades', async () => {
  // A paused bar that faded itself out would look like the add-on had died — and pausing
  // is exactly the moment someone is looking at the bar.
  const { controls, timers } = setup({ controlsIdleMs: 5000 });
  controls.show();

  timers.fire();

  assert.equal(controls.isIdle(), false);
});

test('only hovering the bar brings it back, not moving the mouse elsewhere', async () => {
  // Otherwise the fade undoes itself at every twitch of the mouse.
  const { doc, reader, controls, timers } = setup({ controlsIdleMs: 5000 });
  controls.show();

  reader.play();
  await settle();
  timers.fire();
  assert.equal(controls.isIdle(), true);

  doc.dispatchEvent(new doc.defaultView.Event('pointermove', { bubbles: true }));
  assert.equal(controls.isIdle(), true, 'moving over the page leaves the bar faded');

  const bar = doc.querySelector('.ftts-controls');
  bar.dispatchEvent(new doc.defaultView.Event('pointermove', { bubbles: true }));
  assert.equal(controls.isIdle(), false, 'hovering the bar makes it solid');
});

test('a touch anywhere on the page still wakes the bar', async () => {
  const { doc, reader, controls, timers } = setup({ controlsIdleMs: 5000 });
  controls.show();

  reader.play();
  await settle();
  timers.fire();
  assert.equal(controls.isIdle(), true);

  doc.dispatchEvent(new doc.defaultView.Event('touchstart', { bubbles: true }));
  assert.equal(controls.isIdle(), false);
});

test('a faded bar still takes a tap', async () => {
  // Fading is a visual retreat, not a disabled state: reaching for a faded bar and
  // pressing pause must work on the first tap, not the one after it comes back.
  const { doc, reader, controls, timers } = setup({ controlsIdleMs: 5000 });
  controls.show();

  reader.play();
  await settle();
  timers.fire();
  assert.equal(controls.isIdle(), true);

  tap(doc, 'play');
  await settle();

  assert.equal(reader.getState(), 'paused');
});

test('pausing brings the bar back to full strength', async () => {
  const { reader, controls, timers } = setup({ controlsIdleMs: 5000 });
  controls.show();

  reader.play();
  await settle();
  timers.fire();
  assert.equal(controls.isIdle(), true);

  reader.pause();
  await settle();

  assert.equal(controls.isIdle(), false);
});

test('an idle time of zero keeps the bar visible always', async () => {
  const { reader, controls, timers } = setup({ controlsIdleMs: 0 });
  controls.show();

  reader.play();
  await settle();

  assert.equal(timers.pending(), 0, 'nothing should be scheduled at all');
  assert.equal(controls.isIdle(), false);
});

// ---------------------------------------------------------------------------
// Leaving no trace
// ---------------------------------------------------------------------------

test('the page is left exactly as it was found', () => {
  // The rule that governs everything we put on a page. Compared as a whole document
  // rather than by checking our own elements are gone, because the interesting failure is
  // something of *ours* we forgot about, which a targeted check would not look for.
  const { doc, controls } = setup();
  const before = doc.documentElement.outerHTML;

  controls.show();
  assert.notEqual(doc.documentElement.outerHTML, before, 'the test would be vacuous');

  controls.destroy();

  assert.equal(doc.documentElement.outerHTML, before);
});

test('destroying twice is safe', () => {
  const { controls } = setup();
  controls.show();

  controls.destroy();
  controls.destroy();

  assert.equal(controls.isShowing(), false);
});

test('destroying without ever showing is safe', () => {
  const { controls } = setup();
  controls.destroy();
  assert.equal(controls.isShowing(), false);
});

test('a destroyed bar cannot be brought back', () => {
  const { doc, controls } = setup();
  controls.destroy();

  assert.equal(controls.show(), false);
  assert.equal(doc.querySelector('.ftts-controls'), null);
});

test('destroying stops listening to the page and to the reader', async () => {
  // A bar that is gone from the page but still subscribed is a leak that shows up as the
  // add-on reacting to a page it is no longer on.
  const { doc, reader, controls, timers } = setup({ controlsIdleMs: 5000 });
  controls.show();
  controls.destroy();

  // None of this should reach anything: no throw, no scheduled work left behind.
  doc.dispatchEvent(new doc.defaultView.Event('pointermove', { bubbles: true }));
  reader.play();
  await settle();

  assert.equal(timers.pending(), 0, 'no timer left running after destroy');
});

test('destroying while the fade is pending leaves no timer behind', async () => {
  const { reader, controls, timers } = setup({ controlsIdleMs: 5000 });
  controls.show();
  reader.play();
  await settle();
  assert.equal(timers.pending(), 1);

  controls.destroy();

  assert.equal(timers.pending(), 0);
});

test('the stylesheet goes when the bar goes', () => {
  const { doc, controls } = setup();
  controls.show();
  assert.ok(doc.querySelector('#ftts-controls-style'));

  controls.destroy();

  assert.equal(doc.querySelector('#ftts-controls-style'), null);
});

// ---------------------------------------------------------------------------
// The small pure pieces
// ---------------------------------------------------------------------------

test('speeds are labelled the short way', () => {
  assert.equal(formatSpeed(1), '1x');
  assert.equal(formatSpeed(1.5), '1.5x');
  assert.equal(formatSpeed(0.75), '0.75x');
  assert.equal(formatSpeed(2), '2x');
});

test('stepping the speed snaps to the grid and stops at the ends', () => {
  // The pure arithmetic behind plus and minus, checked directly: the drift and the
  // clamping are both easier to get wrong than they look, and both are heard rather than
  // seen when they go wrong.
  const bounds = { step: 0.05, min: 0.5, max: 3 };

  assert.equal(stepSpeed(1, +1, bounds), 1.05);
  assert.equal(stepSpeed(1, -1, bounds), 0.95);

  // An off-grid speed — from a preset, or from settings written before the step changed —
  // lands ON the grid rather than carrying its offset forward forever. It moves by a step
  // first and then snaps, so 1.73 goes up to 1.8 and down to 1.7: the nearest grid line
  // in the direction asked for, never a move backwards.
  assert.equal(stepSpeed(1.73, +1, bounds), 1.8);
  assert.equal(stepSpeed(1.73, -1, bounds), 1.7);

  assert.equal(stepSpeed(3, +1, bounds), 3, 'the top holds');
  assert.equal(stepSpeed(0.5, -1, bounds), 0.5, 'and so does the bottom');

  // A current speed that is not a number steps from 1x, which is the only sane place to
  // start; a step size that is not a number leaves the speed exactly where it was.
  assert.equal(stepSpeed('fast', +1, bounds), 1.05);
  assert.equal(stepSpeed(1.4, +1, { ...bounds, step: 0 }), 1.4);
});

test('a stored speed list that is nonsense is ignored', async () => {
  const { resolveConfig } = await import('../src/lib/config.js');

  assert.deepEqual(resolveConfig({ speedSteps: [] }).speedSteps, DEFAULTS.speedSteps);
  assert.deepEqual(resolveConfig({ speedSteps: [0.1, 99] }).speedSteps, DEFAULTS.speedSteps);
  assert.deepEqual(resolveConfig({ speedSteps: 'fast' }).speedSteps, DEFAULTS.speedSteps);
  assert.deepEqual(resolveConfig({ speedSteps: [1, 2] }).speedSteps, [1, 2]);
});

test('an unrecognised position falls back rather than reaching the page as CSS', () => {
  // Position comes from a fixed table of known values, so a hand-edited setting cannot
  // put arbitrary CSS on a page we do not own.
  const { doc, controls } = setup({ controlsPosition: 'nowhere; background: url(x)' });
  controls.show();

  const style = doc.querySelector('.ftts-controls').getAttribute('style');
  assert.doesNotMatch(style, /url\(/);
  assert.match(style, /bottom:/, 'fell back to the default corner');
});

// ---------------------------------------------------------------------------
// The status panel
// ---------------------------------------------------------------------------

/** A bar with a clock the test drives, so elapsed times are exact rather than racy. */
function setupWithClock(config = {}) {
  let clock = 1_000_000;
  const { document: doc } = parseHTML(
    '<html><head></head><body><article><p>Site content.</p></article></body></html>'
  );
  const reader = createReader({
    engine: createFakeEngine(),
    sentences: buildSentences(PARAGRAPHS),
  });
  const timers = createFakeTimers();
  const controls = createControls({
    doc,
    reader,
    config: { ...DEFAULTS, ...config },
    timers,
    now: () => clock,
  });
  return { doc, reader, controls, timers, advance: (ms) => (clock += ms) };
}

const statusPanel = (doc) => doc.querySelector('[data-ftts="status"]');
const statusText = (doc) => doc.querySelector('.ftts-phase-label')?.textContent ?? '';
const statusQuote = (doc) => doc.querySelector('.ftts-text')?.textContent ?? '';

test('the status panel stays hidden until there is something to say', () => {
  const { doc, controls } = setupWithClock();
  controls.show();

  assert.ok(statusPanel(doc), 'the panel exists');
  assert.equal(statusPanel(doc).hidden, true, 'but says nothing yet');
});

test('it says when the voice is building audio, and for which sentence', () => {
  const { doc, controls } = setupWithClock();
  controls.show();

  controls.showActivity({ phase: 'generating', text: 'One begins.', banked: 0 });

  assert.equal(statusPanel(doc).hidden, false);
  assert.match(statusText(doc), /building audio/);
  assert.match(statusQuote(doc), /One begins\./);
});

test('it counts the time a build is taking, against an estimate', () => {
  const { doc, controls, advance } = setupWithClock();
  controls.show();

  controls.showActivity({ phase: 'generating', text: 'One begins.', estimateMs: 2000 });
  advance(1500);
  controls.showActivity({ phase: 'generating', text: 'One begins.', estimateMs: 2000 });

  // The elapsed count must be measured from when the work started, not from the last
  // report — otherwise it would reset to zero on every repaint and never appear to move.
  assert.match(statusText(doc), /1\.5s/);
  assert.match(statusText(doc), /~2\.0s/);
});

test('a first sentence with no estimate says so rather than guessing', () => {
  // Before anything has been built there is nothing to base an estimate on, and inventing
  // one would be worse than admitting it: the first sentence is the slowest of the article.
  const { doc, controls } = setupWithClock();
  controls.show();

  controls.showActivity({ phase: 'generating', text: 'One begins.' });

  assert.match(statusText(doc), /no estimate yet/);
});

test('it reports how long a finished sentence actually took', () => {
  const { doc, controls } = setupWithClock();
  controls.show();

  controls.showActivity({ phase: 'generated', text: 'One begins.', tookMs: 2300, banked: 1 });

  assert.match(statusText(doc), /built in 2\.3s/);
});

test('it shows how many sentences are banked ahead', () => {
  // The cushion is the whole reason playback is smooth, and it is otherwise invisible.
  const { doc, controls } = setupWithClock();
  controls.show();

  controls.showActivity({ phase: 'speaking', text: 'One begins.', banked: 3 });

  assert.match(statusText(doc), /3 ready/);
});

test('it shows where we are in the article', () => {
  const { doc, controls } = setupWithClock();
  controls.show();

  controls.showPosition({ index: 4, total: 7, text: 'Two ends.' });

  assert.match(statusText(doc), /5\/7/, 'counted from one, the way a person counts');
});

test('position alone is enough to show the panel, for a voice that reports nothing', () => {
  // The plain browser voice reports no activity whatever. Without this the panel would sit
  // empty for the entire article whenever the neural voice is not the one in use.
  const { doc, controls } = setupWithClock();
  controls.show();

  controls.showPosition({ index: 0, total: 7, text: 'One begins.' });

  assert.equal(statusPanel(doc).hidden, false);
  assert.match(statusQuote(doc), /One begins\./);
});

test('news about the voice does not wipe out the position, or the other way round', () => {
  const { doc, controls } = setupWithClock();
  controls.show();

  controls.showPosition({ index: 2, total: 7, text: 'One ends.' });
  controls.showActivity({ phase: 'speaking', text: 'One ends.', banked: 2 });

  assert.match(statusText(doc), /speaking/);
  assert.match(statusText(doc), /3\/7/, 'the position must survive');
});

test('the panel colours itself by what is happening', () => {
  const { doc, controls } = setupWithClock();
  controls.show();
  const bar = doc.querySelector('.ftts-controls');

  controls.showActivity({ phase: 'generating', text: 'x' });
  assert.equal(bar.getAttribute('data-phase'), 'generating');

  controls.showActivity({ phase: 'speaking', text: 'x' });
  assert.equal(bar.getAttribute('data-phase'), 'speaking');
});

test('a voice failure is shown as a failure, not as silence', () => {
  const { doc, controls } = setupWithClock();
  controls.show();

  controls.showActivity({ phase: 'generated', text: 'x', error: 'model exploded' });

  assert.match(statusText(doc), /voice failed/);
  assert.equal(doc.querySelector('.ftts-controls').getAttribute('data-phase'), 'error');
});

test('the progress bar never claims to be finished while still building', () => {
  // Showing a full bar on something unfinished is a lie the listener can hear: the bar
  // would sit at 100% through a silence.
  const { doc, controls, advance } = setupWithClock();
  controls.show();

  controls.showActivity({ phase: 'generating', text: 'x', estimateMs: 1000 });
  advance(10_000); // Far past the estimate.
  controls.showActivity({ phase: 'generating', text: 'x', estimateMs: 1000 });

  const width = parseInt(doc.querySelector('.ftts-fill').style.width, 10);
  assert.ok(width > 0 && width < 100, `expected a partial bar, got ${width}%`);
});

test('the status panel can be turned off', () => {
  const { doc, controls } = setupWithClock({ showStatus: false });
  controls.show();

  assert.equal(statusPanel(doc), null);
  // And reporting into a bar with no panel must not throw.
  controls.showActivity({ phase: 'generating', text: 'x' });
  controls.showPosition({ index: 0, total: 1, text: 'x' });
});

test('the status panel does not move the buttons about as it updates', () => {
  // A status line that pushed the pause button around while it changed would be worse than
  // no status line: the buttons must stay where a finger last found them. So the panel
  // lives in its own row, above them.
  const { doc, controls } = setupWithClock();
  controls.show();

  const row = doc.querySelector('.ftts-row');
  assert.ok(row, 'the buttons need a row of their own');
  assert.equal(button(doc, 'play').parentNode, row);
  assert.notEqual(statusPanel(doc).parentNode, row, 'the status must not sit among the buttons');
});

test('the panel is announced politely, so it does not talk over the article', () => {
  const { doc, controls } = setupWithClock();
  controls.show();

  assert.equal(statusPanel(doc).getAttribute('aria-live'), 'polite');
});

test('the ticking repaint stops when the bar is destroyed', () => {
  const { controls, timers } = setupWithClock();
  controls.show();
  controls.showActivity({ phase: 'generating', text: 'x', estimateMs: 1000 });
  assert.ok(timers.pending() > 0, 'a build should be repainting');

  controls.destroy();

  assert.equal(timers.pending(), 0, 'nothing may keep ticking after destroy');
});

test('the panel goes with the bar, leaving the page as it was', () => {
  const { doc, controls } = setupWithClock();
  const before = doc.documentElement.outerHTML;

  controls.show();
  controls.showActivity({ phase: 'generating', text: 'One begins.', estimateMs: 900 });
  controls.showPosition({ index: 0, total: 7, text: 'One begins.' });
  controls.destroy();

  assert.equal(doc.documentElement.outerHTML, before);
});

test('the bar is a fixed size, whatever the status happens to say', () => {
  /*
   * WHY THIS IS NOT MERELY COSMETIC. The panel used to grow and shrink with its contents —
   * a one-line sentence then a two-line one, a panel that left the layout entirely when
   * idle — so the bar moved and resized while an article played. The owner reported it as
   * restless to look at, and as something that actively got in the way of judging the
   * voice, because the thing being tested kept jumping.
   *
   * Four separate things made it move, and all four are asserted here rather than the one
   * that was noticed first. The rule is the same in every case: the box is fixed and the
   * text is made to fit it, never the reverse.
   */
  const { doc, controls } = setup();
  controls.show();

  const css = doc.querySelector('#ftts-controls-style').textContent;
  const block = (selector) => {
    const at = css.indexOf(selector);
    assert.notEqual(at, -1, `no rule for ${selector}`);
    return css.slice(at, css.indexOf('}', at) + 1);
  };

  // 1. A fixed width, not a maximum one: a short status must not narrow the bar.
  assert.match(block('.ftts-status {'), /width: min\(/);
  assert.doesNotMatch(block('.ftts-status {'), /max-width/);

  // 2. Hidden without leaving the layout, so going quiet does not collapse the bar.
  assert.match(block('.ftts-status[hidden]'), /visibility: hidden/);
  assert.doesNotMatch(block('.ftts-status[hidden]'), /display: none/);

  // 3. The preview is always two lines tall, not at most two.
  assert.match(block('.ftts-text {'), /height: [\d.]+em/);
  assert.match(block('.ftts-text {'), /-webkit-line-clamp: 2/);

  // 4. The phase line is truncated rather than wrapped onto a second line.
  assert.match(block('.ftts-phase-label'), /text-overflow: ellipsis/);
  assert.match(block('.ftts-phase-label'), /white-space: nowrap/);
});

test('a long sentence and a short one give the preview the same height', () => {
  // The end the owner actually sees: whatever the voice is reading, the box is the same
  // size. Asserted through the real render path rather than the stylesheet, so a change
  // that bypasses the CSS is still caught.
  const { doc, controls } = setup();
  controls.show();

  controls.showActivity({ phase: 'speaking', text: 'Short.' });
  const short = statusQuote(doc);

  controls.showActivity({
    phase: 'speaking',
    text: 'A very much longer sentence indeed, one that would certainly have wrapped onto a second line and then a third if it had ever been allowed to.',
  });
  const long = statusQuote(doc);

  assert.notEqual(short, long, 'the preview does show what is being read');
  // Neither is truncated in the DOM: the clamp and the fixed height are the browser's job,
  // and doing it in JavaScript instead would cost the screen reader the full sentence.
  assert.match(long, /allowed to/, 'the full sentence stays available to a screen reader');
});

// ---------------------------------------------------------------------------
// Loading state, fold, paused colour
// ---------------------------------------------------------------------------

const root = (doc) => doc.querySelector('.ftts-controls, [role="toolbar"]');

test('shows "loading voice" straight away, before any reader exists', () => {
  const { document: doc } = parseHTML('<html><head></head><body><p>Site.</p></body></html>');
  const controls = createControls({ doc, config: { ...DEFAULTS }, timers: createFakeTimers() });

  assert.equal(controls.show(), true);
  controls.showActivity({ phase: 'loading' });

  assert.equal(root(doc).getAttribute('data-phase'), 'loading');
  assert.match(doc.querySelector('.ftts-phase-label').textContent, /loading voice/);
  // A press before the reader is attached must do nothing, not throw.
  assert.doesNotThrow(() => tap(doc, 'play'));

  controls.destroy();
});

test('attaching the reader later makes the bar work, and playing clears "loading"', async () => {
  const { document: doc } = parseHTML('<html><head></head><body><p>Site.</p></body></html>');
  const controls = createControls({ doc, config: { ...DEFAULTS }, timers: createFakeTimers() });
  controls.show();
  controls.showActivity({ phase: 'loading' });

  const engine = createFakeEngine();
  const reader = createReader({ engine, sentences: buildSentences(PARAGRAPHS) });
  controls.attachReader(reader);

  reader.play();
  await settle();

  assert.notEqual(root(doc).getAttribute('data-phase'), 'loading');
  assert.equal(root(doc).getAttribute('data-reader'), 'playing');
  controls.destroy();
});

test('the dot folds and unfolds the info line, and reports the choice', () => {
  const { doc, controls } = setup();
  const folds = [];
  controls.show();
  controls.showActivity({ phase: 'speaking', text: 'Hello.' });
  assert.equal(root(doc).getAttribute('data-folded'), 'false');

  // Rebuild with a listener: onFoldChange is passed at creation.
  controls.destroy();
  const again = createControls({
    doc,
    reader: createReader({ engine: createFakeEngine(), sentences: buildSentences(PARAGRAPHS) }),
    config: { ...DEFAULTS },
    timers: createFakeTimers(),
    onFoldChange: (value) => folds.push(value),
  });
  again.show();

  tap(doc, 'fold');
  assert.equal(root(doc).getAttribute('data-folded'), 'true');
  tap(doc, 'fold');
  assert.equal(root(doc).getAttribute('data-folded'), 'false');
  assert.deepEqual(folds, [true, false]);
  again.destroy();
});

test('starts folded when the saved setting says so, and keeps the dot with no news', () => {
  const { doc, controls } = setup({ controlsFolded: true });
  controls.show();

  assert.equal(root(doc).getAttribute('data-folded'), 'true');
  assert.equal(doc.querySelector('.ftts-status').hidden, false);
  assert.ok(doc.querySelector('.ftts-phase-dot'));
  controls.destroy();
});

test('a paused reader is marked paused, whatever the voice last said', async () => {
  const { doc, reader, controls } = setup();
  controls.show();
  controls.showActivity({ phase: 'speaking', text: 'x' });
  reader.play();
  await settle();
  reader.pause();
  await settle();

  assert.equal(root(doc).getAttribute('data-reader'), 'paused');
  controls.destroy();
});

// ---------------------------------------------------------------------------
// Moving the bar
// ---------------------------------------------------------------------------

/**
 * A window and a bar of known size. linkedom does no layout, so the window's size is set
 * by hand and the bar reports a fixed size at wherever its style last put it.
 */
function giveLayout(doc, { width = 1000, height = 800, bar = { width: 300, height: 100 } } = {}) {
  const win = doc.defaultView;
  Object.defineProperty(win, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(win, 'innerHeight', { value: height, configurable: true });
  const el = root(doc);
  el.getBoundingClientRect = () => ({
    left: Number.parseFloat(el.style.getPropertyValue('left')) || 0,
    top: Number.parseFloat(el.style.getPropertyValue('top')) || 0,
    width: bar.width,
    height: bar.height,
  });
  return {
    resize(w, h) {
      Object.defineProperty(win, 'innerWidth', { value: w, configurable: true });
      Object.defineProperty(win, 'innerHeight', { value: h, configurable: true });
      win.dispatchEvent(new win.Event('resize'));
    },
  };
}

function pointer(doc, target, type, x, y) {
  const event = new doc.defaultView.Event(type, { bubbles: true, cancelable: true });
  event.clientX = x;
  event.clientY = y;
  event.pointerId = 1;
  event.button = 0;
  target.dispatchEvent(event);
  return event;
}

function drag(doc, target, from, to) {
  pointer(doc, target, 'pointerdown', from.x, from.y);
  pointer(doc, root(doc), 'pointermove', (from.x + to.x) / 2, (from.y + to.y) / 2);
  pointer(doc, root(doc), 'pointermove', to.x, to.y);
  pointer(doc, root(doc), 'pointerup', to.x, to.y);
}

const px = (doc, side) => Number.parseFloat(root(doc).style.getPropertyValue(side));

function setupMovable(config = {}) {
  const { document: doc } = parseHTML('<html><head></head><body><p>Site.</p></body></html>');
  const moves = [];
  const controls = createControls({
    doc,
    reader: createReader({ engine: createFakeEngine(), sentences: buildSentences(PARAGRAPHS) }),
    config: { ...DEFAULTS, ...config },
    timers: createFakeTimers(),
    onMove: (spot) => moves.push(spot),
  });
  controls.show();
  const layout = giveLayout(doc);
  // A real browser measures the bar as it goes up; here the size only exists now.
  layout.resize(1000, 800);
  return { doc, controls, moves, layout };
}

test('placeSpot and spotAt: a spot is a fraction of the room, and always inside the window', () => {
  const viewport = { width: 1000, height: 800 };
  const size = { width: 300, height: 100 };
  // Room is 1000-300-16 = 684 across, 800-100-16 = 684 down.
  assert.deepEqual(placeSpot({ spot: { x: 0, y: 0 }, viewport, size }), { left: 8, top: 8 });
  assert.deepEqual(placeSpot({ spot: { x: 1, y: 1 }, viewport, size }), { left: 692, top: 692 });
  assert.deepEqual(spotAt({ left: 350, top: 350, viewport, size }), { x: 0.5, y: 0.5 });
  // Past the edges: stopped at the edges.
  assert.deepEqual(spotAt({ left: -500, top: 5000, viewport, size }), { x: 0, y: 1 });
  // A bar wider than the window is pinned to the left margin, not pushed off it.
  assert.deepEqual(
    placeSpot({ spot: { x: 1, y: 0 }, viewport, size: { width: 1200, height: 100 } }),
    {
      left: 8,
      top: 8,
    }
  );
});

test('dragging the bar by its background moves it and reports where it was let go', () => {
  const { doc, controls, moves } = setupMovable({ controlsSpot: { x: 0, y: 0 } });
  assert.equal(px(doc, 'left'), 8);
  assert.equal(px(doc, 'top'), 8);

  drag(doc, root(doc), { x: 20, y: 20 }, { x: 362, y: 362 });

  assert.equal(px(doc, 'left'), 350);
  assert.equal(px(doc, 'top'), 350);
  assert.deepEqual(moves, [{ x: 0.5, y: 0.5 }]);
  assert.deepEqual(controls.getSpot(), { x: 0.5, y: 0.5 });
  // The corner's own properties are gone, or the bar would stretch between the two.
  assert.equal(root(doc).style.getPropertyValue('right'), '');
  assert.equal(root(doc).style.getPropertyValue('bottom'), '');
  assert.equal(root(doc).hasAttribute('data-dragging'), false);
  controls.destroy();
});

test('a bar dragged off the edge stops at the edge', () => {
  const { doc, controls, moves } = setupMovable({ controlsSpot: { x: 0.5, y: 0.5 } });
  drag(doc, root(doc), { x: 400, y: 400 }, { x: 5000, y: -5000 });

  assert.equal(px(doc, 'left'), 692);
  assert.equal(px(doc, 'top'), 8);
  assert.deepEqual(moves, [{ x: 1, y: 0 }]);
  controls.destroy();
});

test('dragging from the corner it started in takes over from the corner', () => {
  const { doc, controls, moves } = setupMovable();
  // Bottom-right by default, and linkedom puts it at 0,0: the drag starts from there.
  assert.equal(root(doc).style.getPropertyValue('left'), '');
  drag(doc, root(doc), { x: 10, y: 10 }, { x: 110, y: 110 });

  assert.equal(px(doc, 'left'), 100);
  assert.equal(root(doc).style.getPropertyValue('right'), '');
  assert.equal(moves.length, 1);
  controls.destroy();
});

test('a press on a button never drags, and a tiny wobble is not a move', () => {
  const { doc, controls, moves } = setupMovable({ controlsSpot: { x: 0, y: 0 } });

  drag(doc, button(doc, 'play'), { x: 20, y: 20 }, { x: 200, y: 200 });
  drag(doc, button(doc, 'fold'), { x: 20, y: 20 }, { x: 200, y: 200 });
  assert.equal(px(doc, 'left'), 8);

  drag(doc, root(doc), { x: 20, y: 20 }, { x: 22, y: 21 });
  assert.equal(px(doc, 'left'), 8);
  assert.deepEqual(moves, []);
  controls.destroy();
});

test('a saved spot is kept inside the window when the window shrinks', () => {
  const { doc, controls, layout } = setupMovable({ controlsSpot: { x: 1, y: 1 } });
  assert.equal(px(doc, 'left'), 692);

  layout.resize(500, 400);
  // Still against the bottom-right margin of the smaller window, not off it.
  assert.equal(px(doc, 'left'), 500 - 300 - 8);
  assert.equal(px(doc, 'top'), 400 - 100 - 8);
  controls.destroy();
});

test('the speed list opens toward the bigger half of the window', () => {
  const top = setupMovable({ controlsSpot: { x: 0.5, y: 0.1 } });
  assert.equal(root(top.doc).getAttribute('data-open'), 'down');
  top.controls.destroy();

  const bottom = setupMovable({ controlsSpot: { x: 0.5, y: 0.9 } });
  assert.equal(root(bottom.doc).getAttribute('data-open'), 'up');
  bottom.controls.destroy();
});

test('with no saved spot the bar stays in its corner', () => {
  const { doc, controls } = setupMovable();
  assert.equal(controls.getSpot(), null);
  assert.ok(root(doc).style.getPropertyValue('right'));
  assert.ok(root(doc).style.getPropertyValue('bottom'));
  controls.destroy();
});

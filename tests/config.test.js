import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, resolveConfig, SCROLL_BEHAVIORS } from '../src/lib/config.js';

test('uses the defaults when nothing is stored', () => {
  assert.deepEqual(resolveConfig(undefined), DEFAULTS);
  assert.deepEqual(resolveConfig(null), DEFAULTS);
  assert.deepEqual(resolveConfig('nonsense'), DEFAULTS);
});

test('stored settings override the defaults', () => {
  const config = resolveConfig({ rate: 1.4, voiceName: 'Microsoft Zira', lang: 'en-GB' });

  assert.equal(config.rate, 1.4);
  assert.equal(config.voiceName, 'Microsoft Zira');
  assert.equal(config.lang, 'en-GB');
});

test('ignores a speed outside what a voice can do', () => {
  assert.equal(resolveConfig({ rate: 0 }).rate, DEFAULTS.rate);
  assert.equal(resolveConfig({ rate: 99 }).rate, DEFAULTS.rate);
  assert.equal(resolveConfig({ rate: 'fast' }).rate, DEFAULTS.rate);
  assert.equal(resolveConfig({ rate: NaN }).rate, DEFAULTS.rate);
});

test('ignores an out-of-range volume and pitch', () => {
  assert.equal(resolveConfig({ volume: 5 }).volume, DEFAULTS.volume);
  assert.equal(resolveConfig({ pitch: -1 }).pitch, DEFAULTS.pitch);
});

test('ignores an empty voice name rather than storing a blank', () => {
  assert.equal(resolveConfig({ voiceName: '' }).voiceName, DEFAULTS.voiceName);
});

test('does not modify the defaults it hands out', () => {
  resolveConfig({ rate: 2 }).rate = 3;
  assert.equal(DEFAULTS.rate, 1.0);
});

test('everything we add to a page is namespaced', () => {
  assert.equal(DEFAULTS.namespace, 'ftts');
});

test('accepts colours that are plainly colours', () => {
  for (const color of ['#ffe57f', '#fe7', 'rgba(255, 229, 127, 0.4)', 'rgb(1,2,3)', 'yellow']) {
    assert.equal(resolveConfig({ highlightColor: color }).highlightColor, color);
  }
});

test('refuses anything that is not plainly a colour', () => {
  // This value ends up in a stylesheet on a page we do not own, and stored settings come
  // off disk where they may have been hand-edited. Anything doubtful falls back.
  const rejected = [
    'red; background: url(evil)',
    '#fff;}body{display:none',
    'url(evil)',
    'javascript:alert(1)',
    'expression(alert(1))',
    'a'.repeat(40),
    '',
    42,
    null,
  ];
  for (const color of rejected) {
    assert.equal(
      resolveConfig({ highlightColor: color }).highlightColor,
      DEFAULTS.highlightColor,
      `${String(color).slice(0, 30)} should not have reached the page`
    );
  }
});

test('the highlight text colour may be turned off with null', () => {
  assert.equal(resolveConfig({ highlightTextColor: null }).highlightTextColor, null);
  assert.equal(resolveConfig({ highlightTextColor: 'black' }).highlightTextColor, 'black');
  assert.equal(
    resolveConfig({ highlightTextColor: 'black; }' }).highlightTextColor,
    DEFAULTS.highlightTextColor
  );
});

test('scroll settings outside sensible limits fall back to the defaults', () => {
  assert.equal(resolveConfig({ scrollTopMargin: 0.9 }).scrollTopMargin, DEFAULTS.scrollTopMargin);
  assert.equal(
    resolveConfig({ scrollBottomMargin: -0.1 }).scrollBottomMargin,
    DEFAULTS.scrollBottomMargin
  );
  assert.equal(
    resolveConfig({ scrollRespectUserMs: -1 }).scrollRespectUserMs,
    DEFAULTS.scrollRespectUserMs
  );
  assert.equal(resolveConfig({ scrollSettleMs: 'soon' }).scrollSettleMs, DEFAULTS.scrollSettleMs);
  assert.equal(resolveConfig({ scrollTopMargin: 0.3 }).scrollTopMargin, 0.3);
});

test('only the two scroll behaviours the browser understands are accepted', () => {
  assert.equal(resolveConfig({ scrollBehavior: 'auto' }).scrollBehavior, 'auto');
  assert.equal(resolveConfig({ scrollBehavior: 'smooth' }).scrollBehavior, 'smooth');
  assert.equal(
    resolveConfig({ scrollBehavior: 'instant' }).scrollBehavior,
    DEFAULTS.scrollBehavior
  );
  assert.deepEqual(SCROLL_BEHAVIORS, ['smooth', 'auto']);
});

test('following the sentence can be turned off, and nothing else can turn it off', () => {
  assert.equal(resolveConfig({ scrollToSentence: false }).scrollToSentence, false);
  assert.equal(resolveConfig({ scrollToSentence: 'no' }).scrollToSentence, true);
});

test('a stored speed is clamped to the range the bar can reach', () => {
  // Plus and minus stop at the bounds, so a stored speed outside them would sit there
  // with one button disabled and no way back — which looks exactly like the fault that
  // cost two sessions, rather than like a setting out of range.
  assert.equal(resolveConfig({ rate: 9 }).rate, DEFAULTS.maxRate);
  assert.equal(resolveConfig({ rate: 0.2 }).rate, DEFAULTS.minRate);
  assert.equal(resolveConfig({ rate: 1.35 }).rate, 1.35, 'an ordinary speed is untouched');
});

test('the clamp respects a customised range, not only the default one', () => {
  /*
   * THE ORDER OF TWO LINES, and it is worth a test because it is invisible in a diff.
   * The speed is clamped against minRate and maxRate, so it must be read AFTER them. Read
   * earlier, a stored 3.5x would be clamped against the default maximum of 3 even when
   * the settings raise that maximum to 4 — a bug that only appears for someone who
   * changed both, which is to say the person most likely to notice and least likely to be
   * believed.
   */
  assert.equal(resolveConfig({ rate: 3.5, maxRate: 4 }).rate, 3.5);
  assert.equal(resolveConfig({ rate: 0.3, minRate: 0.25 }).rate, 0.3);
});

test('the fine step and the speed bounds come off disk sanely', () => {
  assert.equal(resolveConfig({ speedStep: 0.1 }).speedStep, 0.1);
  assert.equal(resolveConfig({ speedStep: 0 }).speedStep, DEFAULTS.speedStep, 'a zero step');
  assert.equal(resolveConfig({ speedStep: 'fine' }).speedStep, DEFAULTS.speedStep);
  assert.equal(resolveConfig({ maxRate: 99 }).maxRate, DEFAULTS.maxRate, 'beyond the model');
  assert.equal(resolveConfig({ minRate: 0 }).minRate, DEFAULTS.minRate);
});

test('the dark-page highlight colour is validated like the other', () => {
  assert.equal(resolveConfig({ highlightColorDark: '#123456' }).highlightColorDark, '#123456');
  assert.equal(
    resolveConfig({ highlightColorDark: 'red; } body { display: none' }).highlightColorDark,
    DEFAULTS.highlightColorDark
  );
});

test('a dragged bar position is kept only when both fractions are within 0..1', () => {
  assert.deepEqual(resolveConfig({ controlsSpot: { x: 0.25, y: 1 } }).controlsSpot, {
    x: 0.25,
    y: 1,
  });
  assert.equal(resolveConfig({}).controlsSpot, null);
  assert.equal(resolveConfig({ controlsSpot: { x: 2, y: 0.5 } }).controlsSpot, null);
  assert.equal(resolveConfig({ controlsSpot: { x: 0.5 } }).controlsSpot, null);
  assert.equal(resolveConfig({ controlsSpot: 'bottom' }).controlsSpot, null);
});

/**
 * The floating control bar — the add-on's only visible furniture.
 *
 * Everything else we put on a page wraps text that was already there. This is different:
 * it is a thing we build and place on top of someone else's layout. So the rules from
 * PLAN.md bite hardest here — every class prefixed `ftts-`, nothing left behind when it
 * goes, and no site rule able to hide it or push it about.
 *
 * It is built for a finger first. That is not a coat of paint on a mouse design: it
 * changes the button size, the spacing, what counts as a press, and what may be hidden
 * behind a hover. Specifically —
 *
 *   - Every target is at least 44px square, the smallest size Apple and Google both
 *     publish as reliably touchable, and 48 by default.
 *   - Nothing is hover-only. A finger cannot hover, so anything reachable only that way
 *     does not exist on a tablet. Labels come from `aria-label` and `title`, which a
 *     mouse gets as a tooltip and a screen reader reads out, and neither is needed in
 *     order to understand the buttons.
 *   - Presses are handled on `pointerdown`, not `click`. A tablet browser waits to see
 *     whether a tap becomes a double-tap or a scroll before it fires `click`, and that
 *     wait is felt as lag on every button.
 *   - Speed is a button that steps through speeds, not a slider. Dragging a small slider
 *     accurately on a moving tablet is a fiddly job; tapping through six values is not.
 *   - Double-tap zoom and text selection are suppressed on the bar itself, because
 *     double-tapping "skip forward" twice quickly is a completely reasonable thing to do
 *     and should not zoom the article instead.
 *
 * The reader does not know this file exists, and this file does not know how sound is
 * made. It calls the reader's small vocabulary — play, pause, skip a sentence, skip a
 * paragraph — and listens for what the reader announces. Keeping the direction of
 * knowledge one-way is what lets the bar be redrawn without touching playback.
 */

// DIAGNOSIS. Kept deliberately: the trace is what settled the thread fault that three
// sessions of reasoning could not, and it stays available for the next inexplicable one.
import { trace } from './trace.js';

/** Everything we add carries these, so it can always be found and removed. */
const ROOT_CLASS = 'ftts-controls';
const STYLE_ID = 'ftts-controls-style';

/** Named so the stylesheet stays a constant and no stored setting can become CSS. */
const SIZE_VAR = '--ftts-button-size';

/**
 * Icon paths, drawn on a 24x24 grid.
 *
 * SVG rather than characters, because an emoji or a glyph is at the mercy of the site's
 * font stack and a missing glyph shows as a blank box. Deliberately simple shapes: these
 * are rendered at a size a finger covers, so detail is wasted. The paragraph icons are
 * the sentence ones with a second bar, which is the clearest way to say "the same move,
 * but bigger" without a word of text.
 */
const ICONS = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 5h4v14H6zm8 0h4v14h-4z',
  prev: 'M16 5v14L5 12zM18 5h2v14h-2z',
  next: 'M8 5l11 7-11 7zM4 5h2v14H4z',
  'prev-paragraph': 'M14 6v12L6 12zM16 6h2v12h-2zm3 0h2v12h-2z',
  'next-paragraph': 'M10 6l8 6-8 6zM3 6h2v12H3zm3 0h2v12H6z',
  close:
    'M18.3 4.3l1.4 1.4L13.4 12l6.3 6.3-1.4 1.4L12 13.4l-6.3 6.3-1.4-1.4L10.6 12 4.3 5.7l1.4-1.4L12 10.6z',
  // Drawn rather than typed for the same reason as the rest: a bare "+" or "−" would be
  // at the mercy of the site's font, and a minus sign in particular is a character many
  // fonts render as a hyphen of the wrong width.
  plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z',
  minus: 'M5 11h14v2H5z',
};

/**
 * The buttons, in order, left to right.
 *
 * Paragraph skip sits *outside* sentence skip on each side, so the two pairs read as
 * "small step" and "big step" outward from the middle. Grouping them the other way round
 * would put the two most easily confused buttons next to each other.
 *
 * Play sits in the centre because on a tablet held in two hands the middle of the bar is
 * where a thumb naturally lands, and it should always find the button that matters most.
 */
const BUTTONS = [
  {
    name: 'prev-paragraph',
    label: 'Previous paragraph',
    command: 'prevParagraph',
    icon: 'prev-paragraph',
  },
  { name: 'prev-sentence', label: 'Previous sentence', command: 'prevSentence', icon: 'prev' },
  { name: 'play', label: 'Play', command: 'toggle', icon: 'play', primary: true },
  { name: 'next-sentence', label: 'Next sentence', command: 'nextSentence', icon: 'next' },
  {
    name: 'next-paragraph',
    label: 'Next paragraph',
    command: 'nextParagraph',
    icon: 'next-paragraph',
  },
  /*
   * Speed is three controls that read as one: minus, the number, plus.
   *
   * The number is a button too, and tapping it opens the preset list. That is what keeps
   * fine control from becoming a chore — 0.05 steps are what the owner asked for and are
   * genuinely audible over a long article, but nobody wants to tap plus ten times to get
   * from 1x to 1.5x.
   */
  { name: 'speed-down', label: 'Slower', command: 'slower', icon: 'minus', compact: true },
  { name: 'speed', label: 'Speed', command: 'openSpeedMenu', text: '1x' },
  { name: 'speed-up', label: 'Faster', command: 'faster', icon: 'plus', compact: true },
  { name: 'close', label: 'Stop reading', command: 'stop', icon: 'close' },
];

/** Stands in for the reader while the article is still being prepared. */
const NO_READER = {
  getState: () => 'idle',
  toggle() {},
  skip() {},
  skipParagraph() {},
};

/**
 * The stylesheet.
 *
 * A constant, never assembled from settings — the one number that varies arrives as a CSS
 * custom property instead. That is the same rule the highlighter follows, and the reason
 * is the same: a stored value that can reach a stylesheet as text is a way for a setting
 * to become code on a page we do not own.
 *
 * `!important` throughout, and a very high `z-index`, because we are a guest. Sites set
 * sweeping rules on `div` and `button`, and without these the bar acquires the site's
 * button styling, its font, or a `z-index` that buries it under a sticky header.
 *
 * `all: initial` on the buttons is the blunt version of that: it throws away everything
 * the site has to say about buttons before we style ours, which is far more reliable than
 * guessing which of the site's rules will land.
 */
const STYLE_TEXT = `
.${ROOT_CLASS} {
  position: fixed !important;
  z-index: 2147483000 !important;
  display: flex !important;
  align-items: center !important;
  gap: 4px !important;
  box-sizing: border-box !important;
  margin: 0 !important;
  padding: 6px !important;
  border: none !important;
  border-radius: 999px !important;
  background: rgba(28, 28, 32, 0.94) !important;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.35) !important;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
  opacity: 1;
  transition: opacity 220ms ease;
  /* A finger on the bar drags the bar, not the page — and so a double tap on a button
     cannot zoom either, which is the other thing this used to be here for. */
  touch-action: none !important;
  /* Says "this can be picked up" wherever a press would start a drag. The buttons set their
     own pointer cursor, so this shows only on the bar's background and its info panel. */
  cursor: grab !important;
  -webkit-user-select: none !important;
  user-select: none !important;
  /* Tablets paint a grey flash on tap; we draw our own pressed state instead. */
  -webkit-tap-highlight-color: transparent !important;
  direction: ltr !important;
}

/* Held while being dragged: no fade animation lagging behind the pointer. */
.${ROOT_CLASS}[data-dragging='true'] {
  cursor: grabbing !important;
  transition: none !important;
}

/* Faded, not gone: a bar that vanished completely would look like a crash. It still
   takes taps while faded, so reaching for it works even before it comes back. */
.${ROOT_CLASS}[data-idle='true'] {
  opacity: 0.28;
}

.${ROOT_CLASS} button {
  all: initial !important;
  box-sizing: border-box !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  width: var(${SIZE_VAR}, 48px) !important;
  height: var(${SIZE_VAR}, 48px) !important;
  flex: 0 0 auto !important;
  border-radius: 50% !important;
  cursor: pointer !important;
  color: #f4f4f5 !important;
  background: transparent !important;
  font-family: inherit !important;
  font-size: 15px !important;
  font-weight: 600 !important;
  text-align: center !important;
  touch-action: manipulation !important;
  -webkit-tap-highlight-color: transparent !important;
}

.${ROOT_CLASS} button[data-primary='true'] {
  background: #4c8dff !important;
  color: #ffffff !important;
}

/* Pressed state driven by pointerdown rather than :active, so it appears the instant a
   finger lands. On a tablet :active can wait for the browser to rule out a scroll. */
.${ROOT_CLASS} button[data-pressed='true'] {
  background: rgba(255, 255, 255, 0.22) !important;
  transform: scale(0.94);
}

.${ROOT_CLASS} button[data-primary='true'][data-pressed='true'] {
  background: #3a76e0 !important;
}

/*
 * A button at the end of its range: plus at 3x, minus at 0.5x.
 *
 * Dimmed AND told not to take the pointer, so it neither invites a press nor reports one.
 * The lesson is from the speed button that could not be pressed: a control that looks live
 * and silently does nothing is the worst of both, because the listener cannot tell whether
 * they missed. This one admits it is spent.
 */
.${ROOT_CLASS} button[disabled] {
  opacity: 0.32 !important;
  cursor: default !important;
  pointer-events: none !important;
}

/* Plus and minus sit tight against the number they belong to, so the three read as one
   control rather than three unrelated buttons that happen to be adjacent. */
.${ROOT_CLASS} button[data-compact='true'] {
  width: 34px !important;
}

/*
 * The preset list.
 *
 * Anchored to the bar rather than to the page, so it travels with it. It opens upward by
 * default because the bar usually sits at the bottom of the window; when the bar is at the
 * top it opens downward instead — a list that opened off the edge of the screen would be
 * unreachable.
 */
.${ROOT_CLASS} .ftts-menu {
  position: absolute !important;
  bottom: calc(100% + 6px) !important;
  left: 50% !important;
  transform: translateX(-50%) !important;
  z-index: 1 !important;
  display: flex !important;
  flex-direction: column !important;
  gap: 2px !important;
  box-sizing: border-box !important;
  padding: 4px !important;
  border-radius: 12px !important;
  background: #18181b !important;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45) !important;
}

.${ROOT_CLASS}[data-open='down'] .ftts-menu {
  bottom: auto !important;
  top: calc(100% + 6px) !important;
}

.${ROOT_CLASS} .ftts-menu-item {
  all: initial !important;
  box-sizing: border-box !important;
  display: block !important;
  /* A full-width target: the list is tapped with a finger like everything else here. */
  min-width: 88px !important;
  padding: 10px 14px !important;
  border-radius: 8px !important;
  cursor: pointer !important;
  color: #f4f4f5 !important;
  background: transparent !important;
  font-family: inherit !important;
  font-size: 14px !important;
  font-variant-numeric: tabular-nums !important;
  text-align: center !important;
}

.${ROOT_CLASS} .ftts-menu-item[data-current='true'] {
  background: #4c8dff !important;
  color: #ffffff !important;
  font-weight: 600 !important;
}

/* Keyboard focus must stay visible: it is the one affordance a keyboard user depends on,
   and the all:initial reset above would otherwise have thrown it away. */
.${ROOT_CLASS} button:focus-visible {
  outline: 2px solid #9dc4ff !important;
  outline-offset: 2px !important;
}

.${ROOT_CLASS} svg {
  width: 58% !important;
  height: 58% !important;
  display: block !important;
  fill: currentColor !important;
  /* So a tap always lands on the button, never on the icon inside it. */
  pointer-events: none !important;
}

/*
 * The speed label inside the speed button.
 *
 * THE NAME MATTERS, and it is the whole of a bug that cost two sessions. This was once
 * ftts-speed, which is ALSO the class every button carries for its own name — so the
 * selector matched the button as well as the label, and pointer-events: none made the
 * speed button deaf to every press. It was the only button affected, because it is the
 * only one whose label needed a class at all, and its name collided with its own.
 *
 * The rule below is still needed and still right: a tap must land on the button, never on
 * the text inside it. It simply has to name something the button is not.
 */
.${ROOT_CLASS} .ftts-speed-label {
  font-variant-numeric: tabular-nums !important;
  font-size: 14px !important;
  pointer-events: none !important;
}

/*
 * The status panel.
 *
 * Sits above the buttons rather than inside the row, so the row of controls keeps its
 * shape and its touch targets whatever the status happens to say. It is a development
 * display: deliberately wordy, showing what the voice is doing, how long the last sentence
 * took to build, and how many are banked ahead.
 */
.${ROOT_CLASS} {
  flex-direction: column !important;
  align-items: stretch !important;
  border-radius: 16px !important;
  /* So the preset list can be positioned against the bar rather than the page. */
  position: fixed !important;
}

.${ROOT_CLASS} .ftts-row {
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 4px !important;
}

/*
 * THE PANEL IS A FIXED SIZE, and every part of that is deliberate.
 *
 * It used to grow and shrink with whatever it was saying — a one-line sentence then a
 * two-line one, a panel that vanished entirely when idle — so the bar moved and resized
 * while an article played. Restless to look at, and worse than cosmetic: it made testing
 * the voice harder, because the thing being judged kept jumping.
 *
 * So the box is fixed and the TEXT is made to fit it, rather than the box stretching to
 * fit the text: a fixed width rather than a maximum one, and a height that holds two
 * lines of preview whether or not there are two lines to show.
 */
.${ROOT_CLASS} .ftts-status {
  box-sizing: border-box !important;
  /* Never wider than the phone or tablet it is on, and never wider than the buttons need. */
  width: min(78vw, 420px) !important;
  margin: 2px 6px 4px !important;
  padding: 0 !important;
  color: #d4d4d8 !important;
  font-size: 12px !important;
  line-height: 1.45 !important;
  text-align: left !important;
}

/*
 * Kept in the layout when there is nothing to say, rather than removed from it.
 *
 * Hidden by visibility rather than by display, so the panel still occupies its space and
 * the bar does not jump the moment the voice goes quiet, then jump back when it resumes.
 */
.${ROOT_CLASS} .ftts-status[hidden] {
  display: block !important;
  visibility: hidden !important;
}

/* The line that says what is happening: building, speaking, waiting. */
/*
 * The line that says what is happening.
 *
 * One line, always, and never wrapped. It gains and loses words as the phase changes —
 * "building audio 1.2s of ~3.4s · 6 ready" is a good deal longer than "speaking" — and
 * allowing that to wrap onto a second line would resize the bar on almost every update.
 * Tabular numerals stop the counting digits from shuffling the text sideways as they tick.
 */
.${ROOT_CLASS} .ftts-phase {
  display: flex !important;
  align-items: center !important;
  gap: 6px !important;
  min-width: 0 !important;
  white-space: nowrap !important;
  color: #f4f4f5 !important;
  font-weight: 600 !important;
  font-variant-numeric: tabular-nums !important;
}

/* Truncated rather than wrapped, for the same reason: the box is fixed, the text fits it. */
.${ROOT_CLASS} .ftts-phase-label {
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  white-space: nowrap !important;
}

.${ROOT_CLASS} .ftts-phase-dot {
  flex: 0 0 auto !important;
  width: 9px !important;
  height: 9px !important;
  border-radius: 50% !important;
  background: #71717a !important;
}

/*
 * The dot is also the fold button: a press on it hides or shows everything else in the
 * panel. The button is bigger than the dot so a finger can hit it; it overrides the
 * bar-wide button size above, which is meant for the row of controls.
 */
.${ROOT_CLASS} .ftts-status .ftts-fold {
  width: 22px !important;
  height: 22px !important;
  margin: -6px 0 -6px -6px !important;
}

.${ROOT_CLASS} .ftts-fold:focus-visible {
  outline: 2px solid #9dc4ff !important;
}

/* Amber while the voice is loading or building, and pulsing so it reads as "working". */
.${ROOT_CLASS}[data-phase='loading'] .ftts-phase-dot,
.${ROOT_CLASS}[data-phase='generating'] .ftts-phase-dot,
.${ROOT_CLASS}[data-phase='waiting'] .ftts-phase-dot {
  background: #fbbf24 !important;
  animation: ftts-pulse 1.1s ease-in-out infinite !important;
}

.${ROOT_CLASS}[data-phase='speaking'] .ftts-phase-dot {
  background: #4ade80 !important;
}

/* Paused is the reader's word, not the voice's, so it has the final say over speaking. */
.${ROOT_CLASS}[data-reader='paused'] .ftts-phase-dot,
.${ROOT_CLASS}[data-phase='paused'] .ftts-phase-dot {
  background: #60a5fa !important;
  animation: none !important;
}

.${ROOT_CLASS}[data-phase='error'] .ftts-phase-dot {
  background: #f87171 !important;
  animation: none !important;
}

/* Folded, an error must still be noticed, so it pulses. */
.${ROOT_CLASS}[data-folded='true'][data-phase='error'] .ftts-phase-dot {
  animation: ftts-pulse 1.1s ease-in-out infinite !important;
}

@keyframes ftts-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

/* Folded: only the dot is left, and the panel shrinks to it. */
.${ROOT_CLASS}[data-folded='true'] .ftts-status {
  width: auto !important;
}
.${ROOT_CLASS}[data-folded='true'] .ftts-phase-label,
.${ROOT_CLASS}[data-folded='true'] .ftts-text,
.${ROOT_CLASS}[data-folded='true'] .ftts-track {
  display: none !important;
}

/*
 * The sentence being worked on.
 *
 * Two lines ALWAYS, not at most two. The clamp already stopped a long sentence growing
 * the bar; the fixed height stops a short one shrinking it, which is the other half of
 * holding still. A one-line sentence simply leaves the second line empty.
 *
 * The height is stated in em rather than pixels, so it stays exactly two lines if the
 * font size is ever changed — a pixel height would silently stop matching.
 */
.${ROOT_CLASS} .ftts-text {
  display: -webkit-box !important;
  -webkit-line-clamp: 2 !important;
  -webkit-box-orient: vertical !important;
  overflow: hidden !important;
  margin-top: 2px !important;
  height: 2.9em !important;
  line-height: 1.45 !important;
  color: #a1a1aa !important;
  font-style: italic !important;
  font-size: 11px !important;
}

/* How far through the estimated build time we are. */
.${ROOT_CLASS} .ftts-track {
  height: 3px !important;
  margin-top: 4px !important;
  border-radius: 999px !important;
  background: rgba(255, 255, 255, 0.16) !important;
  overflow: hidden !important;
}

.${ROOT_CLASS} .ftts-fill {
  display: block !important;
  height: 100% !important;
  width: 0% !important;
  border-radius: 999px !important;
  background: #fbbf24 !important;
  transition: width 180ms linear !important;
}

.${ROOT_CLASS}[data-phase='speaking'] .ftts-fill {
  background: #4ade80 !important;
}

@media (prefers-reduced-motion: reduce) {
  .${ROOT_CLASS} .ftts-fill {
    transition: none !important;
  }
  .${ROOT_CLASS} .ftts-phase-dot {
    animation: none !important;
  }
}

@media (prefers-reduced-motion: reduce) {
  .${ROOT_CLASS} {
    transition: none !important;
  }
  .${ROOT_CLASS} button[data-pressed='true'] {
    transform: none;
  }
}
`;

/**
 * Where each position sits, as a fixed table of known values.
 *
 * `env(safe-area-inset-*)` is what keeps the bar clear of a tablet's rounded corners and
 * its home indicator. Without it the bar on a tablet in landscape can sit partly under
 * the system's own swipe bar, where taps go to the operating system rather than to us —
 * the button looks perfectly fine and simply does not work.
 */
const SAFE_BOTTOM = 'calc(16px + env(safe-area-inset-bottom, 0px))';
const SAFE_TOP = 'calc(16px + env(safe-area-inset-top, 0px))';
const SAFE_LEFT = 'calc(16px + env(safe-area-inset-left, 0px))';
const SAFE_RIGHT = 'calc(16px + env(safe-area-inset-right, 0px))';

/**
 * Each position is a set of properties rather than a string of style text, and they are
 * applied one property at a time. Assembling style text and assigning it wholesale is how
 * the button size got trampled the first time this was written — and it is also the shape
 * that would let a stored value become CSS, which is exactly what we do not want.
 */
const POSITIONS = {
  'bottom-right': { bottom: SAFE_BOTTOM, right: SAFE_RIGHT },
  'bottom-left': { bottom: SAFE_BOTTOM, left: SAFE_LEFT },
  'bottom-center': { bottom: SAFE_BOTTOM, left: '50%', transform: 'translateX(-50%)' },
  'top-right': { top: SAFE_TOP, right: SAFE_RIGHT },
  'top-left': { top: SAFE_TOP, left: SAFE_LEFT },
  'top-center': { top: SAFE_TOP, left: '50%', transform: 'translateX(-50%)' },
};

/** How close to the window's edge a dragged bar may go, in CSS pixels. */
const EDGE_MARGIN = 8;

/**
 * How far a press must travel before it counts as a drag.
 *
 * Without it every press on the bar's background would nudge it a pixel or two, and a tap
 * on the info panel would be read as a tiny move and saved.
 */
const DRAG_THRESHOLD = 4;

/**
 * Where on screen a stored spot puts the bar.
 *
 * The spot is a pair of fractions of the room the bar has to move in, so the answer is
 * always inside the window: 0 puts the bar against the left (or top) margin, 1 against the
 * right (or bottom) one. A bar bigger than the window is pinned to the top-left margin,
 * which keeps its start — and the info line — in view.
 */
export function placeSpot({ spot, viewport, size, margin = EDGE_MARGIN }) {
  const roomX = Math.max(0, viewport.width - size.width - 2 * margin);
  const roomY = Math.max(0, viewport.height - size.height - 2 * margin);
  return {
    left: margin + clamp01(spot?.x) * roomX,
    top: margin + clamp01(spot?.y) * roomY,
  };
}

/**
 * The spot for a bar whose top-left corner is at `left`, `top` — the reverse of placeSpot.
 *
 * Clamped, so dragging past an edge stops the bar at the edge rather than losing it.
 */
export function spotAt({ left, top, viewport, size, margin = EDGE_MARGIN }) {
  const roomX = viewport.width - size.width - 2 * margin;
  const roomY = viewport.height - size.height - 2 * margin;
  return {
    x: roomX > 0 ? round4(clamp01((left - margin) / roomX)) : 0,
    y: roomY > 0 ? round4(clamp01((top - margin) / roomY)) : 0,
  };
}

function clamp01(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** Four decimals is a tenth of a pixel on a 1000px window; the rest is noise to store. */
function round4(value) {
  return Math.round(value * 10000) / 10000;
}

/** Turn a rate into the short label the speed button shows. */
export function formatSpeed(rate) {
  const rounded = Math.round(rate * 100) / 100;
  const text = Number.isInteger(rounded) ? String(rounded) : String(rounded);
  return `${text}x`;
}

/**
 * Move the speed by one step, and stop at the ends.
 *
 * NO WRAPPING HERE, unlike the preset list, and the difference is the point. Wrapping made
 * sense when one button cycled six speeds and a dead end would have stranded the listener.
 * With a plus and a minus there is always a way back, and a plus that jumped from 3x to
 * 0.5x would be a nasty surprise in the middle of an article.
 *
 * ROUNDED TO THE STEP, not merely added to. Repeated addition of 0.05 in binary floating
 * point drifts — 1.0000000000000002 — and that number reaches a label, a stored setting,
 * and the comparison that decides whether a change is worth rebuilding eight sentences
 * for. Snapping to the grid keeps all three honest.
 */
export function stepSpeed(current, direction, { step = 0.05, min = 0.5, max = 3 } = {}) {
  const from = typeof current === 'number' && Number.isFinite(current) ? current : 1;
  if (!Number.isFinite(step) || step <= 0) return from;

  const moved = from + step * Math.sign(direction);
  // Rounded onto the step grid so a value that arrived off-grid — from stored settings, or
  // from a preset like 1.75 with a step of 0.05 — lands on it rather than carrying its
  // offset forward forever.
  const snapped = Math.round(moved / step) * step;
  const clamped = Math.min(max, Math.max(min, snapped));

  // Two decimals is the finest step anyone would sensibly use, and it removes the binary
  // fraction dust that survives the rounding above.
  return Math.round(clamped * 100) / 100;
}

/**
 * Create the control bar.
 *
 * @param {object} options
 * @param {Document} options.doc the page being read
 * @param {object} options.reader the reader to drive
 * @param {object} options.config resolved settings; see lib/config.js
 * @param {(rate: number) => void} [options.onSpeedChange] told when the speed button is used
 * @param {() => void} [options.onStop] told when the close button is used
 * @param {(spot: {x: number, y: number}) => void} [options.onMove] told where the bar was dragged to
 * @param {object} [options.timers] setTimeout/clearTimeout, injectable so tests need not wait
 */
export function createControls({
  doc,
  reader: initialReader,
  config = {},
  onSpeedChange,
  onStop,
  onFoldChange,
  onMove,
  timers,
  now,
}) {
  // The bar can go up before the article is ready, so it may start with no reader at all.
  // Until one is attached the buttons do nothing rather than fail.
  let reader = initialReader ?? NO_READER;
  const clock = timers ?? defaultTimers(doc);
  const timeNow = now ?? (() => Date.now());

  let root = null;
  let styleElement = null;
  let destroyed = false;

  /** The buttons by name, so updating one does not mean searching the page for it. */
  const elements = new Map();

  let rate = typeof config.rate === 'number' ? config.rate : 1;
  /** The open preset list, or null. Built on demand; see openSpeedMenu. */
  let speedMenu = null;
  let idleTimer = null;
  let idle = false;

  /** The status panel's elements, or null when the panel is switched off. */
  let status = null;
  /** Repaints the countdown while a sentence is being built. */
  let tickTimer = null;
  /** What the voice is doing now, so a tick can repaint without being told again. */
  let activity = null;
  /** Where we are in the article: `{ index, total, text }`. From the reader, not the voice. */
  let position = null;

  /** Whether the info line is folded down to the dot. Remembered by the owner via onFoldChange. */
  let folded = config.controlsFolded === true;

  /** Where the listener dragged the bar, as fractions; null means the corner from settings. */
  let spot =
    config.controlsSpot && typeof config.controlsSpot === 'object'
      ? { x: clamp01(config.controlsSpot.x), y: clamp01(config.controlsSpot.y) }
      : null;
  /** The drag in progress, or null. */
  let drag = null;

  /** Unsubscribes for everything we attached to the reader or the page. */
  const teardown = [];

  /**
   * What each button does.
   *
   * A flat map of name to action, so the bar has no branching logic of its own — it is a
   * lookup, and every entry is one call into the reader. Anything more interesting than
   * this belongs in the reader, where position lives.
   */
  const commands = {
    /**
     * Play or pause.
     *
     * Nothing repaints the icon here, and that is deliberate rather than an omission: the
     * reader announces its new state synchronously, inside this call, and the bar's
     * subscription redraws the button before this line returns. Repainting again afterwards
     * would be dead code that looks load-bearing.
     *
     * What makes that instant is on the reader's side — it announces the pause *before*
     * asking the voice to stop, so the button never waits on the sound. See reader.pause().
     */
    toggle: () => reader.toggle(),
    prevSentence: () => reader.skip(-1),
    nextSentence: () => reader.skip(1),
    prevParagraph: () => reader.skipParagraph(-1),
    nextParagraph: () => reader.skipParagraph(1),
    faster: () => applySpeed(stepSpeed(rate, +1, speedBounds())),
    slower: () => applySpeed(stepSpeed(rate, -1, speedBounds())),
    openSpeedMenu: () => toggleSpeedMenu(),
    // Stopping is content.js's business — it owns the session and the highlight — so this
    // reports the press rather than tearing itself down behind its owner's back.
    stop: () => onStop?.(),
  };

  function ensureStyle() {
    try {
      if (styleElement && styleElement.parentNode) return;

      if (!styleElement) {
        styleElement = doc.createElement('style');
        styleElement.id = STYLE_ID;
        styleElement.textContent = STYLE_TEXT;
      }
      (doc.head ?? doc.documentElement)?.appendChild(styleElement);
    } catch {
      // No stylesheet means an unstyled bar rather than no bar, which still beats no
      // controls at all.
    }
  }

  function icon(name) {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICONS[name] ?? '');
    svg.appendChild(path);
    return svg;
  }

  /** Attach a listener and remember how to detach it. */
  function on(target, type, listener, options) {
    try {
      target.addEventListener(type, listener, options);
      teardown.push(() => {
        try {
          target.removeEventListener(type, listener, options);
        } catch {
          // Nothing more we can do about a listener that will not detach.
        }
      });
    } catch {
      // A page that refuses a listener costs us one button, not the whole bar.
    }
  }

  /**
   * Build one button.
   *
   * The press is handled on `pointerdown` and the `click` that follows is swallowed.
   * Doing both would fire every command twice; doing only `click` would feel slow on a
   * tablet, where the browser holds the click back until it is sure the tap is not the
   * start of a scroll or a double-tap zoom.
   */
  function createButton(spec) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = `ftts-button ftts-${spec.name}`;
    button.setAttribute('data-ftts', spec.name);
    button.setAttribute('aria-label', spec.label);
    button.setAttribute('title', spec.label);
    if (spec.primary) button.setAttribute('data-primary', 'true');
    if (spec.compact) button.setAttribute('data-compact', 'true');

    if (spec.icon) button.appendChild(icon(spec.icon));
    if (spec.text) {
      const span = doc.createElement('span');
      span.className = 'ftts-speed-label';
      span.textContent = spec.text;
      button.appendChild(span);
    }

    const run = (event) => {
      // Keep the press from reaching the site underneath. Sites bind their own handlers
      // to the document and throw up overlays on a tap; a control bar that also sets
      // those off is worse than useless.
      event?.preventDefault?.();
      event?.stopPropagation?.();

      wake();
      button.setAttribute('data-pressed', 'true');

      // DIAGNOSIS. The instant the finger lands. Everything measured after this is
      // measured from here, because this is when the listener starts waiting.
      trace('BUTTON', { command: spec.command });

      try {
        commands[spec.command]?.();
      } catch {
        // A failed command must never take the bar down with it — the other buttons, and
        // stop in particular, have to keep working.
      }
    };

    const release = () => {
      try {
        button.removeAttribute('data-pressed');
      } catch {
        // Cosmetic only: at worst a button stays looking pressed.
      }
    };

    on(button, 'pointerdown', run);
    // A click still follows the pointerdown on a mouse; swallow it so nothing runs twice.
    on(button, 'click', (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
    });
    on(button, 'pointerup', release);
    on(button, 'pointerleave', release);
    on(button, 'pointercancel', release);

    // Keyboard, for anyone not using a finger: `pointerdown` never fires for space or
    // enter, so without this the bar would be unreachable from a keyboard.
    on(button, 'keydown', (event) => {
      if (event?.key !== 'Enter' && event?.key !== ' ') return;
      run(event);
    });
    on(button, 'keyup', release);

    elements.set(spec.name, button);
    return button;
  }

  /**
   * Build the status panel.
   *
   * A development display, and deliberately verbose: what the voice is doing, the sentence
   * it is doing it to, how long it took, and how many sentences are banked ahead. It sits
   * in its own row above the buttons so nothing it says can change the size or position of
   * a touch target — a status line that pushed the pause button around as it updated would
   * be worse than no status line at all.
   */
  function buildStatus() {
    const panel = doc.createElement('div');
    panel.className = 'ftts-status';
    panel.setAttribute('data-ftts', 'status');
    // Announced politely, so a screen reader mentions changes without interrupting the
    // article being read aloud — which is the whole point of the add-on.
    panel.setAttribute('role', 'status');
    panel.setAttribute('aria-live', 'polite');
    panel.hidden = true;

    const phase = doc.createElement('div');
    phase.className = 'ftts-phase';

    const dot = doc.createElement('span');
    dot.className = 'ftts-phase-dot';
    const fold = doc.createElement('button');
    fold.type = 'button';
    fold.className = 'ftts-fold';
    fold.setAttribute('data-ftts', 'fold');
    fold.appendChild(dot);
    const toggleFold = (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      wake();
      setFolded(!folded);
      onFoldChange?.(folded);
    };
    on(fold, 'pointerdown', toggleFold);
    on(fold, 'click', (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
    });
    on(fold, 'keydown', (event) => {
      if (event?.key === 'Enter' || event?.key === ' ') toggleFold(event);
    });
    const label = doc.createElement('span');
    label.className = 'ftts-phase-label';
    phase.append(fold, label);

    const text = doc.createElement('div');
    text.className = 'ftts-text';

    const track = doc.createElement('div');
    track.className = 'ftts-track';
    const fill = doc.createElement('span');
    fill.className = 'ftts-fill';
    track.appendChild(fill);

    panel.append(phase, text, track);
    return { panel, fold, label, text, track, fill };
  }

  function setFolded(next) {
    folded = Boolean(next);
    renderFold();
    renderActivity();
  }

  function renderFold() {
    if (!root || !status) return;
    try {
      root.setAttribute('data-folded', String(folded));
      const label = folded ? 'Show details' : 'Hide details';
      status.fold.setAttribute('aria-expanded', String(!folded));
      status.fold.setAttribute('aria-label', label);
      status.fold.setAttribute('title', label);
    } catch {
      // Cosmetic only.
    }
  }

  /**
   * Paint the status panel from the latest news plus the clock.
   *
   * Split from the news itself because the interesting part — how long a sentence has been
   * building, and how that compares to the estimate — changes with time rather than with
   * events. So this is called both when something happens and on a repeating tick.
   */
  function renderActivity() {
    if (!status) return;

    if (!activity && !position) {
      // Folded, the dot is the whole panel and stays; otherwise there is nothing to show.
      status.panel.hidden = !folded;
      try {
        root?.setAttribute('data-phase', '');
      } catch {
        // Cosmetic only.
      }
      return;
    }

    const { phase, text, estimateMs, tookMs, banked, error } = activity ?? {};
    status.panel.hidden = false;

    try {
      root?.setAttribute('data-phase', error ? 'error' : (phase ?? ''));
    } catch {
      // Cosmetic only.
    }

    const parts = [];
    if (error) parts.push('voice failed');
    else if (phase === 'loading') parts.push('loading voice…');
    else if (phase === 'generating') parts.push('building audio');
    else if (phase === 'waiting') parts.push('waiting for audio');
    else if (phase === 'speaking') parts.push('speaking');
    else if (phase === 'paused') parts.push('paused');
    else if (phase) parts.push('idle');
    // With no news from the voice at all — the plain browser voice never sends any — the
    // position below is the whole message, so nothing is claimed about the voice here.

    // Elapsed and estimated, so a wait has a shape rather than being an unbounded spinner.
    const elapsed = activity?.startedAt ? Math.max(0, timeNow() - activity.startedAt) : null;
    if (phase === 'generating' || phase === 'waiting') {
      if (elapsed !== null) parts.push(`${seconds(elapsed)}s`);
      if (estimateMs) parts.push(`of ~${seconds(estimateMs)}s`);
      else if (elapsed !== null) parts.push('(first sentence, no estimate yet)');
    } else if (typeof tookMs === 'number') {
      parts.push(`built in ${seconds(tookMs)}s`);
    }

    if (typeof banked === 'number') {
      parts.push(`· ${banked} ready`);
    }

    // How long the last pause took to reach the sound. Shown because it is the thing being
    // complained about, and a number settles it where an impression cannot.
    if (typeof activity?.pauseLatencyMs === 'number') {
      parts.push(`· pause ${activity.pauseLatencyMs}ms`);
    }

    if (position) {
      parts.push(`· ${position.index + 1}/${position.total}`);
    }

    status.label.textContent = parts.join(' ');

    // The voice's own text wins when it has one — it is the more specific news, and during
    // a build it is the sentence actually being waited for. Otherwise show where we are.
    const showing = text ?? position?.text ?? '';
    status.text.textContent = showing ? `“${showing}”` : '';

    // The bar fills toward the estimate. Capped just short of full while still building,
    // because showing 100% on something unfinished is a lie the listener can hear.
    let percent = 0;
    if (phase === 'speaking') percent = 100;
    else if (phase === 'loading') percent = 0;
    else if (elapsed !== null && estimateMs) percent = Math.min(96, (elapsed / estimateMs) * 100);
    else if (elapsed !== null) percent = Math.min(96, (elapsed / 4000) * 100);
    status.fill.style.width = `${Math.round(percent)}%`;
  }

  /** Repaint while a sentence is being built, so the elapsed time actually moves. */
  function scheduleTick() {
    if (tickTimer !== null) {
      clock.clearTimeout(tickTimer);
      tickTimer = null;
    }
    if (destroyed || !status || !activity) return;
    if (activity.phase !== 'generating' && activity.phase !== 'waiting') return;

    tickTimer = clock.setTimeout(() => {
      tickTimer = null;
      renderActivity();
      scheduleTick();
    }, 120);
  }

  function seconds(ms) {
    return (ms / 1000).toFixed(1);
  }

  /** The limits and step size the bar moves speed by, from settings with sane fallbacks. */
  function speedBounds() {
    return {
      step: typeof config.speedStep === 'number' ? config.speedStep : 0.05,
      min: typeof config.minRate === 'number' ? config.minRate : 0.5,
      max: typeof config.maxRate === 'number' ? config.maxRate : 3,
    };
  }

  /**
   * Take a new speed, wherever it came from — plus, minus, or the preset list.
   *
   * A speed that is not actually a change is dropped here rather than passed on. That is
   * not tidiness: a speed change now throws away the eight sentences banked ahead and
   * rebuilds them, so announcing one that changes nothing would cost the listener a real
   * gap in the audio for no reason. Pressing plus at the maximum is exactly this case.
   */
  function applySpeed(next) {
    if (typeof next !== 'number' || !Number.isFinite(next)) return;
    const from = rate;
    if (next === from) {
      // Still repaint: the button may be showing a pressed state, and the label should
      // settle back rather than looking stuck.
      renderSpeed();
      return;
    }
    rate = next;
    renderSpeed();
    // DIAGNOSIS. The speed the bar now believes in, and the one it came from.
    trace('rate:pressed', { from, to: rate });
    onSpeedChange?.(rate);
  }

  function renderSpeed() {
    const button = elements.get('speed');
    if (!button) return;

    const label = formatSpeed(rate);
    try {
      const span = button.querySelector?.('.ftts-speed-label');
      if (span) span.textContent = label;
      button.setAttribute('aria-label', `Speed ${label}, tap to choose a speed`);
      button.setAttribute('title', `Speed ${label}, tap to choose a speed`);
    } catch {
      // A stale label is cosmetic; the button still opens the list.
    }

    // Plus and minus are disabled at the ends rather than silently doing nothing. A
    // control that looks live and is not is the exact fault that cost two sessions on the
    // speed button, and the cure is to let the button say so.
    const { min, max } = speedBounds();
    setEnabled('speed-up', rate < max, `Faster (maximum ${formatSpeed(max)})`);
    setEnabled('speed-down', rate > min, `Slower (minimum ${formatSpeed(min)})`);

    if (speedMenu) renderSpeedMenu();
  }

  /** Mark one button as usable or not, in a way both a finger and a screen reader see. */
  function setEnabled(name, enabled, label) {
    const button = elements.get(name);
    if (!button) return;
    try {
      button.disabled = !enabled;
      button.setAttribute('aria-disabled', String(!enabled));
      if (label) {
        button.setAttribute('aria-label', label);
        button.setAttribute('title', label);
      }
    } catch {
      // Cosmetic: at worst a button at the end of its range still answers and does nothing.
    }
  }

  /**
   * The preset list, opened by tapping the speed number.
   *
   * Built on demand and thrown away on close rather than kept hidden. It is opened rarely,
   * it must not be reachable by a stray tab press while shut, and building it fresh means
   * it cannot drift out of step with the speed it is describing.
   */
  function toggleSpeedMenu() {
    if (speedMenu) {
      closeSpeedMenu();
      return;
    }
    openSpeedMenu();
  }

  function openSpeedMenu() {
    const anchor = elements.get('speed');
    if (!root || !anchor) return;

    const menu = doc.createElement('div');
    menu.className = 'ftts-menu';
    menu.setAttribute('data-ftts', 'speed-menu');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Choose a speed');

    const steps = Array.isArray(config.speedSteps) ? config.speedSteps : [];
    for (const step of steps) {
      const item = doc.createElement('button');
      item.type = 'button';
      item.className = 'ftts-menu-item';
      item.setAttribute('data-ftts', `speed-preset-${step}`);
      item.setAttribute('role', 'menuitemradio');
      item.textContent = formatSpeed(step);

      const choose = (event) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        wake();
        applySpeed(step);
        closeSpeedMenu();
      };
      on(item, 'pointerdown', choose);
      on(item, 'click', (event) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
      });
      on(item, 'keydown', (event) => {
        if (event?.key === 'Enter' || event?.key === ' ') choose(event);
      });

      menu.appendChild(item);
    }

    // Closed by a press anywhere else, which is what a small pop-up should do. Bound on
    // the document rather than the bar so a tap on the article closes it too.
    const dismiss = (event) => {
      if (menu.contains?.(event?.target)) return;
      if (anchor.contains?.(event?.target)) return;
      closeSpeedMenu();
    };
    const escape = (event) => {
      if (event?.key === 'Escape') closeSpeedMenu();
    };
    on(doc, 'pointerdown', dismiss, { capture: true });
    on(doc, 'keydown', escape);

    speedMenu = { menu, dismiss, escape };
    root.appendChild(menu);
    anchor.setAttribute('aria-expanded', 'true');
    renderSpeedMenu();
  }

  function closeSpeedMenu() {
    if (!speedMenu) return;
    const { menu, dismiss, escape } = speedMenu;
    speedMenu = null;
    try {
      doc.removeEventListener?.('pointerdown', dismiss, { capture: true });
      doc.removeEventListener?.('keydown', escape);
      menu.remove?.();
      elements.get('speed')?.setAttribute('aria-expanded', 'false');
    } catch {
      // The page may already have taken it; nothing left to do.
    }
  }

  /** Tick the preset that matches the current speed, so the list says where you are. */
  function renderSpeedMenu() {
    if (!speedMenu) return;
    for (const item of speedMenu.menu.querySelectorAll?.('.ftts-menu-item') ?? []) {
      const value = Number.parseFloat(item.textContent);
      const current = Math.abs(value - rate) < 1e-9;
      try {
        item.setAttribute('aria-checked', String(current));
        item.setAttribute('data-current', String(current));
      } catch {
        // Cosmetic only.
      }
    }
  }

  /**
   * Show whether we are playing or paused.
   *
   * One button that swaps between play and pause rather than two, so the centre of the
   * bar is always the button that matters. The label changes with the icon — an icon
   * alone would leave a screen reader announcing "play" while the article plays.
   */
  function renderState(state) {
    const button = elements.get('play');
    if (!button) return;

    const playing = state === 'playing';
    const label = playing ? 'Pause' : 'Play';

    try {
      root?.setAttribute('data-reader', state ?? 'idle');
      const path = button.querySelector?.('svg path');
      if (path) path.setAttribute('d', playing ? ICONS.pause : ICONS.play);
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
      button.setAttribute('data-state', playing ? 'playing' : 'paused');
    } catch {
      // A stale icon is a cosmetic fault; the button still works.
    }
  }

  /** Bring the bar back to full strength and restart the idle countdown. */
  function wake() {
    if (destroyed) return;

    if (idle) {
      idle = false;
      try {
        root?.setAttribute('data-idle', 'false');
      } catch {
        // Cosmetic only.
      }
    }

    if (idleTimer !== null) {
      clock.clearTimeout(idleTimer);
      idleTimer = null;
    }

    const after = config.controlsIdleMs ?? 0;
    if (after <= 0) return;

    // Only fade while actually playing. A paused bar that faded itself out would look
    // like the add-on had died, and pausing is exactly when someone is looking at it.
    if (reader.getState?.() !== 'playing') return;

    idleTimer = clock.setTimeout(() => {
      idleTimer = null;
      if (destroyed) return;
      if (reader.getState?.() !== 'playing') return;
      idle = true;
      try {
        root?.setAttribute('data-idle', 'true');
      } catch {
        // Cosmetic only.
      }
    }, after);
  }

  /**
   * The window's usable size.
   *
   * The smaller of the two measures on each side: `innerWidth` counts the scrollbar, which a
   * bar must not sit under, and `clientHeight` on a page with no doctype is the whole
   * document's height rather than the window's.
   */
  function viewport() {
    const win = doc.defaultView;
    const el = doc.documentElement;
    const pick = (a, b) => {
      const sizes = [a, b].filter((n) => typeof n === 'number' && n > 0);
      return sizes.length ? Math.min(...sizes) : 0;
    };
    return {
      width: pick(el?.clientWidth, win?.innerWidth),
      height: pick(el?.clientHeight, win?.innerHeight),
    };
  }

  function barSize() {
    const rect = root?.getBoundingClientRect?.();
    return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
  }

  /**
   * Put the bar at exact coordinates, instead of in a corner.
   *
   * The corner's properties are taken off first — a bar with both `left` and `right` set
   * would stretch — and set one at a time, for the same reason the corners are.
   */
  function placeAt({ left, top }) {
    try {
      for (const property of ['right', 'bottom', 'transform']) root.style.removeProperty(property);
      root.style.setProperty('left', `${Math.round(left)}px`);
      root.style.setProperty('top', `${Math.round(top)}px`);
      // The preset list opens toward the bigger half of the window, so it never opens off it.
      root.setAttribute('data-open', spot && spot.y < 0.5 ? 'down' : 'up');
    } catch {
      // A bar that will not move stays where it was, which still works.
    }
  }

  /**
   * Re-place a dragged bar: when it first appears, when the window changes size, and when
   * the bar itself does (the info line folding or unfolding). This is the "never outside the
   * window" rule — the spot is a fraction, so recomputing it always lands inside.
   */
  function applySpot() {
    if (!root || !spot || drag?.moving) return;
    placeAt(placeSpot({ spot, viewport: viewport(), size: barSize() }));
  }

  /**
   * A press on the bar's background or info panel picks the bar up. A press on a button is
   * the button's, as it always was — that is what keeps dragging from costing a single tap.
   */
  function startDrag(event) {
    if (destroyed || !root) return;
    if (typeof event?.button === 'number' && event.button !== 0) return;
    if (event?.target?.closest?.('button')) return;

    const rect = root.getBoundingClientRect?.() ?? { left: 0, top: 0 };
    drag = {
      pointer: event?.pointerId,
      startX: event?.clientX ?? 0,
      startY: event?.clientY ?? 0,
      left: rect.left,
      top: rect.top,
      moving: false,
    };
    try {
      // So the drag keeps following a pointer that outruns the bar, even off the window.
      root.setPointerCapture?.(event.pointerId);
    } catch {
      // Without capture a fast drag may drop the bar early; it still lands inside the window.
    }
  }

  function moveDrag(event) {
    if (!drag || event?.pointerId !== drag.pointer) return;
    const dx = (event?.clientX ?? drag.startX) - drag.startX;
    const dy = (event?.clientY ?? drag.startY) - drag.startY;

    if (!drag.moving) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      drag.moving = true;
      closeSpeedMenu();
      try {
        root.setAttribute('data-dragging', 'true');
      } catch {
        // Cosmetic only.
      }
    }

    event?.preventDefault?.();
    const view = viewport();
    const size = barSize();
    spot = spotAt({ left: drag.left + dx, top: drag.top + dy, viewport: view, size });
    placeAt(placeSpot({ spot, viewport: view, size }));
  }

  function endDrag(event) {
    if (!drag || event?.pointerId !== drag.pointer) return;
    const moved = drag.moving;
    drag = null;
    try {
      root?.removeAttribute('data-dragging');
      root?.releasePointerCapture?.(event.pointerId);
    } catch {
      // Cosmetic only.
    }
    // Reported only once the bar is let go, so a drag is one save rather than hundreds.
    if (moved) onMove?.({ ...spot });
  }

  /**
   * Follow the reader.
   *
   * The bar follows the reader itself rather than being told by content.js. That keeps the
   * existing reader-to-highlighter wiring from having to know a second listener exists.
   */
  function bindReader() {
    renderState(reader.getState?.());
    const unsubscribe = reader.on?.('state', ({ state }) => {
      // Sound is on its way, so "loading" has done its job. A voice that reports its own
      // activity replaces it in a moment; one that never does would otherwise be stuck on it.
      if (state === 'playing' && activity?.phase === 'loading') {
        activity = null;
        renderActivity();
      }
      renderState(state);
      // Coming out of playing must un-fade: the bar is about to be needed.
      wake();
    });
    if (typeof unsubscribe === 'function') teardown.push(unsubscribe);
  }

  return {
    /**
     * Hand the bar its reader once the article is ready. Until then the bar can already be
     * on screen, saying the voice is loading.
     */
    attachReader(next) {
      if (destroyed || !next) return;
      reader = next;
      if (root) bindReader();
    },

    /**
     * Put the bar on the page. Safe to call twice; the second call is ignored.
     *
     * @returns {boolean} whether the bar is on the page
     */
    show() {
      if (destroyed) return false;
      if (config.showControls === false) return false;
      if (root && root.parentNode) return true;

      try {
        ensureStyle();

        root = doc.createElement('div');
        root.className = ROOT_CLASS;
        // A toolbar, announced as one, so a screen reader offers the buttons as a group
        // rather than as seven loose controls in the middle of an article.
        root.setAttribute('role', 'toolbar');
        root.setAttribute('aria-label', 'Reading controls');
        root.setAttribute('data-idle', 'false');

        // The button size reaches the page as a custom property, never as stylesheet
        // text, for the same reason the highlight colour does.
        const size = config.controlsButtonSize;
        if (typeof size === 'number' && Number.isFinite(size)) {
          root.style.setProperty(SIZE_VAR, `${Math.floor(size)}px`);
        }

        // Position comes from a fixed table of known values rather than being built from
        // the stored string, so an unrecognised setting cannot put CSS on the page. Each
        // property is set on its own, so placing the bar cannot disturb the size set above.
        const placement = POSITIONS[config.controlsPosition] ?? POSITIONS['bottom-right'];
        for (const [property, value] of Object.entries(placement)) {
          root.style.setProperty(property, value);
        }

        // Which way the preset list opens. A bar at the top of the window must open its
        // list downward, or it would open off the edge of the screen and be unreachable.
        const atTop = String(config.controlsPosition ?? '').startsWith('top');
        root.setAttribute('data-open', atTop ? 'down' : 'up');

        // The status panel sits above the buttons. Built first so it appears above them,
        // and hidden until there is something to say.
        if (config.showStatus !== false) {
          status = buildStatus();
          root.appendChild(status.panel);
        }

        const row = doc.createElement('div');
        row.className = 'ftts-row';
        for (const spec of BUTTONS) row.appendChild(createButton(spec));
        root.appendChild(row);

        // A press anywhere on the bar is ours alone and must not reach the page.
        on(root, 'pointerdown', (event) => event?.stopPropagation?.());

        on(root, 'pointerdown', startDrag);
        on(root, 'pointermove', moveDrag);
        on(root, 'pointerup', endDrag);
        on(root, 'pointercancel', endDrag);

        (doc.body ?? doc.documentElement)?.appendChild(root);

        // Placed only now: the bar has to be on the page before it has a size to fit.
        applySpot();
        on(doc.defaultView, 'resize', applySpot, { passive: true });
        const Observer = doc.defaultView?.ResizeObserver;
        if (typeof Observer === 'function') {
          const observer = new Observer(() => applySpot());
          observer.observe(root);
          teardown.push(() => observer.disconnect());
        }

        renderSpeed();
        renderFold();
        renderActivity();
        bindReader();

        // Only the mouse being over the bar brings it back to full strength; moving the mouse
        // elsewhere on the page must not, or the fade would undo itself at every twitch.
        // A touch anywhere still wakes it, because a finger has no hover to go by.
        on(root, 'pointerenter', wake, { passive: true });
        on(root, 'pointermove', wake, { passive: true });
        on(doc, 'touchstart', wake, { passive: true });

        wake();
        return true;
      } catch {
        // A page that will not let us add a bar still gets read: the toolbar button works.
        return false;
      }
    },

    /**
     * Show what the voice is doing.
     *
     * Called with whatever the voice reports — building a sentence, waiting for one,
     * speaking. Purely a display: nothing here changes what is spoken, and a voice that
     * reports nothing simply leaves the panel hidden.
     */
    showActivity(next) {
      if (destroyed || !next) return;

      // A fresh piece of work starts the clock. Continuations of the same phase and text
      // keep the original start time, so the elapsed count does not restart under itself.
      const sameWork = activity && activity.phase === next.phase && activity.text === next.text;
      activity = {
        ...next,
        startedAt: sameWork ? activity.startedAt : timeNow(),
      };

      renderActivity();
      scheduleTick();
      // News arriving is not the listener touching the bar, so the fade is left alone
      // deliberately: a bar that never faded while an article played would defeat itself.
    },

    /**
     * Show where we are in the article.
     *
     * Separate from showActivity because it comes from a different place and means a
     * different thing: the reader knows the position, the voice knows what it is building.
     * Kept apart so the plain browser voice — which reports no activity whatever — still
     * shows a position, and so news about one never wipes the other off the panel.
     */
    showPosition(next) {
      if (destroyed || !next) return;
      position = next;
      renderActivity();
    },

    /** Reflect a speed set from somewhere else, without announcing it back out. */
    setRate(next) {
      if (typeof next !== 'number' || !Number.isFinite(next)) return;
      rate = next;
      renderSpeed();
    },

    getRate() {
      return rate;
    },

    /** Remove every trace of us from the page. Safe to call twice. */
    destroy() {
      destroyed = true;

      // Before the teardown list runs: it detaches the listeners, and this takes the
      // element and the handle with them. A menu left open would outlive the bar.
      closeSpeedMenu();

      if (idleTimer !== null) {
        clock.clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (tickTimer !== null) {
        clock.clearTimeout(tickTimer);
        tickTimer = null;
      }
      activity = null;
      position = null;
      status = null;

      for (const undo of teardown) {
        try {
          undo();
        } catch {
          // A listener that will not detach is not worth breaking over.
        }
      }
      teardown.length = 0;

      try {
        root?.remove();
      } catch {
        // Nothing more we can do about a page holding on to our own element.
      }
      root = null;

      try {
        styleElement?.remove();
      } catch {
        // A leftover <style> of ours affects only our own classes.
      }
      styleElement = null;
      elements.clear();
    },

    /** For tests and for anyone debugging a page. */
    isShowing() {
      return Boolean(root && root.parentNode);
    },

    isIdle() {
      return idle;
    },

    /** Where the bar was dragged to, or null if it is still in its corner. */
    getSpot() {
      return spot ? { ...spot } : null;
    },
  };
}

/** The real timers, taken from the page so tests can hand over their own. */
function defaultTimers(doc) {
  const win = doc?.defaultView;
  return {
    setTimeout: (fn, ms) => win?.setTimeout(fn, ms),
    clearTimeout: (id) => win?.clearTimeout(id),
  };
}

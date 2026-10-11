/**
 * Every user-adjustable setting lives here, in one place.
 *
 * Config is data, not code: nothing else in the add-on may hard-code a speed, a colour,
 * or a voice name. Later phases add a settings page that overwrites these values from
 * extension storage; until then these defaults are the whole configuration.
 */

export const DEFAULTS = {
  /** Speaking speed. 1 is the voice's own normal pace. */
  rate: 1.0,

  /** Voice pitch. 1 is neutral; moving it far from 1 sounds synthetic. */
  pitch: 1.0,

  /** Loudness, 0 to 1. */
  volume: 1.0,

  /**
   * Preferred voice name, or null to let the engine pick. A name that isn't installed
   * is ignored rather than treated as an error — voices differ from machine to machine.
   */
  voiceName: null,

  /**
   * Language to prefer when choosing a voice automatically. Falls back to the page's
   * own language when that is known.
   */
  lang: 'en-US',

  /**
   * Which voice to use. 'piper' is the natural-sounding one that runs on this machine;
   * 'web-speech' is the plainer voice built into Windows, which needs no download.
   */
  engine: 'piper',

  /**
   * Which Piper voice. Amy was judged good by ear; the others are untested. Each is about 60MB and downloads once, the first time it is used.
   */
  piperVoiceId: 'en_US-amy-medium',

  /**
   * Start speaking sooner by saying only the opening clause first, at the cost of a less
   * smooth start to the article.
   *
   * Off, by the owner's decision on 2026-09-10 after listening to both. Splitting saves
   * about four seconds at the very start, but the tail of that first sentence then
   * competes with sentence two for the one thing that builds audio, so the add-on never
   * gets a full sentence ahead and gaps can be heard later. Waiting longer once beats
   * pausing between sentences for the whole article.
   */
  splitFirstSentence: false,

  /**
   * Colour behind the sentence being spoken. Validated strictly before it reaches the
   * page, because this value ends up in someone else's stylesheet.
   */
  highlightColor: '#ffe57f',

  /**
   * The same, for sentences written in light text — a site in dark mode. White text on the
   * light yellow above cannot be read, so the highlighter picks whichever of the two colours
   * the sentence's own text reads better on. A deep amber: white text on it clears 8:1, and
   * it still shows as a band against a black page.
   */
  highlightColorDark: '#5c4a00',

  /**
   * Text colour inside the highlight, or null to leave the site's own colour alone.
   * Null is the right default: sites style their own text, and overriding it is how a
   * highlight ends up unreadable on a page nobody tested.
   */
  highlightTextColor: null,

  /** Follow the spoken sentence down the page when it goes out of view. */
  scrollToSentence: true,

  /** 'smooth' glides, 'auto' jumps. Reduced-motion settings override this to 'auto'. */
  scrollBehavior: 'smooth',

  /**
   * How much of the top and bottom of the window counts as too close to the edge, as a
   * fraction of its height. A sentence clinging to the bottom edge is technically
   * visible and practically not, so it counts as out of view and the page follows it.
   */
  scrollTopMargin: 0.15,
  scrollBottomMargin: 0.25,

  /**
   * After the reader scrolls by hand, leave the page alone for this long.
   *
   * The point is to stop the add-on fighting someone reading ahead. It expires on
   * purpose rather than lasting the whole article: a single nudge should not silently
   * turn following off for good, with no obvious way to get it back.
   */
  scrollRespectUserMs: 4000,

  /**
   * How long our own scroll may take before its scroll events would be mistaken for the
   * user's. A smooth scroll fires events for its whole animation; without this window
   * the first automatic scroll would look like the user grabbing the page and following
   * would switch itself off permanently.
   */
  scrollSettleMs: 1200,

  /** Show the floating control bar on the page while reading. */
  showControls: true,

  /**
   * Which corner the bar sits in: 'bottom-right', 'bottom-left', 'bottom-center',
   * 'top-right', 'top-left', 'top-center'.
   *
   * Bottom-right by default because that is where a hand already is on a tablet held in
   * two hands, and because the bottom of a page is the least likely place to cover
   * something the reader wants — article furniture lives at the top.
   */
  controlsPosition: 'bottom-right',

  /**
   * Where the listener dragged the bar to, or null for "wherever controlsPosition says".
   *
   * Stored as fractions of the room the bar has to move in — `{ x: 0..1, y: 0..1 }` — not
   * as pixels. 0 is the left or top edge, 1 the right or bottom. A bar dragged to the bottom
   * right therefore stays in the bottom right on a smaller window, a wider one, or a tablet
   * turned on its side, and it can never be stored somewhere off the screen.
   */
  controlsSpot: null,

  /**
   * How big the buttons are, in CSS pixels.
   *
   * 48 is not a taste decision. It is the smallest touch target both Apple and Google
   * publish as reliable (44 and 48 respectively), and a control you have to aim at is
   * worse than no control at all when you are holding a tablet one-handed. The same size
   * is used with a mouse: a big button has never annoyed anyone.
   */
  controlsButtonSize: 48,

  /**
   * Hide the bar after this many milliseconds of not being touched, and bring it back on
   * the next touch or mouse move. 0 keeps it visible always.
   *
   * It fades rather than vanishing so it never becomes a mystery, and it only fades while
   * actually playing — a paused bar that hid itself would look like a crash.
   *
   * Two seconds, down from six at the owner's request: six left a solid bar over the
   * article for most of the first sentence.
   */
  controlsIdleMs: 2000,

  /**
   * The speeds offered in the picker, opened by tapping the speed number itself.
   *
   * These are landmarks, not the whole range: plus and minus move in `speedStep` from
   * wherever you are, so any speed between the bounds below is reachable. The list exists
   * because getting from 1x to 1.5x by tapping plus ten times is a chore, and because
   * these are the speeds people actually settle on.
   */
  speedSteps: [0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0],

  /**
   * How much one press of plus or minus moves the speed.
   *
   * Fine on purpose. The owner asked for 0.05 because the difference between 1.35x and
   * 1.4x is genuinely audible over a long article, and the old list of six fixed speeds
   * could not express it.
   */
  speedStep: 0.05,

  /**
   * The slowest and fastest the voice may be asked to speak.
   *
   * Chosen by what stays worth listening to rather than by what the model tolerates —
   * `length_scale` has no hard ceiling, it simply keeps shortening. 3x is about where a
   * neural voice starts losing consonants rather than merely sounding quick, and 0.5x is
   * as slow as is useful before it sounds stretched.
   */
  minRate: 0.5,
  maxRate: 3.0,

  /**
   * Show what the voice is doing on the bar: which sentence is being built, how long it is
   * taking against an estimate, and how many sentences are banked ahead.
   *
   * On by the owner's request while the add-on is being built, and busier than a finished
   * product should be. It is the only window into a voice that spends a second or two
   * manufacturing every sentence — without it, "building audio" and "stuck" look identical.
   */
  showStatus: true,

  /** Whether the bar's info line is folded down to the status dot. Remembered between visits. */
  controlsFolded: false,

  /** Prefix for everything we add to a page, so we can never collide with the site. */
  namespace: 'ftts',
};

/** The voices we know work. Anything else is ignored rather than trusted blindly. */
export const ENGINES = ['piper', 'web-speech'];

/** How the page may move. Anything else is ignored rather than passed to the browser. */
export const SCROLL_BEHAVIORS = ['smooth', 'auto'];

/** Where the control bar may sit. Anything else is ignored rather than turned into CSS. */
export const CONTROLS_POSITIONS = [
  'bottom-right',
  'bottom-left',
  'bottom-center',
  'top-right',
  'top-left',
  'top-center',
];

/**
 * The Piper voices we offer, in the order they are shown.
 *
 * The id is what the voice library understands; everything else exists so a person can
 * choose between them without having to read `en_US-hfc_female-medium` and guess. The
 * descriptions are DATA rather than something the settings page invents, so adding a
 * voice later is one entry here and no change anywhere else.
 *
 * `quality` is the honest warning on a `high` voice: it is a larger model and
 * takes longer to build each sentence than the `medium` ones. That is a real trade the
 * listener is making, not a detail to hide — a voice that sounds better but pauses
 * between sentences may well be the worse choice on a long article.
 *
 * Amy was judged good by ear in Phase 2. The rest are offered untested, which is the
 * entire point of letting someone choose.
 *
 * ONLY VOICES WE MAY OFFER THE PUBLIC belong here — each voice's own licence decides, not
 * the "MIT" label on the Hugging Face collection. Lessac (both sizes) was removed on
 * 2026-09-30 because its recordings are licensed for research only. See the licence
 * section in PROGRESS.md before adding a voice.
 */
export const PIPER_VOICE_LIST = [
  { id: 'en_US-amy-medium', name: 'Amy', description: 'US female', quality: 'medium' },
  {
    id: 'en_US-hfc_female-medium',
    name: 'HFC Female',
    description: 'US female',
    quality: 'medium',
  },
  { id: 'en_US-hfc_male-medium', name: 'HFC Male', description: 'US male', quality: 'medium' },
  { id: 'en_US-ryan-medium', name: 'Ryan', description: 'US male', quality: 'medium' },
  { id: 'en_US-joe-medium', name: 'Joe', description: 'US male', quality: 'medium' },
  { id: 'en_US-ryan-high', name: 'Ryan', description: 'US male', quality: 'high' },
];

/**
 * Just the ids, derived rather than written twice.
 *
 * Kept as its own export because validation only ever asks "is this one of ours", and
 * because a second hand-maintained list would eventually disagree with the first.
 */
export const PIPER_VOICES = PIPER_VOICE_LIST.map((voice) => voice.id);

/** Roughly how big a voice is to download, for warning someone before they wait. */
export const PIPER_VOICE_SIZE_MB = { medium: 60, high: 110 };

/** What one voice id means, or null if we do not offer it. */
export function describeVoice(id) {
  return PIPER_VOICE_LIST.find((voice) => voice.id === id) ?? null;
}

/**
 * Merge stored settings over the defaults, ignoring anything unrecognised or malformed.
 * Stored values come from disk and may be stale or hand-edited, so they are not trusted.
 *
 * @param {object} [stored]
 * @returns {typeof DEFAULTS}
 */
export function resolveConfig(stored) {
  const config = { ...DEFAULTS };
  if (!stored || typeof stored !== 'object') return config;

  if (isFiniteInRange(stored.pitch, 0, 2)) config.pitch = stored.pitch;
  if (isFiniteInRange(stored.volume, 0, 1)) config.volume = stored.volume;
  if (typeof stored.voiceName === 'string' && stored.voiceName !== '') {
    config.voiceName = stored.voiceName;
  }
  if (typeof stored.lang === 'string' && stored.lang !== '') config.lang = stored.lang;
  if (ENGINES.includes(stored.engine)) config.engine = stored.engine;
  if (PIPER_VOICES.includes(stored.piperVoiceId)) config.piperVoiceId = stored.piperVoiceId;
  if (typeof stored.splitFirstSentence === 'boolean') {
    config.splitFirstSentence = stored.splitFirstSentence;
  }
  if (isColor(stored.highlightColor)) config.highlightColor = stored.highlightColor;
  if (isColor(stored.highlightColorDark)) config.highlightColorDark = stored.highlightColorDark;
  if (stored.highlightTextColor === null || isColor(stored.highlightTextColor)) {
    config.highlightTextColor = stored.highlightTextColor;
  }
  if (typeof stored.scrollToSentence === 'boolean') {
    config.scrollToSentence = stored.scrollToSentence;
  }
  if (SCROLL_BEHAVIORS.includes(stored.scrollBehavior)) {
    config.scrollBehavior = stored.scrollBehavior;
  }
  if (isFiniteInRange(stored.scrollTopMargin, 0, 0.5)) {
    config.scrollTopMargin = stored.scrollTopMargin;
  }
  if (isFiniteInRange(stored.scrollBottomMargin, 0, 0.5)) {
    config.scrollBottomMargin = stored.scrollBottomMargin;
  }
  if (isFiniteInRange(stored.scrollRespectUserMs, 0, 60000)) {
    config.scrollRespectUserMs = stored.scrollRespectUserMs;
  }
  if (isFiniteInRange(stored.scrollSettleMs, 0, 10000)) {
    config.scrollSettleMs = stored.scrollSettleMs;
  }
  if (typeof stored.showControls === 'boolean') config.showControls = stored.showControls;
  if (CONTROLS_POSITIONS.includes(stored.controlsPosition)) {
    config.controlsPosition = stored.controlsPosition;
  }
  // Floored to a whole number of pixels and never allowed below the 44px that makes a
  // target reliably touchable — a stored setting must not be able to make the bar unusable.
  if (isFiniteInRange(stored.controlsButtonSize, 44, 96)) {
    config.controlsButtonSize = Math.floor(stored.controlsButtonSize);
  }
  if (isFiniteInRange(stored.controlsIdleMs, 0, 120000)) {
    config.controlsIdleMs = stored.controlsIdleMs;
  }
  if (typeof stored.showStatus === 'boolean') config.showStatus = stored.showStatus;
  if (typeof stored.controlsFolded === 'boolean') config.controlsFolded = stored.controlsFolded;
  if (
    isFiniteInRange(stored.controlsSpot?.x, 0, 1) &&
    isFiniteInRange(stored.controlsSpot?.y, 0, 1)
  ) {
    config.controlsSpot = { x: stored.controlsSpot.x, y: stored.controlsSpot.y };
  }
  if (isSpeedSteps(stored.speedSteps)) config.speedSteps = [...stored.speedSteps];
  if (isFiniteInRange(stored.speedStep, 0.01, 1)) config.speedStep = stored.speedStep;
  if (isFiniteInRange(stored.minRate, 0.1, 1)) config.minRate = stored.minRate;
  if (isFiniteInRange(stored.maxRate, 1, 10)) config.maxRate = stored.maxRate;

  /*
   * The speed, clamped to the range the bar can actually reach.
   *
   * DELIBERATELY AFTER THE BOUNDS ABOVE, because it depends on them: reading it earlier
   * would clamp a stored 3.5x against the DEFAULT maximum even when the settings raise
   * that maximum to 4, which is a bug that only appears for someone who changed both.
   *
   * Clamped rather than merely validated, because plus and minus stop at the bounds: a
   * stored speed above the maximum would sit there with the plus button disabled, which
   * looks like the fault that cost two sessions rather than a setting out of range.
   */
  if (isFiniteInRange(stored.rate, 0.1, 10)) {
    config.rate = Math.min(config.maxRate, Math.max(config.minRate, stored.rate));
  }

  return config;
}

/**
 * A colour we are willing to put into a page we do not own.
 *
 * Deliberately narrow rather than clever. Stored settings come off disk and may have been
 * hand-edited, and this value reaches someone else's stylesheet — so anything that is not
 * plainly a colour is refused, and the default is used instead. Semicolons, braces and
 * url() cannot survive this, which is the point.
 */
const COLOR_PATTERN = /^#[0-9a-f]{3,8}$|^rgba?\([\d.,%\s]+\)$|^[a-z]+$/i;

function isColor(value) {
  return typeof value === 'string' && value.length <= 32 && COLOR_PATTERN.test(value);
}

/**
 * A usable list of speeds: a few of them, each one a speed a voice can actually manage.
 * An empty list would leave the speed button with nothing to do, so it is refused.
 */
function isSpeedSteps(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 12 &&
    value.every((step) => isFiniteInRange(step, 0.5, 3))
  );
}

function isFiniteInRange(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

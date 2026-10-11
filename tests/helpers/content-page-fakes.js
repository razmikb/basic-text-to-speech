/**
 * Stand-ins for every lib/ module content.js loads, for tests/helpers/content-page.js.
 *
 * One file answers all of them, because content.js only picks names out of what it
 * imports. Everything built is recorded in `made`, so a test can see what is on the page:
 * how many bars, whether they were taken down, what state each reader is in.
 */
export const made = {
  readers: [],
  bars: [],
  highlighters: [],
  engines: 0,
  selections: [],
  points: [],
};

export function resetFakes() {
  made.readers.length = 0;
  made.bars.length = 0;
  made.highlighters.length = 0;
  made.engines = 0;
  made.selections.length = 0;
  made.points.length = 0;
}

// lib/trace.js
export const trace = () => {};
export const formatTrace = () => '';
export const clearTrace = () => {};
export const startHeartbeat = () => {};

// lib/config.js
export const resolveConfig = () => ({ engine: 'web-speech', rate: 1 });

// lib/extractor.js
export const extractArticle = () => ({ title: 'An article', blocks: [{}] });

// lib/engines/web-speech.js and lib/engines/piper.js
export const whenVoicesReady = async () => {};
export const createWebSpeechEngine = () => {
  made.engines += 1;
  return {};
};
export const createPiperEngine = () => ({});

// lib/selection.js — records what it was asked, and finds one sentence.
export function readSelection(doc, selection, fallbackText) {
  made.selections.push(fallbackText);
  return { blocks: [{}], sentences: [{ text: 'Selected.' }] };
}

// "Read from here" lands on the second sentence of whatever it is given.
export function sentenceAt(options) {
  made.points.push(options);
  return 1;
}

// lib/reader.js
export const buildSentences = () => [{ text: 'One.' }, { text: 'Two.' }];
export function createReader({ sentences } = {}) {
  const handlers = {};
  const reader = {
    sentences,
    state: 'idle',
    voices: 0,
    on: (name, fn) => {
      handlers[name] = fn;
    },
    getState: () => reader.state,
    setState(state) {
      reader.state = state;
      handlers.state?.({ state });
    },
    play() {
      if (reader.state !== 'playing') reader.voices += 1;
      reader.setState('playing');
    },
    pause() {
      reader.voices = 0;
      reader.setState('paused');
    },
    stop() {
      reader.voices = 0;
      reader.setState('idle');
    },
    from: null,
    playFrom(index) {
      reader.from = index;
      reader.voices = 1;
      reader.setState('playing');
    },
    getSentences: () => sentences,
    releaseVoice: () => false,
    sharesVoice: () => false,
  };
  made.readers.push(reader);
  return reader;
}

// lib/highlighter.js
export function createHighlighter() {
  const highlighter = { destroyed: false, show() {}, clear() {} };
  highlighter.destroy = () => {
    highlighter.destroyed = true;
  };
  made.highlighters.push(highlighter);
  return highlighter;
}

// lib/controls.js
export function createControls() {
  const bar = { shown: false, destroyed: false };
  Object.assign(bar, {
    show: () => {
      bar.shown = true;
    },
    destroy: () => {
      bar.destroyed = true;
    },
    attachReader() {},
    showActivity() {},
    showPosition() {},
  });
  made.bars.push(bar);
  return bar;
}

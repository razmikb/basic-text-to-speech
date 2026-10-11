/**
 * Sentence splitting.
 *
 * The reader speaks and highlights one sentence at a time, so this decides the unit
 * the whole add-on works in. Splitting naively on every period breaks on abbreviations
 * ("Dr. Smith"), decimals ("3.5 percent"), and initials ("J. R. R. Tolkien") — each of
 * which would cut a sentence in half mid-speech.
 */

/** Abbreviations that end in a period but almost never end a sentence. */
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'mt',
  'vs',
  'etc',
  'eg',
  'ie',
  'approx',
  'dept',
  'est',
  'fig',
  'inc',
  'ltd',
  'co',
  'corp',
  'no',
  'vol',
  'p',
  'pp',
  'jan',
  'feb',
  'mar',
  'apr',
  'jun',
  'jul',
  'aug',
  'sep',
  'sept',
  'oct',
  'nov',
  'dec',
]);

/**
 * True if the period ending `text` looks like part of a word rather than a sentence end.
 */
function isFalseEnding(text) {
  // A single capital letter before the period is an initial: "J. R. R. Tolkien".
  const initial = /(?:^|\s)[A-Z]\.$/.test(text);
  if (initial) return true;

  // A digit immediately before the period is a decimal or numbered item: "3.5", "1."
  if (/\d\.$/.test(text)) return true;

  const lastWord = text
    .slice(0, -1)
    .split(/[\s(["']+/)
    .pop()
    .toLowerCase();

  return ABBREVIATIONS.has(lastWord);
}

/**
 * Split a block of text into sentences.
 *
 * Returns objects carrying the sentence text plus its start and end offsets in the
 * original string. The offsets are what later lets the highlighter find the exact
 * place on the page to mark — so they must stay accurate.
 *
 * @param {string} text
 * @returns {Array<{text: string, start: number, end: number}>}
 */
export function splitSentences(text) {
  if (typeof text !== 'string' || text.trim() === '') return [];

  const sentences = [];
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char !== '.' && char !== '!' && char !== '?') continue;

    // Absorb runs of terminators and any closing quote or bracket: `?!"` , `."`
    let end = i;
    while (end + 1 < text.length && /[.!?]/.test(text[end + 1])) end++;
    while (end + 1 < text.length && /["'”’)\]]/.test(text[end + 1])) end++;

    const candidate = text.slice(start, end + 1);

    // A real ending is followed by whitespace and then a new sentence — or by nothing.
    const rest = text.slice(end + 1);
    const atEnd = rest.trim() === '';
    const followedByBreak = /^\s/.test(rest);

    if (!atEnd && !followedByBreak) {
      i = end;
      continue;
    }

    if (char === '.' && isFalseEnding(candidate.trimEnd())) {
      i = end;
      continue;
    }

    const trimmed = candidate.trim();
    if (trimmed !== '') {
      const leading = candidate.length - candidate.trimStart().length;
      sentences.push({
        text: trimmed,
        start: start + leading,
        end: start + leading + trimmed.length,
      });
    }

    start = end + 1;
    i = end;
  }

  // Trailing text with no terminator is still a sentence — many headings have none.
  const tail = text.slice(start);
  if (tail.trim() !== '') {
    const leading = tail.length - tail.trimStart().length;
    const trimmed = tail.trim();
    sentences.push({
      text: trimmed,
      start: start + leading,
      end: start + leading + trimmed.length,
    });
  }

  return sentences;
}

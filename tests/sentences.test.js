import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences } from '../src/lib/sentences.js';

const textsOf = (input) => splitSentences(input).map((s) => s.text);

test('splits plain sentences', () => {
  assert.deepEqual(textsOf('The cat sat. The dog barked.'), ['The cat sat.', 'The dog barked.']);
});

test('handles question and exclamation marks', () => {
  assert.deepEqual(textsOf('Is it late? Yes! We should go.'), [
    'Is it late?',
    'Yes!',
    'We should go.',
  ]);
});

test('does not split on titles like Dr. and Mr.', () => {
  assert.deepEqual(textsOf('Dr. Smith arrived late. He apologised.'), [
    'Dr. Smith arrived late.',
    'He apologised.',
  ]);
});

test('does not split on decimals', () => {
  assert.deepEqual(textsOf('Inflation hit 3.5 percent. Nobody was surprised.'), [
    'Inflation hit 3.5 percent.',
    'Nobody was surprised.',
  ]);
});

test('does not split on initials', () => {
  assert.deepEqual(textsOf('It was written by J. R. R. Tolkien. It sold well.'), [
    'It was written by J. R. R. Tolkien.',
    'It sold well.',
  ]);
});

test('does not split on etc. mid-sentence', () => {
  assert.deepEqual(textsOf('We packed food, maps, etc. before leaving.'), [
    'We packed food, maps, etc. before leaving.',
  ]);
});

test('keeps a closing quote with its sentence', () => {
  assert.deepEqual(textsOf('"Stop right there." She turned around.'), [
    '"Stop right there."',
    'She turned around.',
  ]);
});

test('treats a run of terminators as one ending', () => {
  assert.deepEqual(textsOf('What?! I had no idea.'), ['What?!', 'I had no idea.']);
});

test('keeps trailing text that has no terminator', () => {
  assert.deepEqual(textsOf('A Complete History. Chapter one'), [
    'A Complete History.',
    'Chapter one',
  ]);
});

test('offsets point at the sentence in the original text', () => {
  const input = 'First one. Second one.';
  for (const sentence of splitSentences(input)) {
    assert.equal(
      input.slice(sentence.start, sentence.end),
      sentence.text,
      'offsets must locate the sentence exactly — the highlighter depends on this'
    );
  }
});

test('returns nothing for empty or blank input', () => {
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences('   \n  '), []);
  assert.deepEqual(splitSentences(null), []);
});

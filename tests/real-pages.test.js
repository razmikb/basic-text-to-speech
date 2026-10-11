import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { parseHTML } from 'linkedom';
import { extractArticle } from '../src/lib/extractor.js';
import { buildSentences } from '../src/lib/reader.js';
import { needsPages, loadPage } from './helpers/pages.js';

/**
 * Tests against real pages that actually broke.
 *
 * The hand-made pages in extractor.test.js prove the rules work. They cannot prove the
 * rules survive the web, because the ways real sites break us are ones we did not think
 * of — which is the whole point. These fixtures are the genuine HTML of articles the owner
 * actually tried, with scripts and styles stripped out to keep them small.
 *
 * Two of them failed badly on the first run: the word "post" in the junk list threw away
 * Substack's entire article (class="typography newsletter-post post"), leaving only the
 * "Discussion about this post" footer to read aloud.
 *
 * The fourth, `second-breakfast`, is the first site of the Phase 5 survey. It hid its title
 * inside a <header> and lost a one-line paragraph to the minimum-length rule — two faults
 * that none of the hand-made pages, and none of the other three real ones, would have found.
 */

const read = (name) => {
  const article = extractArticle(loadPage(name));
  return { ...article, sentences: buildSentences(article.blocks) };
};

test('Substack: reads the article, not the comments widget', needsPages, () => {
  const { title, sentences } = read('substack-cognitive-resonance');

  assert.equal(title, 'The 50 Percent Problem');
  assert.ok(
    sentences.length > 100,
    `expected a full article, got ${sentences.length} sentences — the article was thrown away`
  );
  assert.match(sentences[0].text, /50 Percent Problem/);
});

test('Substack: the article body actually made it in', needsPages, () => {
  const { sentences } = read('substack-cognitive-resonance');
  const body = sentences.map((s) => s.text).join(' ');

  assert.match(body, /Laurence Holt/, 'the opening paragraph must be there');
  assert.match(body, /ed-tech/, 'the body of the argument must be there');
});

test('Substack: stops before the footer widgets', needsPages, () => {
  const { sentences } = read('substack-cognitive-resonance');
  const last = sentences.at(-1).text;

  assert.doesNotMatch(last, /Discussion about this post/);
  assert.doesNotMatch(last, /Ready for more/);
});

test('Substack: titles the post, not the publication author', needsPages, () => {
  // The page's first h1 is the masthead ("Daniel Willingham"), which is not the title.
  const { title, sentences } = read('substack-dtw');

  assert.match(title, /Students should only use AI/);
  assert.ok(sentences.length > 50, `expected a full article, got ${sentences.length}`);
});

test('Chalkbeat: reads the article it was asked to read', needsPages, () => {
  const { title, sentences } = read('chalkbeat');

  assert.match(title, /The problem with an AI tutor/);
  assert.ok(sentences.length > 40, `expected a full article, got ${sentences.length}`);
});

test('Second Breakfast: speaks the title, which its header was hiding', needsPages, () => {
  // Ghost wraps the title in <header class="gh-article-header">, and HEADER is excluded
  // furniture — so this page was read starting from its first paragraph, title unspoken.
  const { title, sentences } = read('second-breakfast');

  assert.equal(title, 'Click Here to Comply');
  assert.equal(sentences[0].text, 'Click Here to Comply', 'the title must be the first thing read');
});

test('Second Breakfast: the byline beside the title stays out', needsPages, () => {
  // The same header holds an <h4> byline. Letting the title out must not let that out too.
  const { sentences } = read('second-breakfast');

  assert.ok(
    !sentences.some((s) => s.text === 'Audrey Watters'),
    'the byline is furniture and must not be spoken'
  );
});

test('Second Breakfast: reads the short paragraph it used to skip', needsPages, () => {
  // Twenty characters of real prose, dropped by a 40-character minimum.
  const { sentences } = read('second-breakfast');
  const texts = sentences.map((s) => s.text);

  assert.ok(texts.includes('Perhaps you haven’t.'), 'a short sentence is still a sentence');
  // It is a rhetorical beat between two paragraphs, so it must land in the right place.
  const index = texts.indexOf('Perhaps you haven’t.');
  assert.match(texts[index - 1], /Ben Riley/);
});

test('no page reads its navigation or cookie banner', needsPages, () => {
  for (const name of [
    'substack-cognitive-resonance',
    'substack-dtw',
    'chalkbeat',
    'second-breakfast',
    'edutopia',
    'retrieval-practice',
    'beehiiv-were-here',
  ]) {
    const opening = read(name)
      .sentences.slice(0, 3)
      .map((s) => s.text)
      .join(' ');

    assert.doesNotMatch(opening, /Sign in|Subscribe now|Accept all cookies/i, `${name} opening`);
  }
});

test('every extracted sentence has real text in it', needsPages, () => {
  for (const name of [
    'substack-cognitive-resonance',
    'substack-dtw',
    'chalkbeat',
    'second-breakfast',
    'edutopia',
    'retrieval-practice',
    'beehiiv-were-here',
  ]) {
    for (const sentence of read(name).sentences) {
      assert.ok(sentence.text.trim().length > 0, `${name} produced an empty sentence`);
      assert.equal(typeof sentence.blockIndex, 'number');
    }
  }
});

test('Edutopia: reads the subtitle under the title', needsPages, () => {
  // The standfirst is a plain <p> inside <header data-testid="article-header">, so the
  // <header> exclusion ate it — the same fault as Second Breakfast's title, one step out.
  const { title, sentences } = read('edutopia');
  const texts = sentences.map((s) => s.text);

  assert.match(title, /Will These 6 Sneaky Charts/);
  assert.ok(
    texts.some((t) => t.includes('media landscape overrun')),
    'the subtitle is prose and must be read'
  );
  // It introduces the article, so it has to be read second — after the title, before the body.
  assert.match(texts[1], /media landscape overrun/);
});

test('Edutopia: the article header does not bring its furniture with it', needsPages, () => {
  // Letting the whole header through would read the byline, the date and a save-confirmation
  // toast that is invisible until you click the button.
  const body = read('edutopia')
    .sentences.map((s) => s.text)
    .join(' ');

  assert.doesNotMatch(body, /Your content has been saved/i, 'the toast is not prose');
  assert.doesNotMatch(body, /Go to My Saved Content/i);
  assert.doesNotMatch(body, /^By Paige Tutt/i);
});

test('Second Breakfast: still does not read the byline beside its title', needsPages, () => {
  // Ghost writes the author as <h4 class="gh-article-author-name"> in the article header —
  // no junk word catches it, so only "subtitles are paragraphs, bylines are headings" does.
  const body = read('second-breakfast')
    .sentences.map((s) => s.text)
    .join(' ');

  assert.doesNotMatch(body, /Audrey Watters/, 'the byline is furniture, not the article');
});

test('Retrieval Practice: does not read the signup pitch above the title', needsPages, () => {
  // A Squarespace page-header block renders above the post and was read aloud first, before
  // the article had even been announced.
  const { sentences } = read('retrieval-practice');
  const texts = sentences.map((s) => s.text);

  // The title splits into sentences of its own, so the opening is checked as a whole.
  assert.match(texts.slice(0, 3).join(' '), /I’m tired of thinking about it/);
  assert.ok(
    !texts.some((t) => t.includes('Subscribe for my newsletter')),
    'the signup pitch is furniture, not the article'
  );
});

test('Retrieval Practice: an article about newsletters keeps its own words', needsPages, () => {
  // The counter-example that rules out fixing the above with a `newsletter`/`subscribe` junk
  // word: this article discusses its own newsletter, so those sentences are the article.
  const body = read('retrieval-practice')
    .sentences.map((s) => s.text)
    .join(' ');

  assert.match(body, /but not my newsletter/i, 'the word appears in the prose and must survive');
  assert.match(body, /this week’s newsletter may or may not be for you/);
});

test('beehiiv: stops at the end of the newsletter, not the related posts', needsPages, () => {
  // The post ran on into a "Keep Reading" list of other articles.
  const { sentences } = read('beehiiv-were-here');
  const texts = sentences.map((s) => s.text);

  assert.ok(!texts.some((t) => /^Keep Reading$/i.test(t)), 'related posts are not the article');
  // The sign-off boilerplate is the last thing in the post body, and it runs to several
  // sentences, so the tail is checked as a whole rather than by its final sentence.
  //
  // This asserts the sign-off is still *reached*, not that reading it is desirable — it is
  // one of the two faults SURVEY.md leaves open on this site on purpose. It earns its place
  // as the boundary marker: it is the last real block, so anything trimmed past it means a
  // cut has gone too far. The empty-heading rule failed exactly here when it was written.
  assert.match(texts.slice(-4).join(' '), /Nerdfighteria/);
});

test('beehiiv: does not read the image credit', needsPages, () => {
  // <small class="dream-post-content-figcaption"> — the junk list's `caption` does not match
  // a class that glues the word to a prefix, so the tag is what catches it.
  const body = read('beehiiv-were-here')
    .sentences.map((s) => s.text)
    .join(' ');

  assert.doesNotMatch(body, /created by Allison Conway/, 'an image credit is not prose');
});

test('ScholarSpace: reads the abstract', needsPages, () => {
  // A DSpace repository record. The abstract is the only prose on the page, and it sits in a
  // bare <span> rather than a <p>, so the block selector walked straight past it and the
  // reading contained no article text at all.
  const body = read('scholarspace')
    .sentences.map((s) => s.text)
    .join(' ');

  assert.match(body, /Mind-wandering, characterized by a shift of attention/);
  assert.match(body, /working memory capacity does not/, 'the whole abstract, not just its start');
});

test('ScholarSpace: does not read the labels of empty fields', needsPages, () => {
  // The record lists 52 metadata headings and fills 17 of them. The other 35 — "Performer",
  // "Interviewee", "Transcriber" — label nothing, and headings are exempt from the
  // minimum-length rule, so every one of them was read aloud.
  const texts = read('scholarspace').sentences.map((s) => s.text);

  for (const label of ['Performer', 'Interviewee', 'Transcriber', 'Narrator', 'Time Period']) {
    assert.ok(!texts.some((t) => t.trim() === label), `"${label}" labels nothing and is not prose`);
  }
});

test('ScholarSpace: a heading that does label something still survives', needsPages, () => {
  // The counter-example that keeps the empty-heading rule from eating real section headings:
  // "Abstract" introduces the abstract and is part of the reading.
  const texts = read('scholarspace').sentences.map((s) => s.text.trim());

  assert.ok(texts.includes('Abstract'), 'a heading with content under it is still read');
});

test('ScholarSpace: does not read the loading spinner', needsPages, () => {
  // The page renders a spinner as role="status" around a visually-hidden "Loading...",
  // which is a status announcement about the page, not a part of the article.
  const texts = read('scholarspace').sentences.map((s) => s.text.trim());

  assert.ok(!texts.some((t) => /^Loading\.\.\.$/.test(t)), 'a spinner label is not prose');
});

test('Stanford Report: reads the article, not a related-story card', needsPages, () => {
  // Stanford names its page wrappers after their neighbour: <main class="…su-page-has-sidebar">
  // and <div class="su-sidebar-content-wrap">. The word "sidebar" marked both as furniture,
  // so the whole article was thrown away and the only thing left to read was the headline of
  // one related-story card: "Bacteria-killing polymers could be a new class of antibiotics".
  const body = read('stanford-report')
    .sentences.map((s) => s.text)
    .join(' ');

  assert.match(body, /From precision medicine to personalized job training/);
  assert.match(body, /Heterogeneous treatment effect estimation is now a very common part/);
  assert.doesNotMatch(body, /Bacteria-killing polymers/, 'a related-story card is not the article');
});

test('Stanford Report: the real sidebar is still left out', needsPages, () => {
  // The counter-example that keeps the wrapper rule honest: the <aside class="su-page-sidebar">
  // inside those wrappers really is a sidebar, and its newsletter pitch must stay unread.
  const body = read('stanford-report')
    .sentences.map((s) => s.text)
    .join(' ');

  assert.doesNotMatch(body, /Subscribe to Stanford Report/);
  assert.doesNotMatch(body, /Groundbreaking innovations that begin in Stanford labs/);
});

test('Stanford Report: opens on the headline, not the sticky site header', needsPages, () => {
  // The site header repeats the headline in an <h1> ahead of the real one. Taking that copy
  // as the title let the rest of the site header in, and the reading opened on a
  // "Stories for you" teaser and a newsletter-preferences blurb.
  const texts = read('stanford-report').sentences.map((s) => s.text);

  assert.match(texts[0], /Statistical test helps judge the value of personalization/);
  assert.match(texts[1], /Stanford researchers have developed an effective statistical measure/);
  const body = texts.join(' ');
  assert.doesNotMatch(body, /How self-driving cars became reality/);
  assert.doesNotMatch(body, /We want to provide stories, announcements/);
});

test('Stanford Report: does not end on the share button', needsPages, () => {
  const texts = read('stanford-report').sentences.map((s) => s.text.trim());

  assert.notEqual(texts.at(-1), 'Share this story');
});

test('boxes named after furniture, nested deep, do not freeze the page', needsPages, () => {
  // The wrapper rule asks of a furniture-named box whether it holds real furniture, and
  // asked it again of every box inside, and again inside those. Ad slots nest: eight deep
  // took minutes, and Firefox told the owner the add-on was slowing it down on Nature.
  const prose = 'This paragraph has to be long enough that the extractor treats it as prose. ';
  let inner = `<p>${prose}</p>`;
  for (let i = 0; i < 12; i += 1) {
    inner = `<div class="ad-wrap-${i}"><div class="ad">Advertisement</div>${inner}<p>${prose}</p></div>`;
  }
  const doc = parseHTML(`<html><body><article>${inner}</article></body></html>`).document;

  const started = performance.now();
  const { blocks } = extractArticle(doc);
  const elapsed = performance.now() - started;

  assert.ok(elapsed < 1000, `took ${Math.round(elapsed)}ms`);
  assert.ok(
    blocks.some((block) => block.text.includes('long enough')),
    'the prose still comes through'
  );
  assert.ok(!blocks.some((block) => block.text === 'Advertisement'), 'the ad labels still do not');
});

test('Nature: reads the subtitle under the headline', needsPages, () => {
  // Nature writes its standfirst as <div class="c-article-teaser-text"> inside the article's
  // <header>. Only the title and <p> were let out of that header, so it was skipped.
  const texts = read('nature').sentences.map((s) => s.text);

  assert.match(texts[0], /How to stay smart in the age of AI/);
  assert.match(texts[1], /There is growing concern that AI can blunt memory and reasoning\./);
});

test('Nature: the header still keeps its labels to itself', needsPages, () => {
  // The counter-example: the same header holds "NEWS FEATURE" and the date. Neither is
  // written as a sentence, and neither belongs in the reading.
  const texts = read('nature').sentences.map((s) => s.text.trim());

  assert.ok(!texts.includes('NEWS FEATURE'));
  assert.ok(!texts.some((t) => /^23 September 2026$/.test(t)));
});

test(
  'a quote or list item made of paragraphs is read once, through its paragraphs',
  needsPages,
  () => {
    // A <blockquote> or <li> holding <p>s was read whole and then paragraph by paragraph —
    // every multi-paragraph quote twice, the first time with its paragraphs glued together.
    // Nature wraps each reference in <li><p>…</p></li>, so every citation was heard twice.
    const prose = 'This paragraph has to be long enough that the extractor treats it as prose. ';
    const doc = parseHTML(
      `<html><body><article><p>${prose}</p>` +
        '<blockquote><p>First quoted paragraph is here and long enough.</p>' +
        '<p>Second quoted paragraph is here and long enough.</p></blockquote>' +
        '<ul><li><p>A list item with a paragraph inside it, long enough.</p></li></ul>' +
        `<p>${prose}</p></article></body></html>`
    ).document;

    const texts = extractArticle(doc).blocks.map((block) => block.text);
    const count = (pattern) => texts.filter((text) => pattern.test(text)).length;

    assert.equal(count(/First quoted paragraph/), 1);
    assert.equal(count(/Second quoted paragraph/), 1);
    assert.equal(count(/A list item with a paragraph/), 1);
  }
);

/*
 * Reference lists and login walls — both decided by the owner on 2026-09-27. References
 * are citations, not prose, and are noise when listened to. A page that shows only part of
 * the article behind a login or paywall is read up to where the visible text stops;
 * getting past walls is not a feature for the first version.
 */
const pageOf = (body) => parseHTML(`<html><body><article>${body}</article></body></html>`).document;
const textsOf = (doc) => extractArticle(doc).blocks.map((block) => block.text);
const PROSE = 'This paragraph has to be long enough that the extractor treats it as prose.';

test('a reference list is not read, but the section after it is', needsPages, () => {
  const texts = textsOf(
    pageOf(
      `<h1>Title</h1><p>${PROSE}</p>` +
        '<h2>References</h2><ol><li>Bastani, H. et al. Proc. Natl Acad. Sci. USA 122 (2025).</li>' +
        '<li>McGrew, S. Curr. Opin. Psychol. 55, 101737 (2024).</li></ol>' +
        '<h3>Further sources</h3><p>Smith, J. Some Journal 12, 34–56 (2020).</p>' +
        `<h2>Author's note</h2><p>${PROSE} This one comes after the references.</p>`
    )
  );
  const body = texts.join(' ');

  assert.doesNotMatch(body, /Bastani|McGrew|Smith, J\./, 'citations are not read');
  assert.ok(!texts.includes('References'), 'nor is their heading');
  assert.match(body, /This one comes after the references/, 'a later section still is');
});

test('the words "references" and "bibliography" in prose are left alone', needsPages, () => {
  const body = textsOf(
    pageOf(`<h1>Title</h1><p>${PROSE} Good references matter.</p><p>${PROSE}</p>`)
  ).join(' ');

  assert.match(body, /Good references matter/);
});

test(
  'Nature behind its login wall: reading stops where the visible article stops',
  needsPages,
  () => {
    // This copy of the page shows a teaser, then "Enjoying our latest content? Log in or
    // create an account to continue", then related stories and job adverts.
    const body = read('nature')
      .sentences.map((s) => s.text)
      .join(' ');

    assert.match(body, /Vincent-Lancrin acknowledges that there is not much rigorous/);
    assert.doesNotMatch(body, /Log in or create an account/);
    assert.doesNotMatch(body, /Access the most recent journalism/);
    assert.doesNotMatch(body, /Faculty Positions/, 'nothing after the wall');
    assert.doesNotMatch(body, /Proc\. Natl Acad/);
  }
);

test('a wall the reader has already got past does not cut the article', needsPages, () => {
  // A subscriber's copy may keep the wall in the page, switched off. The wall only counts
  // when the browser actually draws it; outside a browser, `hidden` stands in for that.
  const texts = textsOf(
    pageOf(
      `<h1>Title</h1><p>${PROSE}</p>` +
        '<div class="app-access-wall" hidden><h2>Log in to continue</h2></div>' +
        `<p>${PROSE} The rest of the article, for a subscriber.</p>`
    )
  );

  assert.match(texts.join(' '), /The rest of the article, for a subscriber/);
});

test('Duolingo blog: the title and subtitle in the post banner are read', needsPages, () => {
  // Duolingo keeps its title in <div class="post-banner"> inside the <article>, with no
  // <header>, and "banner" is a junk word — the reading began at the first paragraph.
  const { sentences } = read('duolingo-blog');
  const texts = sentences.map((s) => s.text);

  assert.equal(texts[0], 'Why I chose Duolingo: Michael Ye');
  assert.match(texts[1], /^Meet Michael, a Senior Software Engineer/);
  assert.match(texts[2], /^Michael Ye is a Senior Software Engineer/);
});

test('Duolingo blog: the banner lets out the title, not the date and author', needsPages, () => {
  const body = read('duolingo-blog')
    .sentences.map((s) => s.text)
    .join(' ');

  assert.doesNotMatch(body, /Jen Carberry/);
  assert.doesNotMatch(body, /April 27, 2020/);
  assert.match(body, /Champagne/, 'the article still reaches its last answer');
});

test('a title found inside a pop-up does not let the pop-up be read', needsPages, () => {
  // Only a banner is trusted as the box around a title; any other furniture stays out even
  // when the only <h1> on the page is inside it.
  const texts = textsOf(
    pageOf(
      '<div class="modal"><h1>Before you go</h1><p>Sign up for our list and never miss a story.</p></div>' +
        `<p>${PROSE}</p>`
    )
  );

  assert.doesNotMatch(texts.join(' '), /Sign up for our list/);
  assert.match(texts.join(' '), /long enough/);
});

test('Duolingo blog: each question is its own sentence, apart from its answer', needsPages, () => {
  // The interview writes <strong>Question?</strong><br>Answer, and a <br> has no text, so
  // question and answer were read as one run-on sentence: "…at Duolingo!After spending…"
  const texts = read('duolingo-blog').sentences.map((s) => s.text);

  assert.ok(texts.includes('Tell us about your career, and how you ended up at Duolingo!'));
  assert.ok(texts.includes('What do you like most about Duolingo?'));
  assert.ok(
    texts.every((text) => !/[!?][A-Z]/.test(text)),
    'no question glued to an answer'
  );
});

test('Wikipedia: style sheets inside the article are not read aloud', needsPages, () => {
  // Wikipedia puts its CSS inside the article, each <style> wrapped in an empty span.
  // Found 2026-10-02: sentence two of every article was ".mw-parser-output .side-box{…}".
  const { document } = parseHTML(`<html><body><main>
    <h1>Speech synthesis</h1>
    <section>
      <span class="mw-empty-elt"><style>.mw-parser-output .side-box{margin:4px 0}</style></span>
      <div class="side-box"><span><style>.mw-parser-output .plainlist ol{list-style:none}</style></span></div>
      <p>Speech synthesis is the artificial production of human speech. It has a long history.</p>
      <p>A text-to-speech system converts normal language text into speech.<style>p{color:red}</style></p>
    </section>
  </main></body></html>`);
  const article = extractArticle(document);
  const text = buildSentences(article.blocks)
    .map((s) => s.text)
    .join(' ');

  assert.doesNotMatch(text, /mw-parser-output|\{|color:red/);
  assert.match(text, /artificial production of human speech/);
  assert.match(text, /converts normal language text into speech\.$/);
});

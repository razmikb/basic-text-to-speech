/**
 * Content script — the piece that actually runs inside the article page.
 *
 * It is deliberately thin: it wires the extractor, reader, and voice engine together and
 * responds to the toolbar button. All the real logic lives in lib/, which keeps it
 * testable outside a browser.
 *
 * This file is a classic script, not a module, because Firefox content scripts cannot be
 * declared as modules. The modules are pulled in with dynamic import() instead, which is
 * why lib/ is listed in web_accessible_resources in the manifest.
 */

(() => {
  /*
   * Run once per page, however many times this file is loaded into it.
   *
   * It can be loaded twice by one press of the toolbar icon. On a site the add-on has not
   * been granted outright, the press makes Firefox inject this script; the background's
   * click handler, finding nothing answering yet, injects it too. Both copies share this
   * scope, and two copies meant two readers answering the button — the article read twice
   * over, by two voices. The copy that arrives second finds the mark and steps aside.
   */
  if (globalThis.__fttsContentLoaded) return;
  globalThis.__fttsContentLoaded = true;

  const api = globalThis.browser ?? globalThis.chrome;

  /** Built on first use — there is no reason to load anything on a page nobody reads. */
  let session = null;
  let loading = null;
  /**
   * The voice, shared by every reading on this page — the article, and any selection read
   * after it. Building it is the slow part (it may mean connecting to the neural voice and
   * loading a model), so reading a selection must not pay for it again.
   */
  let enginePromise = null;
  /** The bar currently on the page, which is where news from the shared voice goes. */
  let activeControls = null;
  /** The in-flight setup, so a second click waits for it instead of starting its own. */
  let starting = null;
  /** Clicks run one at a time, in order. */
  let queue = Promise.resolve();

  /**
   * TEMPORARY — diagnosis. Make the trace reachable without a developer console.
   *
   * Two ways out, because the console is awkward on a tablet and truncates long output:
   *
   *   Ctrl+Shift+L  — copy the whole trace to the clipboard, ready to paste.
   *   Ctrl+Shift+K  — clear it, so one attempt is not read against the last.
   *
   * A brief message is shown on the page for each, because a shortcut that silently
   * succeeds is indistinguishable from one that silently failed.
   */
  /*
   * TEMPORARY — diagnosis. Installed the moment the page loads, NOT on the first click.
   *
   * It used to be installed inside the module loading that the toolbar button triggers,
   * which meant the shortcuts did not exist until after the first click and the heartbeat
   * missed the whole of startup — the very part being investigated. It also meant that on
   * a page where the button was never pressed, pressing the shortcut did nothing at all
   * and looked broken.
   */
  (async () => {
    try {
      const traceModule = await import(api.runtime.getURL('lib/trace.js'));
      installTraceShortcut(traceModule);
    } catch (error) {
      console.error('Basic Text-to-Speech: the trace could not be installed —', error);
    }
  })();

  function installTraceShortcut(traceModule) {
    const { formatTrace, clearTrace, startHeartbeat, trace } = traceModule;

    // The article page's own heartbeat. If THIS one stalls, the fault is on this side;
    // if only the voice page's stalls, it is over there. That distinction is the whole
    // reason both sides are measured rather than just the suspect one.
    startHeartbeat({ everyMs: 100, lateAfterMs: 60 });

    /** Line count without putting a newline literal inside a template string. */
    const countLines = (text) => text.split(String.fromCharCode(10)).length;

    /**
     * Put the trace on the page, selected and ready to copy.
     *
     * The guaranteed path. A clipboard write can be refused by the page, and a console
     * can be the wrong one — both have already happened — but text in a box on the page
     * in front of the listener cannot go missing. Pre-selected, so copying is one key.
     */
    const showTracePanel = (text) => {
      document.querySelector('.ftts-trace-panel')?.remove();

      const panel = document.createElement('div');
      panel.className = 'ftts-trace-panel';
      panel.style.cssText = [
        'position:fixed',
        'inset:5% 5% 5% 5%',
        'z-index:2147483647',
        'background:#111',
        'color:#eee',
        'border-radius:10px',
        'padding:12px',
        'display:flex',
        'flex-direction:column',
        'gap:8px',
        'box-shadow:0 8px 40px rgba(0,0,0,.5)',
      ].join(';');

      const bar = document.createElement('div');
      bar.style.cssText = 'display:flex;gap:8px;align-items:center;font:13px system-ui';
      bar.textContent = `Basic Text-to-Speech trace — ${countLines(text)} lines. Copy all of this.`;

      const close = document.createElement('button');
      close.textContent = 'Close';
      close.style.cssText =
        'margin-left:auto;font:13px system-ui;padding:6px 14px;border-radius:6px;border:0;cursor:pointer';
      close.addEventListener('click', () => panel.remove());
      bar.appendChild(close);

      const box = document.createElement('textarea');
      box.readOnly = true;
      box.value = text;
      box.style.cssText = [
        'flex:1',
        'width:100%',
        'background:#000',
        'color:#0f0',
        'font:11px ui-monospace,Menlo,Consolas,monospace',
        'border:0',
        'border-radius:6px',
        'padding:10px',
        'white-space:pre',
      ].join(';');

      panel.appendChild(bar);
      panel.appendChild(box);
      document.body?.appendChild(panel);
      box.focus();
      box.select();
    };

    const notify = (message) => {
      const note = document.createElement('div');
      note.className = 'ftts-trace-note';
      note.textContent = message;
      note.style.cssText = [
        'position:fixed',
        'left:50%',
        'top:24px',
        'transform:translateX(-50%)',
        'z-index:2147483647',
        'background:#111',
        'color:#fff',
        'font:14px system-ui,sans-serif',
        'padding:10px 16px',
        'border-radius:8px',
        'pointer-events:none',
      ].join(';');
      document.body?.appendChild(note);
      setTimeout(() => note.remove(), 2600);
    };

    document.addEventListener(
      'keydown',
      (event) => {
        if (!event.ctrlKey || !event.shiftKey) return;
        const key = String(event.key ?? '').toLowerCase();

        if (key === 'l') {
          event.preventDefault();
          const text = formatTrace();
          // Three ways out, because the first two can both fail silently and the owner
          // has already lost a log to exactly that. The panel is the one that cannot:
          // it is on the page, selectable, and does not depend on clipboard permission
          // or on finding the right console.
          console.info(text);
          showTracePanel(text);
          navigator.clipboard?.writeText(text).then(
            () => notify(`Trace copied — ${countLines(text)} lines. Also shown below.`),
            () => notify('Clipboard refused — select the text below and copy it.')
          );
        }

        if (key === 'k') {
          event.preventDefault();
          clearTrace();
          trace('trace cleared — a fresh attempt starts here');
          notify('Trace cleared. Do the thing you want measured now.');
        }
      },
      true
    );

    /*
     * Reachable from the console too, not only by shortcut.
     *
     * The shortcuts are the easy path, but they only work when the ARTICLE page has
     * focus, and the owner went looking in the add-on's own inspector — a different
     * console entirely, where nothing on this side appears. So the trace is also hung on
     * the window under a name nothing else would use, and the instructions are printed
     * where they will actually be read.
     *
     * `copy(ftts.text())` is the useful one: `copy` is a console builtin, so this puts
     * the whole log on the clipboard without a shortcut or a selection.
     */
    globalThis.ftts = {
      text: () => formatTrace(),
      show: () => console.info(formatTrace()),
      clear: () => {
        clearTrace();
        return 'trace cleared — do the thing you want measured now';
      },
    };

    console.info(
      [
        '%cBasic Text-to-Speech trace is ready.',
        '',
        'EASIEST — click the article page first, then press:',
        '  Ctrl+Shift+K   clear before an attempt',
        '  Ctrl+Shift+L   copy the whole trace, ready to paste',
        '',
        'OR from this console (the ARTICLE page, F12 — not the add-on inspector).',
        'The add-on runs in its own context, so FIRST change the context dropdown at the',
        'top-right of the console from "Top" / the page, to the Basic Text-to-Speech extension —',
        'otherwise ftts is not defined. Then:',
        '  ftts.show()          print the whole trace here',
        '  copy(ftts.text())    copy it to the clipboard',
        '  ftts.clear()         clear it before an attempt',
      ].join(String.fromCharCode(10)),
      'font-weight:bold'
    );

    trace('trace ready', { url: location.href });
  }

  async function loadModules() {
    if (loading) return loading;
    loading = (async () => {
      const [
        { extractArticle },
        { createReader, buildSentences },
        { createHighlighter },
        { createControls },
        webSpeech,
        piper,
        { resolveConfig },
        { readSelection, sentenceAt },
      ] = await Promise.all([
        import(api.runtime.getURL('lib/extractor.js')),
        import(api.runtime.getURL('lib/reader.js')),
        import(api.runtime.getURL('lib/highlighter.js')),
        import(api.runtime.getURL('lib/controls.js')),
        import(api.runtime.getURL('lib/engines/web-speech.js')),
        import(api.runtime.getURL('lib/engines/piper.js')),
        import(api.runtime.getURL('lib/config.js')),
        import(api.runtime.getURL('lib/selection.js')),
      ]);

      return {
        extractArticle,
        createReader,
        buildSentences,
        createHighlighter,
        createControls,
        webSpeech,
        piper,
        resolveConfig,
        readSelection,
        sentenceAt,
      };
    })();
    return loading;
  }

  /**
   * Build the voice named in the settings.
   *
   * The neural voice needs a page of its own to run in, which only the background script
   * can create, and it may have to download 60MB the very first time. If any of that
   * fails there is still a working voice built into the browser, and reading the article
   * in a plainer voice beats a button that does nothing.
   */
  async function createEngine(mods, config, onActivity) {
    if (config.engine === 'piper') {
      try {
        // Wait for somewhere to run the voice, and believe the answer. A failure here
        // must not be shrugged off: carrying on would connect to a page that does not
        // exist, and the add-on would sit in silence claiming to be ready.
        const ensureHost = async () => {
          const reply = await api.runtime.sendMessage({ type: 'ftts:voice-page' });
          if (!reply?.ok) throw new Error(reply?.error ?? 'the voice has nowhere to run');
          return true;
        };

        await ensureHost();

        const engine = mods.piper.createPiperEngine({
          voiceId: config.piperVoiceId,
          onActivity,
          // Asked again if the connection is ever lost. The background page holding the
          // voice can be ended by Firefox, and only the background script can build it
          // back — so the engine needs a way to ask rather than a promise made once.
          ensureHost,
          onProgress: ({ phase, percent }) => {
            if (phase === 'downloading') {
              console.info(`Basic Text-to-Speech: downloading the voice — ${percent}%`);
            }
            // The bar exists before the voice is ready on a first run, so a 60MB download
            // is shown there rather than only in the console where nobody is looking.
            onActivity?.({
              phase: 'generating',
              text:
                phase === 'downloading'
                  ? `downloading the voice — ${percent}%`
                  : 'loading the voice',
            });
          },
        });

        console.info('Basic Text-to-Speech: preparing the neural voice…');
        await engine.prepare({
          rate: config.rate,
          splitFirstSentence: config.splitFirstSentence,
          // The page itself identifies the article. The voice holds on to the audio it
          // builds so skipping back costs nothing, and it needs to know when that audio
          // belongs to a page the listener has left. Without the query string and hash,
          // so that a link with a tracking tag on it is still the same article.
          articleId: `${location.origin}${location.pathname}`,
        });
        console.info('Basic Text-to-Speech: neural voice ready.');
        return engine;
      } catch (error) {
        console.warn(
          'Basic Text-to-Speech: the neural voice could not start, using the built-in one instead.',
          error?.message ?? error
        );
      }
    }

    await mods.webSpeech.whenVoicesReady();
    return mods.webSpeech.createWebSpeechEngine();
  }

  async function readSettings(resolveConfig) {
    try {
      const stored = await api.storage.local.get('settings');
      return resolveConfig(stored?.settings);
    } catch {
      return resolveConfig(null);
    }
  }

  /** The article on this page, as blocks and sentences. */
  function findArticle(mods) {
    const article = mods.extractArticle(document);
    return {
      kind: 'article',
      title: article.title,
      blocks: article.blocks,
      sentences: mods.buildSentences(article.blocks),
    };
  }

  /**
   * What the listener selected, as blocks and sentences. The browser's own record of the
   * selected text is the fallback for a selection that is not on the page as text — inside
   * a form field, say — which is then read without a highlight.
   */
  function findSelection(mods, fallbackText) {
    const selection = document.getSelection?.() ?? null;
    const found = mods.readSelection(document, selection, fallbackText);
    // Cleared once read: the browser's blue selection would sit on top of our highlight,
    // and the highlight splits the very text nodes it covers.
    try {
      selection?.removeAllRanges?.();
    } catch {
      // Cosmetic only.
    }
    return { kind: 'selection', title: 'the selection', ...found };
  }

  /**
   * The voice, built once for this page and then shared. A failure is not remembered, so
   * the next attempt builds it afresh rather than inheriting the error.
   */
  function getEngine(mods, config) {
    if (!enginePromise) {
      enginePromise = createEngine(mods, config, (activity) =>
        activeControls?.showActivity(activity)
      ).catch((error) => {
        enginePromise = null;
        throw error;
      });
    }
    return enginePromise;
  }

  /**
   * Build everything needed to read `find`'s text — the article, or a selection. Returns
   * null when there is nothing to read, which is a normal outcome on a search results page
   * or an app, not an error.
   */
  async function createSession(find) {
    const mods = await loadModules();
    const { createReader, createHighlighter, createControls, resolveConfig } = mods;

    const article = find(mods);
    const { sentences } = article;

    if (sentences.length === 0) {
      console.info(
        article.kind === 'selection'
          ? 'Basic Text-to-Speech: no readable text in the selection.'
          : 'Basic Text-to-Speech: no article text found on this page.'
      );
      return null;
    }

    // The page's own language beats a guessed default — it picks the right voice.
    const config = await readSettings(resolveConfig);
    const pageLang = document.documentElement.getAttribute('lang');
    if (pageLang) config.lang = pageLang;

    // The bar goes up now, before the voice is built, so the first press of the toolbar icon
    // is answered at once instead of after a silent wait. It gets its reader further down.
    let controls = null;
    let reader = null;
    const buildBar = () => {
      controls = createControls({
        doc: document,
        config,
        onSpeedChange: (rate) => setRate(config, session?.engine, rate),
        onFoldChange: (folded) => saveSetting('controlsFolded', folded),
        // Kept on this article's config too, so a bar rebuilt after ✕ comes back where it
        // was left rather than where the save may not yet have landed.
        onMove: (spot) => {
          config.controlsSpot = spot;
          saveSetting('controlsSpot', spot);
        },
        // Closing the bar means "stop reading", which is more than the reader can do alone:
        // the highlight has to come off and the voice has to be handed back.
        onStop: () => stop(),
      });
      activeControls = controls;
      controls.show();
      if (reader) controls.attachReader(reader);
      else controls.showActivity({ phase: 'loading' });
      return controls;
    };
    buildBar();

    // Shared with any earlier reading on this page. It was built with the settings of
    // that time, so the voice chosen now is restated; the engine ignores a non-change.
    const engine = await getEngine(mods, config);
    try {
      engine.setVoice?.(config.piperVoiceId);
    } catch {
      // The voice from before is still a voice.
    }

    reader = createReader({ engine, sentences, config });

    // The reader announces which sentence it is speaking; the highlighter puts that on the
    // page. Neither knows the other exists, which is what keeps the voice, the position
    // and the page independent of one another.
    const buildHighlighter = () =>
      createHighlighter({ doc: document, blocks: article.blocks, config });
    let highlighter = buildHighlighter();

    reader.on('sentence', ({ index, sentence }) => {
      console.debug(`Basic Text-to-Speech: [${index + 1}/${sentences.length}] ${sentence.text}`);
      highlighter.show(sentence);
      // Where we are in the article, which the voice itself knows nothing about. The plain
      // browser voice reports no activity at all, so without this the panel would sit empty
      // whenever the neural voice is not the one being used.
      controls?.showPosition({ index, total: sentences.length, text: sentence.text });
    });
    reader.on('state', ({ state }) => {
      // Only stopping takes the highlight off. Pausing deliberately leaves it: pausing is
      // exactly when you want to see where you had got to.
      if (state === 'idle') highlighter.destroy();
    });
    reader.on('finished', () => {
      console.info('Basic Text-to-Speech: finished reading.');
      highlighter.clear();
      // The voice is free again, so another tab may take it without waiting for us.
      announceReleased();
    });

    // The bar is already up, showing "loading". Like the highlighter, it knows nothing about
    // voices — it drives the reader through the same calls the toolbar button uses.
    controls.attachReader(reader);

    console.info(
      `Basic Text-to-Speech: found "${article.title || 'this page'}" — ` +
        `${article.blocks.length} blocks, ${sentences.length} sentences.`
    );

    // Closing the bar destroys it for good, but the session lives on; this is how the next
    // press of the toolbar icon gets a fresh one.
    const made = {
      kind: article.kind,
      blocks: article.blocks,
      reader,
      engine,
      highlighter,
      controls,
      config,
      barClosed: false,
    };
    made.rebuildBar = () => {
      // Stopping destroys the highlighter for good too, so it is renewed with the bar.
      highlighter = buildHighlighter();
      made.highlighter = highlighter;
      made.controls = buildBar();
      made.barClosed = false;
    };
    return made;
  }

  /**
   * Change the speaking speed while the article is being read.
   *
   * The rate is handed to the engine on every sentence, so simply changing it takes effect
   * from the next sentence onward. A neural voice may also have already built the next few
   * sentences at the old speed, so it is told to throw that work away and rebuild — which
   * is why this asks the engine rather than only updating the setting.
   *
   * The new speed is remembered, so it is still in force on the next article.
   */
  function setRate(config, engine, rate) {
    config.rate = rate;
    try {
      engine.setRate?.(rate);
    } catch (error) {
      console.warn(
        'Basic Text-to-Speech: the voice would not change speed.',
        error?.message ?? error
      );
    }
    saveSetting('rate', rate);
  }

  /**
   * Change the voice while the article is being read.
   *
   * WHERE THE CHANGE COMES FROM is what makes this different from the speed. Speed is
   * changed on the bar, in this page, so this page already knows. The voice is chosen in
   * the settings page — a different tab entirely, which cannot reach this one — so the
   * only thing the two share is stored settings. Hence listening for the setting rather
   * than being told: the settings page writes, and every reading tab notices.
   *
   * The engine decides whether this is really a change; re-stating the voice already
   * speaking must cost nothing, because acting on one throws away every sentence banked
   * ahead and may download 60MB.
   */
  function setVoice(config, engine, voiceId) {
    if (typeof voiceId !== 'string' || voiceId === '') return;
    if (voiceId === config.piperVoiceId) return;
    config.piperVoiceId = voiceId;
    try {
      engine.setVoice?.(voiceId);
    } catch (error) {
      console.warn('Basic Text-to-Speech: the voice would not change.', error?.message ?? error);
    }
  }

  /**
   * Watch for settings changed in another tab — which, for now, means the settings page.
   *
   * Registered once for the life of the content script rather than per article, because a
   * change can arrive at any time and re-registering per session is how listeners get
   * duplicated. It does nothing at all when there is no article playing: the new voice is
   * simply read from storage the next time one starts.
   */
  function watchSettings() {
    try {
      api.storage?.onChanged?.addListener((changes, area) => {
        if (area !== 'local' || !changes?.settings) return;
        const next = changes.settings.newValue;
        if (!next || typeof next !== 'object') return;
        if (!session) return;
        setVoice(session.config, session.engine, next.piperVoiceId);
      });
    } catch {
      // No storage events here. Voice changes then apply on the next article rather than
      // this one, which is a smaller loss than a content script that fails to load.
    }
  }

  /** Remember one setting, without caring much whether it worked. */
  function saveSetting(key, value) {
    try {
      const done = api.storage.local
        .get('settings')
        .then((stored) =>
          api.storage.local.set({ settings: { ...(stored?.settings ?? {}), [key]: value } })
        );
      if (done && typeof done.catch === 'function') done.catch(() => {});
    } catch {
      // A setting that will not save is a small loss; it still applies to this article.
    }
  }

  /**
   * Handle a click on the toolbar button: it switches reading on and off.
   *
   * Off means stopped, not paused — the same as the bar's ✕. Someone who presses the icon
   * again has said they are done listening, and a paused bar and highlight left on the page
   * would only be in their way. Pausing is still one tap away, on the bar itself.
   *
   * Setting up takes a moment — the browser's voice list has to arrive first — and the
   * user does not know that. Pressing the button twice in quick succession must switch
   * reading off, not start a second voice reading the same article over the top of the
   * first, so clicks queue behind each other and the setup happens exactly once.
   */
  function toggle() {
    queue = queue.then(async () => {
      // The bar is up, so reading is on — whether playing, paused, or finished.
      if (session && !session.barClosed) {
        stop();
        return;
      }

      // A finished selection is not what the toolbar icon means: the icon reads the article.
      if (session?.kind === 'selection') {
        session = null;
        starting = null;
      }

      if (!session) {
        if (!starting) starting = createSession(findArticle);
        session = await starting;
        if (!session) return;
      }

      await begin();
    });
    return queue;
  }

  /**
   * Read just the selected text, from the right-click menu.
   *
   * Whatever was reading on this page stops first — one voice, one bar — and the selection
   * becomes the reading. Stopping first matters for more than tidiness: the sentence
   * highlight wraps the page's text, and the selection must be measured once it has gone.
   * The article starts again from the top on the next press of the toolbar icon.
   */
  function readSelectionAloud(fallbackText) {
    queue = queue.then(async () => {
      if (session) stop();
      const next = await createSession((mods) => findSelection(mods, fallbackText));
      if (!next) return;
      session = next;
      starting = null;
      await begin();
    });
    return queue;
  }

  /**
   * Where the listener last right-clicked, kept as a live range.
   *
   * The menu is chosen a moment after the right-click, and in that moment the article may
   * have moved on a sentence — the highlight coming off one sentence and going on the next
   * rewrites the text nodes around it. A live range is carried along by the browser through
   * those changes; a remembered node and offset could point at a node that no longer exists.
   */
  let rightClicked = null;

  function rememberRightClick(event) {
    try {
      const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY);
      if (!caret?.offsetNode) {
        rightClicked = null;
        return;
      }
      const range = document.createRange();
      range.setStart(caret.offsetNode, caret.offset);
      // The pointer too: on empty space the caret snaps to the nearest text, which is
      // usually the paragraph above — the pointer's height is what says "below". Page
      // coordinates, so a scroll between the click and the menu choice does not skew it.
      rightClicked = {
        range,
        pageX: event.clientX + window.scrollX,
        pageY: event.clientY + window.scrollY,
      };
    } catch {
      // Unknown means "from the start", which still reads the article.
      rightClicked = null;
    }
  }

  /**
   * Read the article from the sentence that was right-clicked, to the end.
   *
   * An article already on the page is reused — same reader, same voice, the audio it has
   * banked kept — and simply moved. Anything else (nothing yet, or a selection) gives way to
   * a fresh reading of the article.
   */
  function readFromHere() {
    const point = rightClicked;
    rightClicked = null;
    queue = queue.then(async () => {
      if (session?.kind !== 'article') {
        if (session) stop();
        session = null;
        starting = null;
        session = await createSession(findArticle);
        if (!session) return;
      }

      const mods = await loadModules();
      const index = mods.sentenceAt({
        blocks: session.blocks,
        sentences: session.reader.getSentences(),
        container: point?.range.startContainer ?? null,
        offset: point?.range.startOffset ?? 0,
        x: point ? point.pageX - window.scrollX : undefined,
        y: point ? point.pageY - window.scrollY : undefined,
      });
      await begin(index);
    });
    return queue;
  }

  /**
   * Start the current session speaking, with its bar up — from `index` when given,
   * otherwise from where it was.
   */
  async function begin(index) {
    // Starting needs the voice, so claim it first and wait for other tabs to let go
    // before making a sound.
    await claimVoice();
    if (session.barClosed) session.rebuildBar();
    // The bar appears with the first play rather than on page load: a page nobody is
    // listening to should have nothing of ours on it.
    session.controls?.show();
    if (typeof index === 'number') session.reader.playFrom(index);
    else session.reader.play();
  }

  function stop() {
    if (!session) return;
    session.reader.stop();
    // Belt and braces: stopping an already-stopped reader announces no change of state,
    // so the page furniture is torn down here directly rather than through that event.
    session.highlighter?.destroy();
    session.controls?.destroy();
    session.barClosed = true;
    announceReleased();
  }

  /**
   * Ask the background script to clear other tabs out of the way before we speak.
   *
   * There is only one voice in the whole browser. Without this, two tabs both reading
   * push sentences into the same queue and the browser alternates between them — the
   * two articles interleave, a sentence at a time, in one stream. Only the background
   * script can see other tabs, so only it can enforce one-reader-at-a-time.
   *
   * Waiting for the reply matters: it is what guarantees the other tab has let go
   * before this one starts. If the message fails we speak anyway — an overlap is
   * better than a button that does nothing.
   */
  async function claimVoice() {
    try {
      await api.runtime.sendMessage({ type: 'ftts:claim' });
    } catch (error) {
      console.warn('Basic Text-to-Speech: could not claim the voice.', error?.message ?? error);
    }
  }

  /** Tell the background script we are no longer using the voice. */
  function announceReleased() {
    try {
      const sent = api.runtime.sendMessage({ type: 'ftts:released' });
      if (sent && typeof sent.catch === 'function') sent.catch(() => {});
    } catch {
      // Advisory only: the background script recovers on its own if this never arrives.
    }
  }

  /**
   * Another tab is taking over the voice. Let go but keep our place, so coming back
   * and pressing play carries on from the same sentence.
   */
  function yieldVoice() {
    if (!session) return;
    if (session.reader.releaseVoice()) {
      console.info('Basic Text-to-Speech: another tab is reading; paused here.');
    }
  }

  /**
   * Hand the shared voice back when this page is no longer the one being listened to.
   *
   * The browser has ONE speech engine for all tabs. A tab that walks away still holding
   * it paused blocks every other tab from speaking — the article there simply never
   * starts, then bursts into life the moment the first tab is closed.
   *
   * A page that is actively speaking keeps the voice: listening to an article while
   * working in another tab is the whole point. It is only a *paused* hidden page that
   * has to let go, and it keeps its place, so coming back and pressing play carries on
   * from the same sentence.
   */
  function releaseIfHidden() {
    if (document.visibilityState !== 'hidden') return;
    if (!session) return;
    if (session.reader.getState() !== 'paused') return;
    // Only worth doing for a voice somebody else is queuing for. The neural voice is
    // ours alone, and letting go of it frees nothing while costing the listener the
    // sentences already built — see the release note in reader.js.
    if (!session.reader.sharesVoice()) return;
    session.reader.releaseVoice();
  }

  api.runtime.onMessage.addListener((message) => {
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'ftts:toggle') {
      toggle().catch((error) => console.error('Basic Text-to-Speech:', error));
    } else if (message.type === 'ftts:read-from-here') {
      readFromHere().catch((error) => console.error('Basic Text-to-Speech:', error));
    } else if (message.type === 'ftts:read-selection') {
      readSelectionAloud(message.text).catch((error) =>
        console.error('Basic Text-to-Speech:', error)
      );
    } else if (message.type === 'ftts:stop') {
      stop();
    } else if (message.type === 'ftts:yield') {
      yieldVoice();
    }
  });

  // Speech is owned by the browser, not the page, so it keeps talking after a navigation
  // unless we stop it. Leaving no trace applies to sound as much as to the DOM.
  window.addEventListener('pagehide', stop);

  // Where "Read from here" means. Captured first, before the page's own handlers, and
  // passive: it only looks, and never stops the page's own menu or the browser's.
  window.addEventListener('contextmenu', rememberRightClick, { capture: true, passive: true });

  // Switching tabs, minimising, or locking the screen all land here.
  document.addEventListener('visibilitychange', releaseIfHidden);

  // Notice a voice chosen in the settings page, even mid-article.
  watchSettings();
})();

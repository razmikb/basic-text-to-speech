import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        // WebExtension + browser APIs available to extension code
        browser: 'readonly',
        chrome: 'readonly',
        window: 'readonly',
        document: 'readonly',
        // The page's own address, used to tell one article from another.
        location: 'readonly',
        console: 'readonly',
        speechSynthesis: 'readonly',
        SpeechSynthesisUtterance: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        Node: 'readonly',
        NodeFilter: 'readonly',
        // Used by the Piper voice: raw samples played straight through Web Audio.
        AudioContext: 'readonly',
        URL: 'readonly',
        // How the explanation page is told which page failed, and why.
        URLSearchParams: 'readonly',
        performance: 'readonly',
        navigator: 'readonly',
        // Used by the warm voice: the model's raw output is assembled into a WAV file
        // by hand, which means working in bytes and handing over the result as a blob.
        Blob: 'readonly',
        DataView: 'readonly',
        ArrayBuffer: 'readonly',
        // The voice runs on its own thread, which the page starts from here.
        Worker: 'readonly',
      },
    },
  },
  {
    /*
     * The voice's own thread.
     *
     * Listed separately because it is a genuinely different place to run: there is no
     * window and no document here, and `self` is the global. Leaving it in the block
     * above would let a DOM call into this file that only fails once it is loaded in a
     * real browser — which is exactly the kind of fault that costs a listening session.
     */
    files: ['src/piper/voice-worker.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        self: 'readonly',
        console: 'readonly',
        navigator: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        Blob: 'readonly',
        DataView: 'readonly',
        ArrayBuffer: 'readonly',
      },
    },
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        setImmediate: 'readonly',
        setTimeout: 'readonly',
        // Reading a source file relative to the test, rather than to the working directory.
        URL: 'readonly',
        // The warm voice hands back a blob, so its tests check for one.
        Blob: 'readonly',
        DataView: 'readonly',
      },
    },
  },
  {
    // Development-only tooling. Runs in Node, never ships inside the add-on.
    files: ['tools/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
  {
    ignores: [
      'node_modules/',
      'dist/',
      'web-ext-artifacts/',
      'models/',
      'tests/pages/',
      // Vendored third-party code, copied in by `npm run vendor`. Other people's
      // minified files: linting them tells us nothing we can act on.
      'src/vendor/',
    ],
  },
];

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/**
 * Run the REAL content.js, as Firefox would, against a pretend page.
 *
 * content.js cannot be imported like the modules in lib/: it is a classic script that talks
 * to `browser.*` and pulls lib/ in with import(). So it is run in a sandbox of its own, with
 * a fake `browser` object, and every lib/ module it asks for is answered by
 * content-page-fakes.js — which records what the script did with them.
 *
 * Loading it twice into the same page is a matter of calling load() twice: both runs share
 * one sandbox, which is how Firefox treats two copies of one add-on's script in one tab.
 */
const SOURCE = readFileSync(new URL('../../src/content.js', import.meta.url), 'utf8');
const FAKES = new URL('./content-page-fakes.js', import.meta.url).href;

export function makePage() {
  const listeners = [];
  const api = {
    runtime: {
      // Every lib/ module, the trace included, comes from the one fake.
      getURL: () => FAKES,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: async () => undefined,
    },
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener: () => {} },
    },
  };
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  const context = vm.createContext({
    browser: api,
    console: quiet,
    location: { href: 'https://example.com/a', origin: 'https://example.com', pathname: '/a' },
    window: { addEventListener: () => {} },
    document: {
      addEventListener: () => {},
      visibilityState: 'visible',
      documentElement: { getAttribute: () => null },
      getSelection: () => ({ rangeCount: 0, removeAllRanges() {} }),
    },
  });

  // Node marks this loader option experimental and prints a warning once per test file.
  // It is the only way to let the sandboxed script's import() reach real module files.
  const load = () =>
    vm.runInContext(SOURCE, context, {
      importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    });

  /** Press the toolbar icon: the message the background script sends, to every listener. */
  const pressIcon = async () => {
    for (const listener of listeners) listener({ type: 'ftts:toggle' });
    // The script answers through a promise queue; let it run to the end.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  /** Choose "Read selection aloud" from the right-click menu. */
  const readSelection = async (text = '') => {
    for (const listener of listeners) listener({ type: 'ftts:read-selection', text });
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  /** Choose "Read from here" from the right-click menu. */
  const readFromHere = async () => {
    for (const listener of listeners) listener({ type: 'ftts:read-from-here' });
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  return { listeners, load, pressIcon, readSelection, readFromHere };
}

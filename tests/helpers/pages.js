import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

/**
 * The saved copies of real web pages the tests read from.
 *
 * They are other people's articles, so they are kept out of the public repository
 * (git-ignored) and live only on the owner's machine. Where they are missing — a fresh
 * clone, or the automatic checks on GitHub — every test that needs one is skipped with a
 * reason, rather than failing. Pass `needsPages` as a test's options.
 */

const pagesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'pages');

export const havePages = fs.existsSync(pagesDir) && fs.readdirSync(pagesDir).length > 0;

export const needsPages = havePages
  ? {}
  : { skip: 'the saved web pages (tests/pages/) are private and not in this copy' };

export const loadPage = (name) =>
  parseHTML(fs.readFileSync(path.join(pagesDir, `${name}.html`), 'utf8')).document;

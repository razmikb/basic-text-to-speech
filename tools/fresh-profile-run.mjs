/* global setTimeout, WebSocket */
/**
 * First-run check: a brand-new Firefox profile, invisible, presses the toolbar button on an
 * article and prints what the add-on logs. Catches what only a first install shows — the
 * voice download, the background falling asleep — which a profile that already holds the
 * voice can never show. Run before every release:
 *
 *   node tools/fresh-profile-run.mjs [article-url] [seconds-to-watch]
 *
 * Expect "neural voice ready" and numbered sentences. Uses WebDriver BiDi, built into
 * Firefox; nothing to install. The profile is deleted afterwards unless PROFILE is set.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const S = fs.mkdtempSync(path.join(os.tmpdir(), 'ftts-'));
const PROFILE = process.env.PROFILE ?? `${S}/profile-${Date.now()}`;
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const ARTICLE = process.argv[2] ?? 'https://en.wikipedia.org/wiki/Text-to-speech';
const WAIT_S = Number(process.argv[3] ?? 90);
const PORT = 9333;

if (!fs.existsSync(PROFILE)) fs.mkdirSync(PROFILE);
fs.writeFileSync(
  `${PROFILE}/user.js`,
  [
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("browser.aboutwelcome.enabled", false);',
  ].join('\n')
);

const ff = spawn(
  'firefox',
  [
    '--headless',
    '--no-remote',
    '--profile',
    PROFILE,
    '--remote-debugging-port',
    String(PORT),
    '--remote-allow-system-access',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] }
);
const ffLog = fs.createWriteStream(`${S}/firefox-stdout.log`);
ff.stdout.pipe(ffLog);
ff.stderr.pipe(ffLog);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);

let ws;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  try {
    ws = new WebSocket(`ws://127.0.0.1:${PORT}/session`);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
    });
    break;
  } catch {
    ws = null;
  }
}
if (!ws) throw new Error('could not connect');

let nextId = 1;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.type === 'error' ? p.reject(new Error(`${m.error}: ${m.message}`)) : p.resolve(m.result);
  } else if (m.method === 'log.entryAdded') {
    const p = m.params;
    const text = p.text ?? (p.args ?? []).map((a) => a.value ?? a.type).join(' ');
    console.log(`${stamp()} [${p.level}] ${text}`.slice(0, 400));
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

try {
  await send('session.new', { capabilities: {} });
  await send('session.subscribe', { events: ['log.entryAdded'] });

  const { extension } = await send('webExtension.install', {
    extensionData: { type: 'path', path: SRC },
  });
  console.log(`${stamp()} installed ${extension}`);

  const tree = await send('browsingContext.getTree', {});
  const tab = tree.contexts[0].context;
  await send('browsingContext.navigate', { context: tab, url: ARTICLE, wait: 'complete' });
  console.log(`${stamp()} article loaded`);
  await sleep(1500);

  const chrome = await send('browsingContext.getTree', { 'moz:scope': 'chrome' });
  const win = chrome.contexts[0].context;
  const clicked = await send('script.evaluate', {
    target: { context: win },
    awaitPromise: true,
    expression: `(async () => {
      const id = 'basic-text-to-speech_razmikb-browser-action';
      CustomizableUI.addWidgetToArea(id, CustomizableUI.AREA_NAVBAR);
      await new Promise(r => setTimeout(r, 500));
      const node = document.getElementById(id);
      if (!node) return 'no button';
      const btn = node.querySelector('.unified-extensions-item-action-button') ?? node;
      const kind = btn.localName + '#' + btn.id + '.' + btn.className;
      btn.doCommand ? btn.doCommand() : btn.click();
      return 'clicked ' + kind;
    })()`,
  });
  console.log(`${stamp()} button: ${clicked.result?.value ?? JSON.stringify(clicked)}`);

  for (let s = 0; s < WAIT_S; s += 10) {
    await sleep(10000);
    const bar = await send('script.evaluate', {
      target: { context: tab },
      awaitPromise: false,
      expression: `(() => {
        const host = document.querySelector('[id^="ftts-"], [class^="ftts-"]');
        const all = [...document.querySelectorAll('[id^="ftts"], [class*="ftts"]')].slice(0,8).map(e => e.localName + '.' + e.className).join(',');
        const hl = document.querySelectorAll('.ftts-current, [class*="ftts-highlight"]').length;
        return JSON.stringify({ ids: all, highlighted: hl, barText: host?.shadowRoot?.textContent?.slice(0, 200) ?? host?.textContent?.slice(0, 200) });
      })()`,
    });
    console.log(`${stamp()} page: ${bar.result?.value}`);
  }
} catch (error) {
  console.log('DRIVER ERROR', error.message);
} finally {
  try {
    await send('session.end');
  } catch {
    // Firefox may already be gone; it is killed next either way.
  }
  ff.kill();
  await sleep(500);
  if (!process.env.PROFILE) fs.rmSync(S, { recursive: true, force: true });
}
process.exit(0);

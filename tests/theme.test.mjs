import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../public/theme.js', import.meta.url), 'utf8');

function runTheme({ dark = false, saved, blocked = false } = {}) {
  const root = { dataset: {}, style: {} };
  const control = { hidden: true };
  const events = {};
  const media = { matches: dark, addEventListener: (_, fn) => { events.media = fn; } };
  const select = { value: '', addEventListener: (_, fn) => { events.select = fn; } };
  const stored = new Map(saved === undefined ? [] : [['appearance', saved]]);
  const storage = (fn) => { if (blocked) throw new Error('Storage unavailable'); return fn(); };
  vm.runInNewContext(script, {
    document: {
      documentElement: root,
      addEventListener: (_, fn) => { events.ready = fn; },
      querySelector: (query) => query === '#appearance' ? select : control,
    },
    window: {
      matchMedia: () => media,
      addEventListener: (_, fn) => { events.storage = fn; },
    },
    localStorage: {
      getItem: (key) => storage(() => stored.get(key) ?? null),
      setItem: (key, value) => storage(() => stored.set(key, value)),
      removeItem: (key) => storage(() => stored.delete(key)),
    },
  });
  return {
    root, control, select, stored,
    ready: () => events.ready(),
    choose: (value) => { select.value = value; events.select(); },
    system: (value) => { media.matches = value; events.media(); },
    otherTab: (value) => events.storage({ key: 'appearance', newValue: value }),
  };
}

test('applies system theme before DOMContentLoaded, preventing a wrong-theme first paint', () => {
  const page = runTheme({ dark: true });
  assert.equal(page.root.dataset.theme, 'dark');
  assert.equal(page.root.style.colorScheme, 'dark');
  assert.equal(page.control.hidden, true);
  page.ready();
  assert.equal(page.select.value, 'system');
  assert.equal(page.control.hidden, false);
  page.system(false);
  assert.equal(page.root.dataset.theme, 'light');
});

test('remembers explicit themes across reloads and ignores system changes', () => {
  const page = runTheme();
  page.ready();
  page.choose('dark');
  assert.equal(page.root.dataset.theme, 'dark');
  assert.equal(page.stored.get('appearance'), 'dark');
  page.system(false);
  assert.equal(page.root.dataset.theme, 'dark');
  const reload = runTheme({ saved: page.stored.get('appearance') });
  assert.equal(reload.root.dataset.theme, 'dark');
  reload.ready();
  assert.equal(reload.select.value, 'dark');
});

test('switching back to System removes the override', () => {
  const page = runTheme({ dark: true, saved: 'light' });
  assert.equal(page.root.dataset.theme, 'light');
  page.ready();
  page.choose('system');
  assert.equal(page.root.dataset.theme, 'dark');
  assert.equal(page.stored.has('appearance'), false);
  page.system(false);
  assert.equal(page.root.dataset.theme, 'light');
});

test('blocked browser storage does not break theme selection', () => {
  const page = runTheme({ blocked: true, dark: true });
  assert.equal(page.root.dataset.theme, 'dark');
  page.ready();
  page.choose('light');
  assert.equal(page.root.dataset.theme, 'light');
  assert.equal(page.control.hidden, false);
});

test('invalid stored values fall back to the system theme', () => {
  const page = runTheme({ saved: 'invalid', dark: true });
  page.ready();
  assert.equal(page.select.value, 'system');
  assert.equal(page.root.dataset.theme, 'dark');
});

test('theme preference stays in sync across tabs', () => {
  const page = runTheme({ saved: 'light' });
  page.ready();
  page.otherTab('dark');
  assert.equal(page.root.dataset.theme, 'dark');
  assert.equal(page.select.value, 'dark');
  page.otherTab(null);
  assert.equal(page.select.value, 'system');
  assert.equal(page.root.dataset.theme, 'light');
});

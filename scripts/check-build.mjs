import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import assert from 'node:assert/strict';

const output = resolve('dist');
async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory()
    ? walk(join(directory, entry.name)) : join(directory, entry.name)))).flat();
}
const files = await walk(output);
const known = new Set(files.map((file) => relative(output, file)));
const origin = 'https://martinondejka.github.io';
let checked = 0;
for (const file of files.filter((file) => file.endsWith('.html'))) {
  const html = await readFile(file, 'utf8');
  const path = '/' + relative(output, file).replace(/index\.html$/, '');
  assert.match(html, /<html[^>]+lang="en"/, `${path}: missing language`);
  assert.match(html, /<title>[^<]+<\/title>/, `${path}: missing title`);
  assert.match(html, /name="description"/, `${path}: missing description`);
  assert.equal((html.match(/<h1(?:\s|>)/g) || []).length, 1, `${path}: expected one h1`);
  for (const [, value] of html.matchAll(/(?:href|src)="([^"#]+)"/g)) {
    if (/^(mailto:|tel:|data:)/.test(value)) continue;
    const url = new URL(value.replaceAll('&amp;', '&'), origin + path);
    if (url.origin !== origin) continue;
    const target = decodeURIComponent(url.pathname).replace(/^\//, '');
    assert(known.has(target) || known.has(target + 'index.html') || known.has(target + '/index.html'), `${path}: broken local URL ${value}`);
    checked++;
  }
}
for (const required of ['index.html', 'writing/index.html', 'case-studies/index.html', 'about/index.html', '404.html', 'sitemap-index.xml', 'favicon.svg', 'theme.js']) {
  assert((await stat(join(output, required))).isFile(), `Missing ${required}`);
}
console.log(`Verified ${files.filter((file) => file.endsWith('.html')).length} HTML pages and ${checked} local links/assets.`);

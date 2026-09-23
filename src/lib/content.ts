import { getCollection, type CollectionEntry } from 'astro:content';

export type Entry = CollectionEntry<'writing'>;

export async function getEntries() {
  const entries = await getCollection('writing', ({ data }) => import.meta.env.DEV || !data.draft);
  return entries.sort((a, b) => b.data.date.getTime() - a.data.date.getTime() || a.id.localeCompare(b.id));
}

export function entryUrl(entry: Entry) {
  return `/writing/${entry.id.split('/').map(encodeURIComponent).join('/')}/`;
}

export function formatDate(date: Date) {
  return new Intl.DateTimeFormat('en', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(date);
}

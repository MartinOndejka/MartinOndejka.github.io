import { getCollection, type CollectionEntry } from 'astro:content';

export type ContentKind = 'writing' | 'caseStudies';
export type Entry = CollectionEntry<ContentKind>;

export async function getEntries(kind: ContentKind) {
  const entries = await getCollection(kind, ({ data }) => import.meta.env.DEV || !data.draft);
  return entries.sort((a, b) => b.data.date.getTime() - a.data.date.getTime() || a.id.localeCompare(b.id));
}

export function entryUrl(entry: Entry) {
  const section = entry.collection === 'writing' ? 'writing' : 'case-studies';
  return `/${section}/${entry.id.split('/').map(encodeURIComponent).join('/')}/`;
}

export function formatDate(date: Date) {
  return new Intl.DateTimeFormat('en', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(date);
}

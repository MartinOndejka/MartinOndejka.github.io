import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const schema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  date: z.coerce.date(),
  draft: z.boolean().default(true),
});

export const collections = {
  writing: defineCollection({
    loader: glob({ pattern: '**/*.md', base: './src/content/writing', generateId: ({ entry }) => entry.replace(/\.md$/, '') }),
    schema,
  }),
};

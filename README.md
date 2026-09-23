# Martin Ondejka

A small, static blog and case-study site built with Astro, TypeScript, and plain CSS.

**Website:** https://martinondejka.github.io

## Local development

Use Node 24 (`nvm use` if you use nvm), then:

```sh
npm ci
npm run dev
```

Open the local URL printed by Astro. Development includes drafts, with a visible draft label. Astro 7 runs the dev server in the background; use `npx astro dev stop` to stop it and `npx astro dev logs` to inspect logs.

```sh
npm run verify    # Type checks, theme tests, production build, local-link checks
npm run preview   # Serve the production output, which excludes drafts
```

## Write an article or case study

Copy either `templates/article.md` or `templates/case-study.md` into `src/content/writing/`. Both formats share the same Writing section and publishing workflow; choose whichever template fits the post. Give it a lowercase, hyphenated filename such as `settlement-design.md`.

```yaml
---
title: "An informative title"
summary: "A short description for listings and page metadata."
date: 2026-09-23
draft: true
---
```

The filename determines the address, for example `/writing/settlement-design/`. A nested file such as `rust/memory.md` becomes `/writing/rust/memory/`. Use ISO dates (`YYYY-MM-DD`); dates display consistently in UTC. All posts appear newest first, with the three most recent on the homepage.

The body supports standard Markdown, including headings, lists, links, tables, blockquotes, fenced code with language names, and images. Put public images in `public/images/` and reference them as `![Descriptive alternative text](/images/example.png)`. Use `##` for the first body heading: the title is already the page's `h1`.

Preview your draft with `npm run dev`. To publish, set `draft: false`, update the date, run `npm run verify`, and push to `main`. An omitted draft field defaults to `true`. Drafts never get production detail pages, listing entries, or sitemap URLs. Dates organize content; they do not schedule publication.

**This is a public source repository.** Draft text committed to GitHub remains readable in the repository even though it is excluded from the website. Keep confidential drafts outside the repository or in the gitignored `.local/` folder. Generic templates are not published as pages.

## Site content and appearance

- Homepage introduction: `src/pages/index.astro`
- Biography: `src/pages/about.astro`
- Navigation, metadata, and footer: `src/layouts/BaseLayout.astro`
- Layout, light/dark tokens, and article typography: `src/styles/global.css`
- Collection and frontmatter validation: `src/content.config.ts`
- Theme selection: `public/theme.js`

System appearance follows the device preference. Explicit light/dark choices are remembered locally. Reading and navigation work without JavaScript; the appearance control is shown only when its script can run.

## Deployment

The repository is `MartinOndejka/MartinOndejka.github.io`. Under **Settings → Pages → Build and deployment**, select **GitHub Actions** as the source. The workflow validates pull requests and deploys successful `main` builds using the official Astro and GitHub Pages actions. Track progress in the repository's Actions tab and the `github-pages` environment.

The canonical origin is set in `astro.config.mjs`. This is a root user site, so it has no `/blog` base path. Sitemap files are generated during the build. The former `/case-studies/` address redirects to `/writing/` and is excluded from the sitemap. GitHub Pages serves `dist/404.html` for unknown addresses.

To undo a publication, revert the relevant commit and push the revert to `main`; the last successful deployment stays live if a later build fails.

The site launches with one empty Writing collection for notes, articles, and case studies. It contains no analytics, comments, CMS, or newsletter integration. Only public professional biography and profile links are included; private contact details and the CV PDF are not part of this repository.

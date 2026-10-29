// The site's pages, built by build.ts after it stages the player's files in
// dist/public/. Starlight frames them all: the home page, the player, the
// guide (docs/guide.md, by astro/content.config.ts) and the licences.
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import {
  AVMPLUS,
  avmplus,
  BASE,
  blob,
  build,
  importMap,
  mplFiles,
  root,
  ruffleFiles,
} from "./facts.ts";
import { readGuide } from "./guide.ts";

const REPOSITORY = "https://github.com/swf2es/swf2es";

/**
 * What the pages show of the build, and the base they link under, as the
 * module virtual:swf2es/facts (read through astro/site.ts): the
 * pages are bundled, where facts.ts would no longer find the repository by
 * its own URL.
 */
function facts() {
  const id = "virtual:swf2es/facts";
  const source = `export default ${JSON.stringify({
    base: BASE,
    build,
    importMap,
    blob,
    avmplusSource: avmplus ? `${AVMPLUS}/tree/${avmplus}` : AVMPLUS,
    avmplusCommit: avmplus ? avmplus.slice(0, 12) : "its default branch",
    mpl: mplFiles(),
    ruffle: ruffleFiles(),
  })};`;
  return {
    name: "swf2es-facts",
    resolveId: (name: string) => (name === id ? `\0${id}` : undefined),
    load: (name: string) => (name === `\0${id}` ? source : undefined),
  };
}
const guidePages = readGuide(root, BASE, blob);
const guide = guidePages.map(({ id }) => ({ slug: id }));

export default defineConfig({
  site: "https://swf2es.github.io",
  base: BASE,
  srcDir: "./astro",
  publicDir: "./dist/public",
  outDir: "./dist/site",
  vite: { plugins: [facts()] },
  // Compressed, a line's break before a link was dropped with the space it stood for.
  compressHTML: false,
  // The guide starts at its first section: docs/ itself is no page.
  redirects: { "/docs": `${BASE}${guidePages[0].id}/` },
  integrations: [
    starlight({
      title: "swf2es",
      description:
        "Play SWF files in the browser: swf2es compiles their ActionScript to JavaScript.",
      logo: { src: "./static/icon.svg" },
      favicon: "/icon.svg",
      head: [
        { tag: "link", attrs: { rel: "icon", href: `${BASE}favicon.ico`, sizes: "48x48" } },
        { tag: "link", attrs: { rel: "apple-touch-icon", href: `${BASE}apple-touch-icon.png` } },
      ],
      social: [{ icon: "github", label: "GitHub", href: REPOSITORY }],
      customCss: ["./astro/styles/site.css"],
      // astro/pages/404.astro, which needs no entry in the docs collection.
      disable404Route: true,
      components: { SocialIcons: "./astro/components/SocialIcons.astro" },
      sidebar: [
        { label: "Player", link: "/play/" },
        { label: "Guide", items: guide },
        { label: "Architecture", link: `${REPOSITORY}/blob/main/docs/architecture.md` },
        { label: "Licences", link: "/notices/" },
      ],
    }),
  ],
});

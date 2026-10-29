// The docs collection Starlight renders: the guide's pages, from
// docs/guide.md (guide.ts).

import { defineCollection } from "astro:content";
import { docsSchema } from "@astrojs/starlight/schema";
import { blob, root } from "../facts.ts";
import { guideLoader } from "../guide.ts";

export const collections = {
  docs: defineCollection({ loader: guideLoader({ root, blob }), schema: docsSchema() }),
};

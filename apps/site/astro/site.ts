// What the pages share: the path the site is served under (facts.ts's BASE,
// from SITE_BASE) and the facts of the build, from astro.config.ts.
import facts from "virtual:swf2es/facts";

export { facts };

/** The site's base path, with its slashes. */
export const base: string = facts.base;

/** A path under the site, as a link takes it. */
export const url = (path = "") => `${base}${path}`;

// What the pages share: the path the site is served under (facts.ts's BASE,
// from SITE_BASE), the facts of the build and the compatibility page's
// figures, from astro.config.ts.
import scores from "virtual:swf2es/compatibility";
import facts from "virtual:swf2es/facts";
import type { Compatibility } from "../compatibility.ts";

export { facts };

/** The compatibility page's figures, from compatibility.ts. */
export const compatibility: Compatibility = scores;

/** The site's base path, with its slashes. */
export const base: string = facts.base;

/** A path under the site, as a link takes it. */
export const url = (path = "") => `${base}${path}`;

/** The guide's first page, where its links lead rather than through docs/'s redirect. */
export const guide: string = url(`${facts.guide}/`);

// Where the bundle's other files lie, for a CDN that serves the main file
// at the package's own URL without redirecting to it, as jsDelivr's
// https://cdn.jsdelivr.net/npm/swf2es@0.1.0 does: under that URL's dist/,
// not beside it, where Rspack would look. Set before the modules that
// load them run; unpkg's package URL redirects to dist/swf2es.js, and a
// folder served as it is needs none of this either.
const url = new URL(import.meta.url);
url.search = "";
url.hash = "";
const path = url.pathname;
if (!path.endsWith(".js") && !path.endsWith("/")) {
  __webpack_public_path__ = `${url.href}/dist/`;
  // Chunks are imported by a path relative to this module's URL, not by the one above.
  const filename = __webpack_get_script_filename__;
  const name = path.slice(path.lastIndexOf("/") + 1);
  __webpack_get_script_filename__ = (chunk) => `${name}/dist/${filename(chunk)}`;
}

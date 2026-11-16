// The embedding parameters the desktop app gives a SWF: the <swf2es-player>
// element's attributes of these names, and no other. One list for the main
// process, which reads them from the command line, and the page, which sets
// only these on its element, whatever it is sent.

/** The element's parameters that act in the desktop app, by their lower-case names. */
export const EMBEDDING_PARAMS: readonly string[] = [
  "flashvars",
  "quality",
  "scale",
  "salign",
  "wmode",
  "bgcolor",
  "menu",
  "base",
  "allownetworking",
];

/** The attributes `params` sets on the element: those of EMBEDDING_PARAMS alone. */
export function embeddingAttributes(
  params: Readonly<Record<string, string>> = {},
): [name: string, value: string][] {
  return EMBEDDING_PARAMS.filter(
    (name) => Object.hasOwn(params, name) && typeof params[name] === "string",
  ).map((name) => [name, params[name]]);
}

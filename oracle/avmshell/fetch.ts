// Downloads the pinned avmshell build into oracle/avmshell/bin/.
// The swf2es/avmplus fork does not publish releases yet; until it does, build
// avmshell from https://github.com/adobe/avmplus and put the binary at
// oracle/avmshell/bin/avmshell.
const RELEASE: { tag: string; asset: string } | null = null; // e.g. { tag: "avmshell-2026.1", asset: "avmshell-linux-x64" }

if (!RELEASE) {
  console.error(
    "No pinned avmshell release yet: build it from adobe/avmplus and place it at oracle/avmshell/bin/avmshell.",
  );
  process.exit(1);
}

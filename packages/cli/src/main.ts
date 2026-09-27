#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { readSwfHeader } from "@swf2es/format";
import { COMPILER_VERSION } from "@swf2es/codegen";

const [file] = process.argv.slice(2);
if (!file || file === "--help" || file === "-h") {
  console.log("usage: swf2es <file.swf>\n\nswf2es " + COMPILER_VERSION + " (compilation is not implemented yet; prints the SWF header)");
  process.exit(file ? 0 : 1);
}
const header = readSwfHeader(new Uint8Array(await readFile(file)));
console.log(JSON.stringify({ file, ...header }));

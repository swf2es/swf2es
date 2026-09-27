// Package boundaries (see docs/architecture.md). Dependencies point one way:
//   format ← codegen ← cli
//   format, codegen, runtime ← player
// runtime depends on nothing; codegen never imports the runtime implementation.
const pkg = name => `^(packages/${name}/|@swf2es/${name}($|/))`;
const portable = "^packages/(format|codegen|runtime)/";

module.exports = {
  forbidden: [
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
    { name: "format-is-a-leaf", severity: "error",
      from: { path: "^packages/format/" }, to: { path: pkg("(codegen|runtime|player|cli)") } },
    { name: "runtime-is-a-leaf", severity: "error",
      from: { path: "^packages/runtime/" }, to: { path: pkg("(format|codegen|player|cli)") } },
    { name: "codegen-does-not-import-runtime", severity: "error",
      comment: "Generated code calls the runtime; the compiler itself must not.",
      from: { path: "^packages/codegen/" }, to: { path: pkg("(runtime|player|cli)") } },
    { name: "player-does-not-import-cli", severity: "error",
      from: { path: "^packages/player/" }, to: { path: pkg("cli") } },
    { name: "portable-packages-avoid-node", severity: "error",
      comment: "format, codegen and runtime run in browsers, workers and node alike.",
      from: { path: portable }, to: { dependencyTypes: ["core"] } },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)dist/" },
    tsConfig: { fileName: "tsconfig.base.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["types", "import", "default"] },
  },
};

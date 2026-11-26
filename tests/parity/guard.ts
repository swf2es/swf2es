// Imported first by the parity harness and the compile-time benchmark:
// SWF2ES_CODEGEN would swap this tree's test build for another copy as
// testing-module.ts loads, which the comparisons must not take for the
// candidate.
if (process.env.SWF2ES_CODEGEN) {
  console.log("SWF2ES_CODEGEN would swap the candidate's test build: unset it");
  process.exit(1);
}

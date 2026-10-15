// Slash paths (docs/avm1.md, "Clips and paths"): a clip's variables by
// `/a:x` and `a:x`, set by SetVariable, its properties by GetProperty and
// SetProperty, `..`, the root as `/`, and tellTarget of a slash path.
trace(eval("/a:x"));
__op("SetVariable", "/a:y", "why");
trace(eval("/a:y"));
trace(eval("a:y"));
__op("SetVariable", "/a/inner:z", 3);
trace(eval("/a/inner:z"));
trace(eval("../a:x"));
trace(getProperty("/a", 13));
trace(getProperty("a/inner", 11));
trace(getProperty("/a/inner", 4));
setProperty("/a", 0, 15);
trace(getProperty("/a", 0));
tellTarget ("/a/inner") {
  trace(getProperty("", 11));
  trace(eval("z"));
}
tellTarget ("/a") {
  gotoAndStop(2);
}
trace(getProperty("/a", 4));
trace(eval("/:q"));
__op("SetVariable", "/:q", "rootq");
trace(eval("/:q"));
trace(eval("q"));

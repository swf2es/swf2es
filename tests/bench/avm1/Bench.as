// What every AVM1 benchmark of tests/bench/players.ts starts with: bench()
// traces what a section's function returns, the work players are compared
// by, runs it a tenth of its rounds to warm up, then times its rounds by
// the Date, as the AS3 benchmarks do; done() tells the runner it is over.

function bench(name, rounds, f) {
  trace(name + " " + f());
  for (var w = 0; w < rounds / 10; w++) {
    f();
  }

  var started = new Date().getTime();
  for (var r = 0; r < rounds; r++) {
    f();
  }
  trace("time: " + name + " " + (new Date().getTime() - started));
}

function done() {
  trace("players: done");
}

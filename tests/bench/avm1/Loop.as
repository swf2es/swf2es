// Tight loops: int-like and Number arithmetic, and a string built by
// concatenation, each in a function, whose variables Flash's compiler keeps
// in registers, and the int loop again on the timeline, whose variables are
// the clip's, as an AS1 movie's frame script writes it.

function intArith() {
  var s = 0;
  for (var i = 0; i < 20000; i++) {
    s = (s + i * 3) % 1000003;
    s = (s ^ (i << 2)) & 0xfffff;
    s += i >> 3;
  }
  return s;
}

function numberArith() {
  var x = 1.5;
  var y = 0.25;
  for (var i = 0; i < 20000; i++) {
    x = x * 1.0001 + y;
    y = y / 1.5 + 0.125;
    if (x > 100000) {
      x = x / 7;
    }
  }
  return Math.floor(x * 1000) + " " + Math.floor(y * 1000000);
}

function mathCalls() {
  var s = 0;
  for (var i = 0; i < 5000; i++) {
    s += Math.floor(Math.sqrt(i) * 10) + Math.abs(i % 7 - 3) + Math.max(i & 3, 2) + Math.round(i / 3);
  }
  return s;
}

function stringConcat() {
  var s = "";
  for (var i = 0; i < 5000; i++) {
    s += "a" + (i % 10);
    if (s.length > 2000) {
      s = s.substr(1000);
    }
  }
  return s.length + " " + s.substr(0, 12);
}

bench("int-arith", 40, intArith);
bench("number-arith", 40, numberArith);
bench("math-calls", 40, mathCalls);
bench("string-concat", 40, stringConcat);

// The same int loop as intArith on the timeline: its variables are found by name on the clip.
ts = 0;
for (ti = 0; ti < 20000; ti++) {
  ts = (ts + ti * 3) % 1000003;
  ts = (ts ^ (ti << 2)) & 0xfffff;
  ts += ti >> 3;
}
trace("int-arith-timeline " + ts);
started = new Date().getTime();
for (tr = 0; tr < 10; tr++) {
  ts = 0;
  for (ti = 0; ti < 20000; ti++) {
    ts = (ts + ti * 3) % 1000003;
    ts = (ts ^ (ti << 2)) & 0xfffff;
    ts += ti >> 3;
  }
}
trace("time: int-arith-timeline " + (new Date().getTime() - started));

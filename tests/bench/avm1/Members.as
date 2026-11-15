// Members by name and by index: an object's named members read and
// written, members by a name held in a variable, an Array's elements read
// and written by index and grown by push, and for..in over an object.

var keys = [];
for (var k = 0; k < 16; k++) {
  keys.push("k" + k);
}

function objectNamed() {
  var o = { a: 1, b: 2, c: 3, d: 4 };
  for (var i = 0; i < 10000; i++) {
    o.a = o.b + o.c;
    o.b = o.d - o.a + i;
    o.c = (o.a + i) % 1000;
    o.d = o.c + 1;
  }
  return o.a + " " + o.b + " " + o.c + " " + o.d;
}

function objectKeyed() {
  var o = {};
  for (var j = 0; j < 16; j++) {
    o[keys[j]] = j;
  }

  var s = 0;
  for (var i = 0; i < 10000; i++) {
    var key = keys[i & 15];
    o[key] = o[key] + 1;
    s += o[keys[(i + 5) & 15]];
  }
  return s;
}

var numbers = [];
for (var n = 0; n < 1000; n++) {
  numbers.push(n);
}

function arrayRead() {
  var s = 0;
  var a = numbers;
  for (var r = 0; r < 10; r++) {
    for (var i = 0; i < a.length; i++) {
      s += a[i];
    }
  }
  return s;
}

function arrayWrite() {
  var a = numbers;
  for (var r = 0; r < 10; r++) {
    for (var i = 0; i < 1000; i++) {
      a[i] = (a[i] + r) % 1000;
    }
  }

  var s = 0;
  for (var j = 0; j < 1000; j++) {
    s += a[j];
  }
  return s;
}

function arrayPush() {
  var a = [];
  for (var i = 0; i < 5000; i++) {
    a.push(i * 2);
  }

  var s = 0;
  while (a.length > 2500) {
    s += a.pop();
  }
  return s + " " + a.length;
}

var bag = {};
for (var b = 0; b < 100; b++) {
  bag["p" + b] = b;
}

function forIn() {
  var s = 0;
  var count = 0;
  for (var r = 0; r < 20; r++) {
    for (var name in bag) {
      s += bag[name];
      count++;
    }
  }
  return s + " " + count;
}

bench("object-named", 40, objectNamed);
bench("object-keyed", 40, objectKeyed);
bench("array-read", 40, arrayRead);
bench("array-write", 40, arrayWrite);
bench("array-push-pop", 40, arrayPush);
bench("for-in", 100, forIn);

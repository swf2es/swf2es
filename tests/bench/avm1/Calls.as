// Calls: functions defined on the timeline, methods on prototypes as AS2's
// classes compile to them (a constructor in _global, Extends, super), an
// inherited method found up the chain, `new`, and Function's call.

function add(a, b) {
  return a + b;
}

function functionCalls() {
  var s = 0;
  for (var i = 0; i < 10000; i++) {
    s = add(s, i) % 100003;
  }
  return s;
}

_global.Point = function (x, y) {
  this.x = x;
  this.y = y;
};
Point.prototype.length2 = function () {
  return this.x * this.x + this.y * this.y;
};
Point.prototype.offset = function (dx, dy) {
  this.x += dx;
  this.y += dy;
};

_global.Point3 = function (x, y, z) {
  super(x, y);
  this.z = z;
};
__op("Extends", Point3, Point);
Point3.prototype.length2 = function () {
  return super.length2() + this.z * this.z;
};

function methodCalls() {
  var p = new Point(1, 2);
  var s = 0;
  for (var i = 0; i < 10000; i++) {
    p.offset(1, -1);
    s = (s + p.length2()) % 100003;
  }
  return s;
}

function inheritedCalls() {
  var p = new Point3(1, 2, 3);
  var s = 0;
  for (var i = 0; i < 5000; i++) {
    p.offset(i & 1, 1);
    s = (s + p.length2()) % 100003;
  }
  return s;
}

function construct() {
  var s = 0;
  for (var i = 0; i < 5000; i++) {
    var p = new Point3(i, i + 1, i & 7);
    s += p.z;
  }
  return s;
}

function scale(k) {
  return this.x * k;
}

function callApply() {
  var p = new Point(3, 4);
  var s = 0;
  for (var i = 0; i < 5000; i++) {
    s += scale.call(p, i & 3) + scale.apply(p, [1]);
  }
  return s;
}

bench("function-call", 40, functionCalls);
bench("method-call", 30, methodCalls);
bench("inherited-call", 40, inheritedCalls);
bench("construct", 40, construct);
bench("call-apply", 40, callApply);

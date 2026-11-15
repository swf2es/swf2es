// The scope chain: a function reading and writing the timeline's variables
// by name, `with` on an object and on a clip, paths through _root and
// _parent, and eval and set of dotted and slash paths.

count = 0;
step = 3;
limit = 100003;

function timelineVars() {
  for (var i = 0; i < 10000; i++) {
    count = (count + step + i) % limit;
  }
  return count;
}

function withObject() {
  var o = { a: 1, b: 2, c: 0 };
  var s = 0;
  for (var i = 0; i < 5000; i++) {
    with (o) {
      c = a + b + i;
      a = c % 97;
      s += c;
    }
  }
  return s;
}

createEmptyMovieClip("outer", 1);
outer.createEmptyMovieClip("inner", 1);
outer.v = 1;
outer.inner.v = 2;

function withClip() {
  var s = 0;
  for (var i = 0; i < 5000; i++) {
    with (outer.inner) {
      v = (v + i) % 1000;
      s += v;
    }
  }
  return s;
}

function rootPaths() {
  var s = 0;
  for (var i = 0; i < 5000; i++) {
    _root.outer.inner.v = (_root.outer.v + i) % 1000;
    s += _root.outer.inner.v;
  }
  return s;
}

// Called as the inner clip's method: `this` is the clip, its _parent the outer one.
outer.inner.parents = function () {
  var s = 0;
  for (var i = 0; i < 5000; i++) {
    this._parent.v = (this.v + i) % 1000;
    s += this._parent.v + this._parent._parent.count;
  }
  return s;
};

function parentPaths() {
  return outer.inner.parents();
}

function evalSet() {
  var s = 0;
  for (var i = 0; i < 3000; i++) {
    set("outer.inner.v", i % 500);
    s += eval("outer.inner.v");
    set("/outer:v", eval("/outer/inner:v") + 1);
    s += eval("_root.outer.v");
  }
  return s;
}

bench("timeline-vars", 40, timelineVars);
bench("with-object", 40, withObject);
bench("with-clip", 40, withClip);
bench("root-paths", 40, rootPaths);
bench("parent-paths", 40, parentPaths);
bench("eval-set", 40, evalSet);

// Clips made and removed by script: the library's "ball", a sprite of one
// shape, attached, a clip duplicated, and empty clips created, each placed
// and then removed again, as a game's bullets and particles come and go.

var proto = attachMovie("ball", "proto", 50000);

function attachRemove() {
  var s = 0;
  for (var i = 0; i < 300; i++) {
    var c = attachMovie("ball", "b" + i, i + 1);
    c._x = i % 100;
    c._y = i >> 2;
    s += c.getDepth();
  }

  for (var j = 0; j < 300; j++) {
    var b = _root["b" + j];
    s += b._x;
    b.removeMovieClip();
  }
  return s + " " + typeof _root.b0;
}

function duplicateRemove() {
  var s = 0;
  for (var i = 0; i < 300; i++) {
    var c = proto.duplicateMovieClip("d" + i, i + 1, { v: i });
    s += c.v;
  }

  for (var j = 0; j < 300; j++) {
    removeMovieClip("d" + j);
  }
  return s + " " + typeof _root.d0;
}

function createRemove() {
  var s = 0;
  for (var i = 0; i < 300; i++) {
    var c = createEmptyMovieClip("e" + i, i + 1);
    c._alpha = i % 100;
    s += c._alpha;
  }

  for (var j = 0; j < 300; j++) {
    _root["e" + j].removeMovieClip();
  }
  return s + " " + typeof _root.e0;
}

bench("attach-remove", 60, attachRemove);
bench("duplicate-remove", 60, duplicateRemove);
bench("create-remove", 60, createRemove);

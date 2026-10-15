// Clips as AS1 sees them (docs/avm1.md, "Clips and paths"): their type,
// names and paths, their properties as set and read, GetProperty and
// SetProperty, eval and SetVariable of paths, tellTarget, depths, bounds
// and points. The root is a main movie's _level0 in the player and a
// loaded one's in adl's harness, so nothing traces its dot path or name.
trace("typeof a: " + typeof a + ", " + typeof a.b + ", " + typeof this);
trace("targets: " + a._target + " " + a.b._target + " " + _target + " " + c._target);
trace("names: " + a._name + " " + a.b._name + " " + Beta._name);
trace("same: " + (a == _root.a) + " " + (a.b._parent == a) + " " + (a._parent == this) + " " + (_root == this));
trace("string: " + (String(a) == String(_root) + ".a") + " " + (a + "" == targetPath(a)));
trace("number: " + Number(a) + " " + (a < 1) + " " + (a > 1));
trace("case: " + typeof A + " " + typeof beta + " " + typeof BETA + " " + typeof a.B);
trace("frames: " + a._currentframe + " " + a._totalframes + " " + a._framesloaded + " " + _currentframe + " " + _totalframes);
trace("x: " + a._x + " " + a._y + " " + c._x);
a._x = 12.34; a._y = -7.789;
trace("x set: " + a._x + " " + a._y);
a._x = "40"; a._y = undefined; a._x = NaN;
trace("x again: " + a._x + " " + a._y);
a._xscale = 150; a._yscale = 33.3333;
trace("scale: " + a._xscale + " " + a._yscale + " " + a._width + " " + a._height);
a._rotation = 270;
trace("rotation: " + a._rotation + " " + a._width + " " + a._height);
a._rotation = -190;
trace("rotation: " + a._rotation);
a._rotation = 0; a._xscale = 100; a._yscale = 100;
a._width = 50;
trace("width: " + a._width + " " + a._xscale + " " + a._height + " " + a._yscale);
a._height = 10;
trace("height: " + a._height + " " + a._yscale);
a._width = -5;
trace("width: " + a._width);
a._xscale = 100; a._yscale = 100;
a._alpha = 33;
trace("alpha: " + a._alpha);
a._alpha = 150;
trace("alpha: " + a._alpha);
a._alpha = 100;
a._visible = 0;
trace("visible: " + a._visible);
a._visible = "x";
trace("visible: " + a._visible);
a._visible = true;
trace("visible: " + a._visible);
trace("quality: " + a._quality + " " + a._highquality + " " + typeof a._focusrect + " " + a._soundbuftime);
trace("droptarget: " + typeof a._droptarget);
trace("own: " + a.hasOwnProperty("_x"));
for (var k in a) { trace("key " + k); }
trace("getProperty: " + getProperty("a", 0) + " " + getProperty("/a/b", 13) + " " + getProperty("a", 11) + " " + getProperty("", 11) + " " + getProperty("nothing", 0));
setProperty("a", 0, 20);
setProperty("/a", 2, 200);
trace("setProperty: " + a._x + " " + a._xscale);
setProperty("a", 2, 100);
setProperty("a", 4, 5);
trace("read-only: " + a._currentframe);
trace("eval: " + typeof eval("a") + " " + eval("/a/b")._name + " " + eval("a.b")._name + " " + eval("a:v"));
a.v = "variable";
trace("vars: " + eval("a:v") + " " + eval("/a:v") + " " + eval("a.v"));
__op("SetVariable", "a:w", "set by path");
trace("set: " + a.w);
tellTarget ("a") {
  trace("tell: " + _name + " " + _target + " " + v + " " + getProperty("", 13));
  // From the code's own clip, the root, which has no b: no target.
  tellTarget ("b") {
    trace("nested tell: " + _target);
  }
}
tellTarget ("a/b") {
  trace("slash tell: " + _target);
}
tellTarget ("nowhere") {
  trace("no target: " + typeof _name);
}
var t = a.b;
tellTarget (t) {
  trace("tell object: " + _target);
}
trace("back: " + _target);
trace("depth: " + a.getDepth() + " " + c.getDepth() + " " + Beta.getDepth());
a.swapDepths(c);
trace("swapped: " + a.getDepth() + " " + c.getDepth());
a.swapDepths(-16380);
trace("swapped: " + a.getDepth());
for (var k in this) { trace("root key " + k); }
var p = {x: 5, y: 5};
a.localToGlobal(p);
trace("local to global: " + p.x + " " + p.y);
a.globalToLocal(p);
trace("global to local: " + p.x + " " + p.y);
var r = a.getBounds();
trace("bounds: " + r.xMin + " " + r.xMax + " " + r.yMin + " " + r.yMax);
r = a.getBounds(this);
trace("bounds: " + r.xMin + " " + r.xMax + " " + r.yMin + " " + r.yMax);
trace("hit: " + a.hitTest(25, 15) + " " + a.hitTest(5, 5) + " " + a.hitTest(c) + " " + c.hitTest(Beta));
trace("version: " + a.getSWFVersion());
trace("loaded: " + (a.getBytesLoaded() == a.getBytesTotal()));

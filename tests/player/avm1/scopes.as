// Functions of clips (docs/avm1.md, "Clips and paths"): what they find as
// they run, called on their clip, by name from the root, from tellTarget
// and with, and a root's function set on a clip.
var where = "root";
trace(a.f()._name);
trace(a.kid.who());
var g = a.f;
g();
var h = a.kid.who;
trace(h());
tellTarget ("a") {
  trace("in tell " + where + " " + typeof f);
  var k = f();
  trace(k._target);
}
with (a) {
  trace("in with " + where + " " + _target + " " + kid._name);
}
function rootf() {
  return _target + " " + where;
}
a.rf = rootf;
trace(a.rf());
tellTarget ("a/kid") {
  trace(rootf());
}
trace(a.kid._parent._parent._target);
trace(a._root._target);
trace(a.kid._root == _root);

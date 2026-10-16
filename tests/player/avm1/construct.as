// Clips made with a registered class (docs/avm1.md, "Clip events"): a
// timeline's clip, constructed by the queue, its initialize events first;
// clips a script makes, duplicateMovieClip's, attachMovie's and
// createEmptyMovieClip's, constructed at once, their init objects' properties
// set before the construct events up to SWF 6 and after them from 7, then
// their onConstruct; their initialize events queued, run as a function of
// the SWF's returns.
trace("root 1 " + a.hello() + " " + a.q + " " + typeof a.kid);
function f() { trace("in f"); }
var d = a.duplicateMovieClip("d", 5, { p: 7 });
trace("dup " + d.q + " " + d.p + " " + typeof d.hello);
f();
trace("after f");
var m = attachMovie("clip", "m", 6, { p: 8 });
trace("att " + m.q + " " + m.p + " " + typeof m.kid);
var o = new Object();
trace("after new");
MovieClip.prototype.onConstruct = function () { trace("onConstruct " + this._name); };
Object.registerClass("clip", null);
var n = attachMovie("clip", "n", 7, { p: 9 });
trace("unregistered " + n.q + " " + typeof n.hello);
trace("register " + Object.registerClass("clip") + " " + Object.registerClass("clip", 3) + " " + Object.registerClass("clip", undefined));
var e = createEmptyMovieClip("e", 8);
trace("empty " + e._name + " " + e.getDepth() + " " + e._totalframes);
var x = a.duplicateMovieClip("x", 9);
delete MovieClip.prototype.onConstruct;
trace("root 1 end");

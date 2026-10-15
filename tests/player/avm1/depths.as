// Clips a script makes and removes, by depth (docs/avm1.md, "Clip events"):
// attachMovie's and duplicateMovieClip's ranges of depths, removeMovieClip
// of the timeline's clips, which only a swap to a script's depth makes
// removable, swapDepths by depth, name and clip, getNextHighestDepth and
// getInstanceAtDepth, and the global functions' CloneSprite and RemoveSprite.
function named(c) { return c == undefined ? "none" : c._name; }
var lo = attachMovie("clip", "lo", -16384);
var below = attachMovie("clip", "below", -16385);
var hi = attachMovie("clip", "hi", 2130690044);
var over = attachMovie("clip", "over", 2130690045);
var none = attachMovie("nothing", "none", 3);
trace("attach " + named(lo) + " " + named(below) + " " + named(hi) + " " + named(over) + " " + named(none));
trace("depths " + lo.getDepth() + " " + hi.getDepth() + " " + a.getDepth());
lo.removeMovieClip();
hi.removeMovieClip();
trace("removed " + typeof lo + " " + typeof hi + " " + typeof _root.lo + " " + typeof _root.hi);
a.removeMovieClip();
trace("timeline " + typeof _root.a + " " + a.getDepth());
a.swapDepths(10);
trace("swapped " + a.getDepth());
a.removeMovieClip();
trace("removed a " + typeof _root.a);
var c1 = attachMovie("clip", "c1", 1);
var c2 = attachMovie("clip", "c2", 2);
c1.swapDepths("c2");
trace("by name " + c1.getDepth() + " " + c2.getDepth());
c1.swapDepths(c2);
trace("by clip " + c1.getDepth() + " " + c2.getDepth());
c1.swapDepths(5);
c1.swapDepths(undefined);
c1.swapDepths(-16385);
trace("by depth " + c1.getDepth());
var r = c2.duplicateMovieClip("r", 20);
trace("duplicate " + typeof r + " " + typeof _root.r + " " + _root.r.getDepth());
var r2 = c2.duplicateMovieClip("r2", -16385);
var r3 = _root.duplicateMovieClip("r3", 30);
trace("not duplicated " + typeof _root.r2 + " " + typeof _root.r3);
duplicateMovieClip("c2", "g", 40);
trace("global " + typeof _root.g + " " + _root.g.getDepth());
removeMovieClip("g");
removeMovieClip(c2);
trace("global removed " + typeof _root.g + " " + typeof _root.c2);
var z = attachMovie("clip", "z", 5);
var y = attachMovie("clip", "y", 5);
trace("replaced " + typeof _root.z + " " + typeof _root.y + " " + _root.y.getDepth());

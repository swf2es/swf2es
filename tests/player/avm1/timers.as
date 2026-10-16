// setTimeout and setInterval (docs/avm1.md, "Time"), at 2 frames a second:
// the timers fire between frames, the earliest first, each with its
// arguments; a method's by its name on its object; a timeout once, an
// interval until it is cleared, by itself too; none without a function
// or an interval. Those of a frame or less fire before the next frame;
// the later ones, whose frame depends on the host's timing, write to a log
// the last frame traces. getTimer goes on, and never back.
var t0 = getTimer();
var later = [];
var log = function (s) { trace(s + " " + _currentframe); };
var a = setTimeout(log, 0, "timeout 0");
var b = setTimeout(function (x, y) { log("timeout 1 " + x + y); }, 1, "x", "y");
var c = setTimeout(function (s) { later.push(s); }, 1250, "timeout 1250");
var n = 0;
var o = { tick: function (s) { n++; later.push("tick " + s + " " + n + " " + (this == o)); if (n == 2) { clearInterval(id); } } };
var id = setInterval(o, "tick", 700, "s");
var gone = setTimeout(log, 10, "cleared");
clearTimeout(gone);
trace("ids " + (b - a) + " " + (c - b) + " " + (id - c));
trace("none " + typeof setInterval() + " " + typeof setInterval(undefined, 10) + " " + typeof setTimeout(o, "tick") + " " + typeof setTimeout(log));
trace("time " + typeof t0 + " " + (getTimer() >= t0));
_root.onEnterFrame = function () { trace("enterFrame " + _currentframe + " " + (getTimer() >= t0)); };

// Gotos on clips, by frame and by label, from frame 1 of the root, which
// queue the frames they enter, in Flash's order (docs/avm1.md, "The frame").
trace("root 1 start");
a.gotoAndStop(3);
trace("after goto: " + a._currentframe + " " + typeof a.leaf);
a.gotoAndStop("middle");
trace("label: " + a._currentframe);
a.nextFrame();
trace("next: " + a._currentframe);
a.prevFrame();
a.prevFrame();
trace("prev: " + a._currentframe);
a.gotoAndStop(0);
trace("zero: " + a._currentframe);
a.gotoAndStop(99);
trace("past: " + a._currentframe);
a.gotoAndStop("nolabel");
trace("no label: " + a._currentframe);
a.gotoAndStop("2");
trace("string: " + a._currentframe);
a.gotoAndStop("b:start");
trace("path label: " + a._currentframe + " " + b._currentframe);
tellTarget ("b") {
  gotoAndStop(3);
  trace("told: " + _currentframe);
  nextFrame();
  prevFrame();
  gotoAndPlay("Middle");
}
tellTarget ("b") {
  var f = 1;
  gotoAndStop(f + 1);
  trace("goto2: " + _currentframe);
  gotoAndStop("Start");
}
tellTarget ("b") {
  ifFrameLoaded (2) {
    trace("loaded 2");
  }
  ifFrameLoaded (20000) {
    trace("loaded 20000");
  }
}
b.play();
call("a:start");
c.gotoAndPlay(3);
trace("root 1 end");

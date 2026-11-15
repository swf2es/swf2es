// onEnterFrame on many clips, timed over frames: each of COUNT clips of the
// library's "ball" runs a handler of its own every frame, in phases of
// FRAMES frames each. The first, a handler that only counts, is a warm-up
// and is not timed: it takes the first drawing of the clips, and Flash
// runs it at its frame rate's pace. Then one that moves the clip's
// position, rotation and alpha in its own variables (the script), and one
// that also sets _x, _y, _rotation and _alpha from them (the script, the
// display's properties and the drawing of what moved). A clip on top of
// them keeps the time; each clip counts its own calls and stops after
// FRAMES, so every player does the same work whichever order it calls the
// clips' handlers in. The movie's frame rate, 255, is above what a frame of
// this work takes in Flash, so its frames follow each other at once.

var COUNT = 2000;
var FRAMES = 30;
var clips = [];
for (var i = 0; i < COUNT; i++) {
  var c = attachMovie("ball", "m" + i, i + 1);
  c.px = (i * 37) % 400;
  c.py = (i * 91) % 300;
  c.vx = (i % 7) - 3;
  c.vy = (i % 5) - 2;
  c.r = i % 360;
  c.a = i % 100;
  clips.push(c);
}

function count() {
  this.n++;
  if (this.n >= FRAMES) {
    delete this.onEnterFrame;
  }
}

function step() {
  this.px += this.vx;
  if (this.px < 0 || this.px > 400) {
    this.vx = -this.vx;
  }

  this.py += this.vy;
  if (this.py < 0 || this.py > 300) {
    this.vy = -this.vy;
  }

  this.r = (this.r + 7) % 360;
  this.a = (this.a + 3) % 100;
}

function think() {
  step.call(this);
  this.n++;
  if (this.n >= FRAMES) {
    delete this.onEnterFrame;
  }
}

function move() {
  step.call(this);
  this._x = this.px;
  this._y = this.py;
  this._rotation = this.r;
  this._alpha = this.a;
  this.n++;
  if (this.n >= FRAMES) {
    delete this.onEnterFrame;
  }
}

var phases = [[null, count], ["enterframe-script", think], ["enterframe-display", move]];
var phase = -1;
var ticks = 0;
var started = 0;

function begin(handler) {
  for (var j = 0; j < COUNT; j++) {
    clips[j].n = 0;
    clips[j].onEnterFrame = handler;
  }
  ticks = 0;
  started = new Date().getTime();
}

function sum() {
  var s = 0;
  for (var j = 0; j < COUNT; j++) {
    var m = clips[j];
    s += m.n + m.px + m.py + m.r + m.a + Math.round(m._x) + Math.round(m._y) + Math.round(m._rotation) + Math.round(m._alpha);
  }
  return s;
}

// FRAMES and one frame after a phase began, every clip has run its FRAMES calls.
var clock = createEmptyMovieClip("clock", COUNT + 10);
clock.onEnterFrame = function () {
  ticks++;
  if (phase >= 0 && ticks <= FRAMES) {
    return;
  }

  if (phase >= 0 && phases[phase][0] != null) {
    var ms = new Date().getTime() - started;
    trace(phases[phase][0] + " " + sum());
    trace("time: " + phases[phase][0] + " " + ms);
  }

  phase++;
  if (phase < phases.length) {
    begin(phases[phase][1]);
  } else {
    delete this.onEnterFrame;
    done();
  }
};
stop();

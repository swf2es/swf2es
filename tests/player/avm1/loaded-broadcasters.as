// The player's broadcasters, Key, Mouse, Selection, Stage and System.IME,
// made for a SWF 5 movie: their listener functions are hidden from it,
// but there, as clearing their flags shows, and the SWF 6, 7 and 8 movies
// it loads (loaded-broadcasters-child.as), one after another, call them.
function kinds(who) {
  var names = ["Key", "Mouse", "Selection", "Stage"];
  var s = [];
  for (var i = 0; i < names.length; i++) {
    var o = eval(names[i]);
    s.push(names[i] + ":" + typeof o.addListener + "/" + typeof o.removeListener + "/" + typeof o.broadcastMessage + "/" + typeof o._listeners);
  }
  s.push("IME:" + typeof System.IME.addListener + "/" + typeof System.IME._listeners);
  trace(who + " " + s.join(" "));
}
kinds("swf5");
ASSetPropFlags(Mouse, null, 0, 65535);
trace("swf5 revealed " + typeof Mouse.addListener + " " + Mouse._listeners.length + " " + typeof Mouse._listeners.push);
var versions = [6, 7, 8];
function next() {
  if (versions.length > 0) {
    var v = versions.shift();
    loadMovie("loaded-broadcasters-" + v + ".swf", "_root.clip" + v);
  }
}
next();

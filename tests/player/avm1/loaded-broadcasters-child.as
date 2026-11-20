// A movie a SWF 5 movie loads (loaded-broadcasters.as), of the SWF version
// `swf` holds: the player's broadcasters as it sees them, Key's and
// Mouse's listener functions called, and what the player itself sends to
// its listeners. It then has the next one loaded.
// Its own kinds: _root's, a SWF 5 function, would see what SWF 5 sees.
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
kinds("swf" + swf);
var listener = {};
listener.onPing = function(a) {
  trace("swf" + swf + " pinged " + a);
};
trace("swf" + swf + " added " + Key.addListener(listener) + " " + Key._listeners.length + " " + (Key.addListener == AsBroadcaster.addListener));
trace("swf" + swf + " removed " + Key.removeListener(listener) + " " + Key._listeners.length);
Mouse.addListener(listener);
trace("swf" + swf + " broadcast " + Mouse.broadcastMessage("onPing", swf));
Mouse.removeListener(listener);
// What the player sends: its text field is its own first listener, Selection
// tells of the focus, and from SWF 7 a MovieClipLoader of its load.
this.createTextField("field", 1, 0, 0, 20, 10);
trace("swf" + swf + " field " + field._listeners.length + " " + (field._listeners[0] == field));
// Selection from SWF 6 alone: Flash keeps one Selection for SWF 6 and
// another for SWF 7 and 8, each told, which the player does not yet.
if (swf == 6) {
  var focus = {};
  focus.onSetFocus = function(from, to) {
    // By name: the harness Flash runs in puts its own clips in a path.
    trace("swf" + swf + " onSetFocus " + from + " " + to._name);
    Selection.removeListener(focus);
  };
  Selection.addListener(focus);
  Selection.setFocus(field);
}
if (swf >= 7) {
  var loader = new MovieClipLoader();
  var watcher = {};
  watcher.onLoadStart = function(target) {
    trace("swf" + swf + " onLoadStart " + target._name);
  };
  watcher.onLoadInit = function(target) {
    trace("swf" + swf + " onLoadInit " + target._name);
    _root.next();
  };
  loader.addListener(watcher);
  this.createEmptyMovieClip("holder", 2);
  loader.loadClip("loaded-broadcasters-empty.swf", holder);
} else {
  _root.next();
}

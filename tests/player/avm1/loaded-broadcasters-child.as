// A movie a SWF 5 movie loads (loaded-broadcasters.as), of the SWF version
// `swf` holds: the player's broadcasters as it sees them, and Key's and
// Mouse's listener functions called. It then has the next one loaded.
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
_root.next();

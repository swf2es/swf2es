// MovieClipLoader by version: a class of SWF 7, which a SWF of 5 or 6 sees,
// and an instance's _listeners, but nothing of its prototype: neither its
// members, its constructor nor its __proto__, so neither Object's methods,
// until ASSetPropFlags clears their flags (0x400, and 0x80 for SWF 5).
var names = ["loadClip", "getProgress", "unloadClip", "addListener", "removeListener", "broadcastMessage", "_listeners", "constructor", "toString", "hasOwnProperty"];
function kinds(label, o) {
	var s = [];
	for (var i = 0; i < names.length; i++) {
		s.push(names[i] + ":" + typeof o[names[i]]);
	}
	trace(label + " " + s.join(" "));
}
trace("class " + typeof MovieClipLoader);
var m = new MovieClipLoader();
trace("instance " + typeof m + " " + (m instanceof MovieClipLoader) + " " + (m.__proto__ == MovieClipLoader.prototype) + " " + typeof MovieClipLoader.prototype.__proto__);
kinds("instance", m);
kinds("prototype", MovieClipLoader.prototype);
trace("loadClip " + m.loadClip() + " " + m.getProgress() + " " + m.unloadClip());
trace("listeners " + typeof m._listeners + " " + m._listeners.length + " " + (m._listeners[0] === m));
var e = [];
for (var k in m) {
	e.push(k);
}
trace("enumerated " + e.join(","));
ASSetPropFlags(MovieClipLoader.prototype, null, 0, 0x400);
kinds("cleared 0x400", m);
ASSetPropFlags(MovieClipLoader.prototype, null, 0, 0x480);
kinds("cleared 0x480", m);
trace("listener " + m.addListener({}) + " " + m._listeners.length + " " + m.broadcastMessage("onNothing"));

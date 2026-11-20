// NetConnection's local connection and a NetStream on it, by version: what
// connect gives, and a stream that plays nothing, whose state the first
// such stream adds to NetStream's prototype as enumerable getters, which
// a stream made without a connection reads as undefined. Flash keeps the
// getters for the player, past this movie: the case runs alone.
function en(name, o) {
  var s = [];
  for (var k in o) {
    s.push(k);
  }
  s.sort();
  trace(name + " enumerates " + s.join(" "));
}
trace("types " + typeof NetConnection + " " + typeof NetConnection.prototype.connect + " " + typeof NetStream);
var plain = new NetStream();
var remote = new NetConnection();
trace("remote " + remote.connect("http://127.0.0.1:9/gateway") + " " + remote.isConnected);
remote.close();
var connection = new NetConnection();
trace("connect " + connection.connect(null) + " " + connection.isConnected);
en("before", NetStream.prototype);
var unconnected = new NetStream(remote);
en("unconnected", NetStream.prototype);
var stream = new NetStream(connection);
var values = ["audiocodec", "bufferLength", "bufferTime", "bytesLoaded", "bytesTotal", "checkPolicyFile", "currentFps", "decodedFrames", "liveDelay", "time", "videocodec"];
var s = "";
for (var i = 0; i < values.length; i++) {
  s += values[i] + "=" + stream[values[i]] + "," + unconnected[values[i]] + " ";
}
trace("values " + s);
trace("buffer " + stream.setBufferTime(2) + " " + stream.bufferTime + " " + plain.setBufferTime(2) + " " + plain.bufferTime + " " + stream.hasOwnProperty("time") + " " + NetStream.prototype.hasOwnProperty("time"));
stream.bufferTime = 5;
trace("written " + stream.bufferTime);
en("after", NetStream.prototype);
// What connect takes: nothing connects nothing; undefined, up to SWF 6,
// neither; an RTMP URL fails at the frame's end, where a stream made on it
// meanwhile has a stream's state; anything else neither connects nor fails.
function told(name, connection) {
  connection.onStatus = function(info) {
    trace(name + " status " + info.code + " " + info.level + " " + connection.isConnected + " " + connection.uri);
  };
  return connection;
}
var none = told("none", new NetConnection());
trace("none " + none.connect() + " " + none.isConnected + " " + none.uri);
var absent = told("undefined", new NetConnection());
trace("undefined " + absent.connect(undefined) + " " + absent.isConnected + " " + absent.uri);
var rtmp = told("rtmp", new NetConnection());
trace("rtmp " + rtmp.connect("rtmp://127.0.0.1:9/x") + " " + rtmp.isConnected + " " + rtmp.uri);
var pending = new NetStream(rtmp);
trace("pending " + pending.time + " " + pending.audiocodec);
var junk = told("junk", new NetConnection());
trace("junk " + junk.connect("junk") + " " + junk.isConnected + " " + junk.uri + " " + new NetStream(junk).time);
var five = told("five", new NetConnection());
trace("five " + five.connect(5) + " " + five.uri);

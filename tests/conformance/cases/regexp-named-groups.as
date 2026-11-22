var url:RegExp = /((?P<host>[^\/]+) \/\/)? (?P<path>[^?]+) (\? (?P<query>.*))?/x;
var relative:String = "images/logo.jpg";
var m:Array = url.exec(relative);
trace(m.path, m.path.lastIndexOf("/"), m.hasOwnProperty("host"), m.host === "", m[2] === undefined);
trace(m.hasOwnProperty("query"), m.query === "", m[5] === undefined);

m = "cdn//a.jpg?v=1".match(url);
trace(m.host, m.path, m.query, m.index, m.input);
trace(relative.match("(?P<file>.+)").file, new RegExp(url).exec(relative).path);

// The P spelling enables named properties for the whole expression.
trace(new RegExp("(?<path>a)").exec("a").hasOwnProperty("path"));
m = new RegExp("(?P<a>a)(?<b>b)").exec("ab");
trace(m.a, m.b, m[1], m[2]);

// Captures are assigned after index and input, through the Array's properties.
m = /(?P<length>2)(?P<index>x)(?P<input>y)/.exec("2xy");
trace(m.length, m.index, m.input, m[1], m[2]);

var words:RegExp = /(?P<word>\w+)/g;
trace(words.exec("aa b").word, words.exec("aa b").word, words.exec("aa b"));
m = "aa b".match(words);
trace(m.join(","), m.hasOwnProperty("word"));
m = "02".match(/(?P<length>\d)/g);
trace(m.length, m[0] === undefined, m[1]);
Array.prototype[0] = "inherited";
trace("0".match(/(?P<length>0)/g)[0]);
delete Array.prototype[0];

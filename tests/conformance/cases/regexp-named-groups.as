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

// Later repetitions can retain a capture from an earlier branch. Entering a
// lower-numbered capturing group clears the higher slots; a failed branch rolls back.
m = /(?:(?P<word>a)|b)+/.exec("ab");
trace(m.word, m[1], "ab".match(/(?:(?P<word>a)|b)+/).word);
trace("3b".match(/(?:(?P<length>3)|b)+/g)[0]);
trace(/^(?:(b)|(?P<word>a))+$/.exec("ab").word === "");
trace(/^(?:(?P<word>a)|a(b)?)+$/.exec("ab").word === "");
var backref:RegExp = /^(?:(?P<word>a)|b)+c(?P=word)$/;
trace(backref.test("abca"), backref.test("abc"));
trace(new RegExp(backref).exec("abca").word, "x".match("(?P<bad>") === null);
trace("abc".match(/a(?P<0>b)c/g)[0]);

// The shell counts characters in global match positions, including astral text.
var repeated:RegExp = /(?:(?P<word>a)|b)+/g;
var astral:String = "\uD83D\uDE00ab\uD83D\uDE00ab";
m = repeated.exec(astral);
trace(m.index, repeated.lastIndex, m.input === astral);
m = repeated.exec(astral);
trace(m.index, repeated.lastIndex, m.word);
trace(astral.match(repeated).join("/"));
var empty:RegExp = /(?P<a>)/g;
empty.lastIndex = 2;
trace(empty.exec("\uD83D\uDE00") === null, empty.lastIndex);
var nul:String = String.fromCharCode(0);
m = new RegExp("(?<pre>a)" + nul + "(?P<post>b)").exec("a");
trace(m[1], m.hasOwnProperty("pre"), m.hasOwnProperty("post"));
var duplicates:RegExp = new RegExp("(?J)(?P<length>0)(?P<length>3)", "g");
m = duplicates.exec("03");
trace(m.length, m.hasOwnProperty("0"), m.hasOwnProperty("1"), "03".match(duplicates)[0]);
empty.lastIndex = 2;
m = empty.exec("é");
trace(m.index, empty.lastIndex);
var high:String = String.fromCharCode(0xD800);
var low:String = String.fromCharCode(0xDC00);
var unit:RegExp = /(?P<unit>.)/g;
trace(("ab" + high).match(unit).length, ("a" + high + "bc").match(unit).join("/"));
trace(low.match(unit)[0] === "\uFFFD", new RegExp("(?P<unit>" + high + ")").test("\uFFFD"));
// PCRE can report a match with no numbered slots when its vector fills up.
var crowded:RegExp = new RegExp("(?P<word>a)" + new Array(35).join("(b)"), "g");
Array.prototype[0] = "inherited";
trace(("a" + new Array(35).join("b")).match(crowded)[0]);
delete Array.prototype[0];

// Strings, names and regular expressions past ASCII, which the compiled
// module holds as \u escapes: each must still read as the characters the
// ABC's UTF-8 spells, as constants, as names of classes, methods,
// properties and namespaces, and as patterns.
import avmplus.getQualifiedClassName;

namespace 名前 = "urn:日本語:é";

class Ünïcödé
{
	public var größe:int = 3;
	名前 var 値:String = "あ";

	public function grüßen(wer:String):String
	{
		return "Grüß " + wer + " €";
	}

	public function get ŝtato():String
	{
		return "ĉarma";
	}
}

function codes(s:String):String
{
	const out:Array = [];
	for (var i:int = 0; i < s.length; i++)
	{
		out.push(s.charCodeAt(i).toString(16));
	}
	return s.length + " " + out.join(",");
}

const constants:Array = [
		"é", // Latin-1
		"€ ₿ 日本語", // the Basic Multilingual Plane
		"", // the private use area
		"😀 𝄞", // past U+FFFF, two code units each
		"a\u2028b\u2029c", // line separators, from escapes
		"\"é\\\n\"", // quotes, a backslash and a line feed among them
	];
for (var i:int = 0; i < constants.length; i++)
{
	trace(codes(constants[i]));
}
trace(constants[0] + constants[1] == "é€ ₿ 日本語");
trace("é" < "€", "€" < "😀", "Z" < "é");

const u:Ünïcödé = new Ünïcödé();
trace(getQualifiedClassName(u));
trace(u.größe, u.grüßen("Jürgen"), u.ŝtato, u.名前::値);
trace(codes(u.grüßen("")));

const o:Object = {};
o["ключ"] = 1;
o.αβγ = 2;
o["😀"] = 3;
trace(o.ключ, o["αβγ"], o["😀"], o.hasOwnProperty("ключ"), "αβγ" in o, o["αβ"]);
const keys:Array = [];
for (var k:String in o)
{
	keys.push(k);
}
keys.sort();
trace(escape(keys.join(" ")));

switch (constants[0])
{
	case "e":
		trace("ascii");
		break;
	case "é":
		trace("latin-1");
		break;
}

trace(/é+/.test("ééé"), /é+/.exec("xééy")[0], /é+/.source);
trace("日本語 日本".replace(/日本/g, "にほん"));
trace(/[€-₿]/.test("₹"), /[€-₿]/.test("$"));
trace(/😀/.test("a😀b"), "a😀b".search(/😀/), "a😀b".split(/😀/).join("|"));
trace(new RegExp("ü").test("Grüße"), new RegExp("\u00fc").source == "ü");
trace(escape("é€😀"), unescape("%E9%u20AC"), encodeURIComponent("é€😀"));

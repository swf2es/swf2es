// Entity and character references in XML text and attribute values, as
// avmplus' XMLParser decodes them: the known entities, decimal and hex
// references up to 0xFFFF, and what it keeps as written, an & with no ;
// in its value and an unknown name, including where a ; or an & comes only
// after the value ends.
function show(label:String, s:String):void
{
	var codes:Array = [];
	for (var i:int = 0; i < s.length; i++)
	{
		codes.push(s.charCodeAt(i));
	}
	trace(label, s.length, codes.join(","));
}

var known:XML = new XML("<a>&amp;&lt;&gt;&quot;&apos;&nbsp;</a>");
show("known", known.toString());

var numeric:XML = new XML("<a>&#65;&#x42;&#X43;&#xffff;&#x10000;&#65536;&#0;</a>");
show("numeric", numeric.toString());

var odd:XML = new XML("<a>&;&#;&#x;&bogus;&AMP;&ampx;x&</a>");
show("odd", odd.toString());

// A ; after the value, in the next tag's text, is not the value's.
var split:XML = new XML("<r><a>one&amp</a><b>two;</b></r>");
show("split a", split.a.toString());
show("split b", split.b.toString());

var attributes:XML = new XML('<a v="x&amp;y" w="p&q" z="&#x41;&lt;" e="" s="tail&"/>');
show("attr v", attributes.@v.toString());
show("attr w", attributes.@w.toString());
show("attr z", attributes.@z.toString());
show("attr e", attributes.@e.toString());
show("attr s", attributes.@s.toString());

// An & in a later value, past a value with none.
var later:XML = new XML('<r><a k="plain">plain text</a><b k="a&amp;b">c&lt;d</b></r>');
show("later a", later.a.toString() + "|" + later.a.@k);
show("later b", later.b.toString() + "|" + later.b.@k);

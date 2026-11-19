// Fields in Probe scrolled sideways, down and both, by script and by an
// input field's caret: what getCharBoundaries, getLineIndexOfChar,
// getCharIndexAtPoint and getLineIndexAtPoint give for each, which lines
// getCharBoundaries culls as a field grows, and how far fields ending in a
// newline scroll, as adl gives them.
package
{
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.geom.Rectangle;
	import flash.text.TextField;
	import flash.text.TextFieldType;
	import flash.text.TextFormat;

	public class TextScrollHits extends Sprite
	{
		private static const WIDE:String = "aaaaaaaaaabbbbbbbbbb";
		private static const TALL:String = "ab\nba\naab\nbba\nab\nba\nccc\nab";

		private var _fields:Array = [];
		private var _labels:Array = [];
		private var _input:TextField;
		private var _frames:int = 0;

		public function TextScrollHits()
		{
			const sideways:TextField = field(WIDE, 10, 10, 60, 30, false);
			sideways.scrollH = 25;
			keep("sideways", sideways);

			const down:TextField = field(TALL, 90, 10, 60, 50, true);
			down.scrollV = 3;
			keep("down", down);

			const both:TextField = field(WIDE + "\n" + WIDE + "\nab\n" + WIDE + "\nba", 170, 10, 60, 50, true);
			both.scrollV = 2;
			both.scrollH = 30;
			keep("both", both);

			// Built as the corpus's edittext_getcharboundaries_scroll builds it, scrollH set first.
			const appended:TextField = field("", 250, 10, 60, 50, true);
			for (var i:int = 0; i < 5; i++)
			{
				appended.text += "aaaaaaaaaaaaaaaa\n";
			}

			appended.scrollH = 20;
			appended.scrollV = 2;
			keep("appended", appended);

			const plain:TextField = field(WIDE, 10, 120, 60, 30, false);
			runs("plain", plain, 10, true, 60);
			runs("plain", plain, 10, false, 30);

			const shifted:TextField = field(WIDE, 90, 120, 60, 30, false);
			shifted.scrollH = 25;
			runs("shifted", shifted, 10, true, 60);
			runs("shifted", shifted, 10, false, 30);

			const lowered:TextField = field(TALL, 170, 120, 60, 50, true);
			lowered.scrollV = 3;
			runs("lowered", lowered, 10, false, 50);
			runs("lowered", lowered, 25, true, 60);

			// On the empty line, and below the last.
			const gap:TextField = field("ab\n\nba", 250, 120, 60, 70, true);
			runs("gap", gap, 30, true, 60);
			runs("gap", gap, 10, false, 70);

			culling();
			trailing();

			_input = field(WIDE, 10, 80, 60, 30, false);
			_input.type = TextFieldType.INPUT;
			addEventListener(Event.ENTER_FRAME, frame);
		}

		private function field(text:String, x:Number, y:Number, width:Number, height:Number, multiline:Boolean):TextField
		{
			const t:TextField = new TextField();
			t.embedFonts = true;
			t.defaultTextFormat = new TextFormat("Probe", 20);
			t.x = x;
			t.y = y;
			t.width = width;
			t.height = height;
			t.multiline = multiline;
			t.border = true;
			t.text = text;
			addChild(t);
			return t;
		}

		private function rect(r:Rectangle):String
		{
			return r ? r.x + "," + r.y + "," + r.width + "," + r.height : "null";
		}

		private function keep(label:String, t:TextField):void
		{
			_labels.push(label);
			_fields.push(t);
			show(label, t);
		}

		// Its scroll, each character's boundaries and line, and what the points of a grid over it hit.
		private function show(label:String, t:TextField):void
		{
			trace(label, "scrollH", t.scrollH, "maxScrollH", t.maxScrollH, "scrollV", t.scrollV, "maxScrollV", t.maxScrollV, "bottomScrollV", t.bottomScrollV, "numLines", t.numLines);
			const bounds:Array = [];
			const lines:Array = [];
			for (var i:int = 0; i < t.length; i++)
			{
				bounds.push(rect(t.getCharBoundaries(i)));
				lines.push(t.getLineIndexOfChar(i));
			}

			trace(label, "bounds", bounds.join(" "));
			trace(label, "lineOfChar", lines.join(" "));
			for (var y:Number = -2; y <= t.height + 2; y += 4)
			{
				const chars:Array = [];
				const atLines:Array = [];
				for (var x:Number = -2; x <= t.width + 2; x += 5)
				{
					chars.push(t.getCharIndexAtPoint(x, y));
					atLines.push(t.getLineIndexAtPoint(x, y));
				}

				trace(label, "y", y, "chars", chars.join(" "), "lines", atLines.join(" "));
			}
		}

		// Where the character and the line at a point change along a row or a column, a twip at a time.
		private function runs(label:String, t:TextField, fixed:Number, alongX:Boolean, to:Number):void
		{
			const out:Array = [];
			var last:String = null;
			for (var twips:int = -40; twips <= to * 20 + 40; twips++)
			{
				const v:Number = twips / 20;
				const x:Number = alongX ? v : fixed;
				const y:Number = alongX ? fixed : v;
				const now:String = t.getCharIndexAtPoint(x, y) + "/" + t.getLineIndexAtPoint(x, y);
				if (now != last)
				{
					out.push(v + "=" + now);
					last = now;
				}
			}

			trace(label, alongX ? "row" : "column", fixed, out.join(" "));
		}

		// The corpus's edittext_getcharboundaries_culling in Probe: the lines with boundaries as the field grows.
		private function culling():void
		{
			const t:TextField = new TextField();
			t.embedFonts = true;
			t.defaultTextFormat = new TextFormat("Probe", 10);
			t.multiline = true;
			t.width = 40;
			t.height = 4;
			for (var i:int = 0; i < 10; i++)
			{
				t.text += "aaaaaaaaa\n";
			}

			for (var scroll:int = 0; scroll < 5; scroll++)
			{
				t.scrollV = scroll;
				const out:Array = [];
				for (var h:int = 0; h < 60; h++)
				{
					t.height = h;
					const shown:Array = [];
					for (var line:int = 0; line < 11; line++)
					{
						if (t.getCharBoundaries(line * 10 + 2) != null)
						{
							shown.push(line);
						}
					}

					out.push(h + ":" + shown.join(",") + "@" + t.scrollV);
				}

				trace("culling scroll", scroll, out.join(" "));
			}
		}

		// How far fields ending in newlines scroll, dynamic and input, their last lines empty.
		private function trailing():void
		{
			const texts:Array = ["a\rb\rc\rd\re", "a\rb\rc\rd\re\r", "a\rb\rc\rd\re\r\r", "a\rb\rc\rd\r\re", "a\r\r\r\r"];
			const types:Array = [TextFieldType.DYNAMIC, TextFieldType.INPUT];
			const heights:Array = [50, 70];
			for (var k:int = 0; k < types.length; k++)
			{
				for (var j:int = 0; j < heights.length; j++)
				{
					for (var i:int = 0; i < texts.length; i++)
					{
						const t:TextField = field(texts[i], 0, 0, 60, heights[j], true);
						t.type = types[k];
						t.visible = false;
						const before:int = t.maxScrollV;
						t.scrollV = 100;
						trace("trailing", types[k], heights[j], i, "numLines", t.numLines, "maxScrollV", before, "scrollV", t.scrollV, "bottomScrollV", t.bottomScrollV, "textHeight", t.textHeight);
					}
				}
			}
		}

		private function frame(e:Event):void
		{
			_frames++;
			if (_frames == 1)
			{
				for (var i:int = 0; i < _fields.length; i++)
				{
					show(_labels[i] + " drawn", _fields[i]);
				}

				// Scrolled by its caret, at the end of its text.
				stage.focus = _input;
				_input.setSelection(_input.length, _input.length);
				show("caret", _input);
			}
			else if (_frames == 2)
			{
				show("caret drawn", _input);
				removeEventListener(Event.ENTER_FRAME, frame);
			}
		}
	}
}

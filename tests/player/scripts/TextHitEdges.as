// The text hit tests at their edges, as adl gives them: the left edge of an
// empty field, of an empty last line and of lines set in from the gutter by
// alignment, an indent, a margin and a bullet; a NaN point; text that shrinks
// under a scroll; and fields placed from DefineEditText tags whose bounds
// start away from their origins, before and after the inside of the gutter.
package
{
	import flash.display.MovieClip;
	import flash.geom.Rectangle;
	import flash.text.TextField;
	import flash.text.TextFormat;

	public class TextHitEdges extends MovieClip
	{
		// The placed fields, which the timeline sets.
		public var inset:TextField;
		public var outset:TextField;
		public var flush:TextField;

		public function TextHitEdges()
		{
			show("empty", field("", null));
			show("final newline", field("ab\n", null));
			const centred:TextFormat = new TextFormat("Probe", 20);
			centred.align = "center";
			show("centred", field("ab\nab", centred));
			const right:TextFormat = new TextFormat("Probe", 20);
			right.align = "right";
			show("right", field("ab\nab", right));
			const indented:TextFormat = new TextFormat("Probe", 20);
			indented.indent = 10;
			show("indented", field("ab\nab", indented));
			const margined:TextFormat = new TextFormat("Probe", 20);
			margined.leftMargin = 7;
			show("margined", field("ab\nab", margined));
			const bulleted:TextFormat = new TextFormat("Probe", 20);
			bulleted.bullet = true;
			show("bulleted", field("ab\nab", bulleted));

			const nan:TextField = field("ab\nab", null);
			trace("NaN", nan.getCharIndexAtPoint(NaN, NaN), nan.getLineIndexAtPoint(NaN, NaN), nan.getCharIndexAtPoint(NaN, 10), nan.getLineIndexAtPoint(NaN, 10), nan.getCharIndexAtPoint(10, NaN), nan.getLineIndexAtPoint(10, NaN));

			const shrunk:TextField = field("ab\nba\naab\nbba\nab\nba\nccc\nab", null);
			shrunk.scrollV = 5;
			shrunk.text = "ab\nba\naab";
			trace("shrunk scrollV", shrunk.scrollV, "maxScrollV", shrunk.maxScrollV, "bounds 0", rect(shrunk.getCharBoundaries(0)), "bounds 7", rect(shrunk.getCharBoundaries(7)), "line at 10 10", shrunk.getLineIndexAtPoint(10, 10));
			shrunk.text = "ab";
			trace("shrunk again scrollV", shrunk.scrollV, "maxScrollV", shrunk.maxScrollV, "bounds 0", rect(shrunk.getCharBoundaries(0)));

			const placed:Array = [inset, outset, flush];
			for (var i:int = 0; i < placed.length; i++)
			{
				const t:TextField = placed[i];
				trace(t.name, "x", t.x, "y", t.y, "width", t.width, "height", t.height);
				show(t.name, t);
				column(t.name, t);
			}
		}

		private function field(text:String, format:TextFormat):TextField
		{
			const t:TextField = new TextField();
			t.embedFonts = true;
			t.defaultTextFormat = format ? format : new TextFormat("Probe", 20);
			t.multiline = true;
			t.width = 60;
			t.height = 50;
			t.text = text;
			return t;
		}

		private function rect(r:Rectangle):String
		{
			return r ? r.x + "," + r.y + "," + r.width + "," + r.height : "null";
		}

		// Where the line at a point changes down a column, a twip at a time.
		private function column(label:String, t:TextField):void
		{
			const out:Array = [];
			var last:String = null;
			for (var twips:int = -300; twips <= t.height * 20 + 300; twips++)
			{
				const y:Number = twips / 20;
				const now:String = t.getCharIndexAtPoint(5, y) + "/" + t.getLineIndexAtPoint(5, y);
				if (now != last)
				{
					out.push(y + "=" + now);
					last = now;
				}
			}

			trace(label, "column 5", out.join(" "));
		}

		// Each character's boundaries, and where the character and the line at a point change along
		// the first and the last line's rows, a twip at a time.
		private function show(label:String, t:TextField):void
		{
			const bounds:Array = [];
			for (var i:int = 0; i < t.length; i++)
			{
				bounds.push(rect(t.getCharBoundaries(i)));
			}

			trace(label, "bounds", bounds.join(" "));
			const rows:Array = [10, 30];
			for (var r:int = 0; r < rows.length; r++)
			{
				const out:Array = [];
				var last:String = null;
				for (var twips:int = -300; twips <= t.width * 20 + 300; twips++)
				{
					const x:Number = twips / 20;
					const now:String = t.getCharIndexAtPoint(x, rows[r]) + "/" + t.getLineIndexAtPoint(x, rows[r]);
					if (now != last)
					{
						out.push(x + "=" + now);
						last = now;
					}
				}

				trace(label, "row", rows[r], out.join(" "));
			}
		}
	}
}

package
{
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.text.TextField;
	import flash.text.TextFieldType;
	import flash.text.TextFormat;

	// Where an input field narrower or shorter than its text scrolls as its
	// caret moves: scrollH and scrollV after setSelection, the focus,
	// replaceSelectedText, replaceText, appendText and text, in a field of
	// one line, of lines without wrapping, and wrapped (cases.ts's "Probe",
	// whose "a" is 9.75 pixels at 20, "b" 13.65 and "c" 5.85). adl moves
	// sideways by steps of a quarter of the room inside the gutters, 14
	// pixels here, and up and down by the fewest lines.
	public class TextInputScroll extends Sprite
	{
		private var frame:int = 0;
		private var line:TextField;

		public function TextInputScroll()
		{
			// The Flash oracle loads the SWF and adds it to its stage later.
			if (stage)
			{
				run();
			}
			else
			{
				addEventListener(Event.ADDED_TO_STAGE, run);
			}
		}

		private function field(x:Number, y:Number, w:Number, h:Number, multiline:Boolean, wrap:Boolean):TextField
		{
			var t:TextField = new TextField();
			t.type = TextFieldType.INPUT;
			t.embedFonts = true;
			t.multiline = multiline;
			t.wordWrap = wrap;
			t.x = x;
			t.y = y;
			t.width = w;
			t.height = h;
			t.border = true;
			t.defaultTextFormat = new TextFormat("Probe", 20);
			addChild(t);
			return t;
		}

		private function scrolls(label:String, t:TextField):void
		{
			trace(label, "h", t.scrollH, t.maxScrollH, "v", t.scrollV, t.maxScrollV, t.bottomScrollV);
		}

		private function show(label:String, t:TextField):void
		{
			trace(label, "h", t.scrollH, t.maxScrollH, "v", t.scrollV, t.maxScrollV, t.bottomScrollV,
					"sel", t.selectionBeginIndex, t.selectionEndIndex, t.caretIndex);
		}

		private function run(e:Event = null):void
		{
			line = field(10, 10, 60, 30, false, false);
			var lines:TextField = field(80, 10, 60, 50, true, false);
			var wrapped:TextField = field(150, 10, 60, 50, true, true);
			var other:TextField = field(10, 70, 60, 30, false, false);
			var s:String = "aaaaaaaaaaaaaaaaaaaa";

			// Flash Player scrolls no field without the focus to its caret, though
			// adl does; nor does it keep the selection for setSelection(0, 0), as
			// adl does: neither is traced. scrollH stops at maxScrollH.
			line.text = s;
			show("text", line);
			stage.focus = line;
			show("focused", line);
			line.setSelection(20, 20);
			show("end", line);
			line.setSelection(19, 19);
			show("19", line);
			line.setSelection(10, 10);
			show("10", line);
			line.setSelection(1, 0);
			show("start", line);
			line.setSelection(8, 8);
			show("8", line);
			line.setSelection(6, 6);
			show("6", line);
			line.setSelection(9, 9);
			show("9", line);
			line.setSelection(12, 12);
			show("12", line);
			line.setSelection(3, 3);
			show("3", line);
			line.setSelection(0, 20);
			show("0 to 20", line);
			line.setSelection(20, 0);
			show("20 to 0", line);
			line.setSelection(5, 15);
			show("5 to 15", line);
			line.scrollH = 0;
			line.setSelection(5, 15);
			show("5 to 15 again", line);
			line.scrollH = 1000;
			show("scrollH 1000", line);
			line.scrollH = -15;
			show("scrollH -15", line);
			line.scrollH = 30;
			show("scrollH 30", line);
			line.setSelection(15, 15);
			show("15 after scrollH", line);

			// replaceSelectedText and replaceText scroll to where the text went in.
			line.setSelection(20, 20);
			line.replaceSelectedText("b");
			show("replaced at end", line);
			line.setSelection(1, 1);
			line.replaceSelectedText("bb");
			show("replaced at start", line);
			line.appendText("cccc");
			show("appended", line);
			line.setSelection(line.length, line.length);
			show("to the end", line);
			line.appendText("cccc");
			show("appended at the end", line);
			line.replaceText(0, 2, "");
			show("replaceText", line);
			line.setSelection(line.length, line.length);
			line.replaceText(26, 27, "b");
			show("replaceText at the end", line);
			// text keeps the scroll, within the new text's.
			line.text = s + "a";
			scrolls("text", line);
			line.text = "aaaaaaa";
			scrolls("text shorter", line);
			// adl's text puts an input field's caret at the start, Flash Player's
			// keeps it: a caret it has nowhere.
			line.text = s;
			line.setSelection(19, 19);
			show("text again", line);

			// Lines, no wrapping: one long.
			lines.text = "a\rb\rc\rabcabcabcab\ra\rb\rc";
			stage.focus = lines;
			lines.setSelection(1, 0);
			show("lines start", lines);
			lines.setSelection(lines.length, lines.length);
			show("lines end", lines);
			lines.setSelection(1, 0);
			show("lines start again", lines);
			lines.setSelection(4, 4);
			show("lines 3", lines);
			lines.setSelection(6, 6);
			show("lines 4", lines);
			lines.setSelection(17, 17);
			show("lines 4 end", lines);
			lines.setSelection(2, 2);
			show("lines 2", lines);
			lines.setSelection(18, 18);
			show("lines 5", lines);

			// Wrapped.
			wrapped.text = s + s;
			stage.focus = wrapped;
			wrapped.setSelection(1, 0);
			show("wrapped start", wrapped);
			wrapped.setSelection(40, 40);
			show("wrapped end", wrapped);
			wrapped.setSelection(7, 7);
			show("wrapped 7", wrapped);
			wrapped.setSelection(17, 17);
			show("wrapped 17", wrapped);

			// The focus back on a field scrolls to its caret.
			other.text = s;
			stage.focus = other;
			other.setSelection(20, 20);
			show("other end", other);
			stage.focus = line;
			line.scrollH = 1000;
			line.setSelection(15, 15);
			show("line 15", line);
			line.scrollH = 1000;
			stage.focus = other;
			stage.focus = line;
			show("line focused again", line);

			// A field not of type input scrolls no further than its text.
			other.type = TextFieldType.DYNAMIC;
			scrolls("dynamic", other);
			line.setSelection(20, 20);
			show("line end", line);
			margins();
			autoSized();

			// The frames are drawn without the focus, as adl's caret blinks.
			stage.focus = null;
			addEventListener(Event.ENTER_FRAME, step);
		}

		// Fields below the stage, not drawn.
		private function below(format:TextFormat, text:String, type:String = "input"):TextField
		{
			var t:TextField = field(10, 200, 60, 30, false, false);
			t.type = type;
			t.defaultTextFormat = format;
			t.text = text;
			return t;
		}

		// maxScrollH reaches as far as a line does: its margin, block indent,
		// indent and alignment in, but not the right margin.
		private function margins():void
		{
			var s:String = "aaaaaaaaaaaaaaaaaaaa";
			var left:TextFormat = new TextFormat("Probe", 20);
			left.leftMargin = 10;
			var t:TextField = below(left, s);
			scrolls("leftMargin", t);
			stage.focus = t;
			t.setSelection(20, 20);
			show("leftMargin end", t);
			t.setSelection(1, 0);
			show("leftMargin start", t);
			scrolls("leftMargin dynamic", below(left, s, TextFieldType.DYNAMIC));
			var right:TextFormat = new TextFormat("Probe", 20);
			right.rightMargin = 10;
			scrolls("rightMargin", below(right, s));
			var indent:TextFormat = new TextFormat("Probe", 20);
			indent.indent = 10;
			scrolls("indent", below(indent, s));
			var block:TextFormat = new TextFormat("Probe", 20);
			block.blockIndent = 10;
			scrolls("blockIndent", below(block, s));
			scrolls("short", below(new TextFormat("Probe", 20), "aaaa"));
			var centre:TextFormat = new TextFormat("Probe", 20);
			centre.align = "center";
			scrolls("centred short", below(centre, "aaaa"));
			scrolls("centred short dynamic", below(centre, "aaaa", TextFieldType.DYNAMIC));
			scrolls("centred long", below(centre, s));
			var r:TextFormat = new TextFormat("Probe", 20);
			r.align = "right";
			scrolls("right short", below(r, "aaaa"));
			scrolls("right long", below(r, s));
		}

		// An input field that fits itself to its text is wider than its text by
		// a little, which its default size sets, so that a caret at the end of
		// what it holds needs no scroll.
		private function autoSized():void
		{
			var sizes:Array = [8, 10, 13, 20, 40, 72];
			for (var i:int = 0; i < sizes.length; i++)
			{
				var t:TextField = below(new TextFormat("Probe", sizes[i]), "aaaaa");
				t.autoSize = "left";
				var d:TextField = below(new TextFormat("Probe", sizes[i]), "aaaaa", TextFieldType.DYNAMIC);
				d.autoSize = "left";
				trace("autoSize", sizes[i], t.width, d.width, t.textWidth, t.maxScrollH, d.maxScrollH);
			}

			var a:TextField = below(new TextFormat("Probe", 20), "aaaaa");
			a.autoSize = "left";
			stage.focus = a;
			a.setSelection(5, 5);
			trace("autoSize end", a.width, a.scrollH, a.maxScrollH, a.caretIndex);
			a.replaceSelectedText("a");
			trace("autoSize typed", a.width, a.scrollH, a.maxScrollH, a.caretIndex);
			a.appendText("aaa");
			a.setSelection(9, 9);
			trace("autoSize appended end", a.width, a.scrollH, a.maxScrollH, a.caretIndex);
			var big:TextField = below(new TextFormat("Probe", 20), "aaaaa");
			big.setTextFormat(new TextFormat("Probe", 40));
			big.autoSize = "left";
			trace("autoSize by the default size", big.width, big.textWidth);
		}

		private function step(e:Event):void
		{
			frame++;
			show("frame " + frame, line);
			switch (frame)
			{
				case 1:
					stage.focus = line;
					line.setSelection(3, 3);
					show("3", line);
					stage.focus = null;
					break;
				case 2:
					stage.focus = line;
					line.setSelection(20, 20);
					show("end", line);
					stage.focus = null;
					break;
				case 3:
					removeEventListener(Event.ENTER_FRAME, step);
					break;
			}
		}
	}
}

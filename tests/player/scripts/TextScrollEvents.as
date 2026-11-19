// When a field dispatches Event.SCROLL, as adl does: as soon as its scrollV,
// maxScrollV, scrollH or maxScrollH changes by script, by new text or by a
// new format, off the display list too, but not as setSelection scrolls it to
// its caret. (adl measures a field anew only now and then: a new size, and
// what comes after one, dispatch late or twice, so this leaves sizes out.)
package
{
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.text.TextField;
	import flash.text.TextFieldType;
	import flash.text.TextFormat;

	public class TextScrollEvents extends Sprite
	{
		private static const LINES:String = "ab\nba\naab\nbba\nab\nba\nccc\nab";
		private static const WIDE:String = "aaaaaaaaaabbbbbbbbbbaaaaaaaaaa";

		private var _step:String = "";
		private var _frames:int = 0;
		private var _input:TextField;
		private var _dynamic:TextField;

		public function TextScrollEvents()
		{
			_input = field("input", TextFieldType.INPUT, LINES + "\n" + WIDE, 10, 10);
			_dynamic = field("dynamic", TextFieldType.DYNAMIC, LINES + "\n" + WIDE, 80, 10);

			step("scrollV 3");
			_input.scrollV = 3;
			step("scrollV 3 again");
			_input.scrollV = 3;
			step("scrollV 100");
			_input.scrollV = 100;
			step("scrollV 0");
			_input.scrollV = 0;
			step("scrollH 10");
			_input.scrollH = 10;
			step("scrollH 10 again");
			_input.scrollH = 10;
			step("scrollH -5");
			_input.scrollH = -5;
			step("scrollH 1000");
			_input.scrollH = 1000;
			step("scrollV 5 scrollH 0");
			_input.scrollV = 5;
			_input.scrollH = 0;

			step("dynamic scrollV 4");
			_dynamic.scrollV = 4;
			step("dynamic scrollH 7");
			_dynamic.scrollH = 7;

			step("text shorter");
			_input.text = "ab\nba";
			step("text longer");
			_input.text = LINES + "\n" + WIDE;
			step("scrollV 6");
			_input.scrollV = 6;
			step("appendText");
			_input.appendText("\nab");
			step("replaceText at the start");
			_input.replaceText(0, 0, "a\n");
			step("htmlText shorter");
			_input.htmlText = "ab";
			step("dynamic text same length");
			_dynamic.text = LINES + "\n" + WIDE;
			step("dynamic text empty");
			_dynamic.text = "";

			const off:TextField = field("off", TextFieldType.DYNAMIC, LINES, 0, 0);
			removeChild(off);
			step("off the list scrollV 3");
			off.scrollV = 3;
			step("off the list text");
			off.text = "a";

			const short:TextField = field("short", TextFieldType.DYNAMIC, "ab", 0, 60);
			step("short swapped");
			short.text = "ba";
			step("short longer within the room");
			short.text = "abab";
			step("short format bigger");
			short.setTextFormat(new TextFormat("Probe", 30));
			step("long swapped in a line");
			_dynamic.text = LINES + "\n" + WIDE;
			_dynamic.replaceText(0, 2, "ba");
			step("long same text again");
			_dynamic.text = _dynamic.text;
			step("long format bigger");
			_dynamic.setTextFormat(new TextFormat("Probe", 30));
			step("format back then scrollV 5");
			_dynamic.setTextFormat(new TextFormat("Probe", 20));
			_dynamic.scrollV = 5;

			_input.text = LINES + "\n" + WIDE;
			step("constructed");
			addEventListener(Event.ENTER_FRAME, frame);
		}

		private function field(name:String, type:String, text:String, x:Number, y:Number):TextField
		{
			const t:TextField = new TextField();
			t.name = name;
			t.embedFonts = true;
			t.defaultTextFormat = new TextFormat("Probe", 20);
			t.type = type;
			t.multiline = true;
			t.x = x;
			t.y = y;
			t.width = 60;
			t.height = 50;
			t.border = true;
			t.text = text;
			t.addEventListener(Event.SCROLL, scrolled);
			addChild(t);
			return t;
		}

		private function step(label:String):void
		{
			_step = label;
			trace("step", label, state(_input));
		}

		private function state(t:TextField):String
		{
			return t.scrollV + "/" + t.maxScrollV + " " + t.scrollH + "/" + t.maxScrollH;
		}

		private function scrolled(e:Event):void
		{
			const t:TextField = e.target as TextField;
			trace("  scroll", t.name, "during", _step, state(t), e.bubbles, e.cancelable, e.eventPhase);
		}

		private function frame(e:Event):void
		{
			_frames++;
			step("frame " + _frames);
			switch (_frames)
			{
				case 1:
					step("focus");
					stage.focus = _input;
					step("caret at the end");
					_input.setSelection(_input.length, _input.length);
					trace("  after", state(_input));
					step("caret at the start");
					_input.setSelection(0, 0);
					trace("  after", state(_input));
					step("caret on the wide line's end");
					_input.setSelection(_input.length, _input.length);
					trace("  after", state(_input));
					step("replaceSelectedText at the end");
					_input.replaceSelectedText("bbbbbbbbbb");
					step("scrollV 2 and 3 in a frame");
					_input.scrollV = 2;
					_input.scrollV = 3;
					break;
				case 2:
					step("text shorter with focus");
					_input.text = "ab";
					break;
				case 4:
					removeEventListener(Event.ENTER_FRAME, frame);
					break;
			}
		}
	}
}

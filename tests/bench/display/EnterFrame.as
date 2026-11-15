// ENTER_FRAME on many Sprites, timed over frames: each of COUNT Sprites,
// a square drawn once in its graphics, listens for ENTER_FRAME with a
// method of its own, in phases of FRAMES frames each. The first, a
// listener that only counts, is a warm-up and is not timed: it takes the
// first drawing of the Sprites, and Flash runs it at its frame rate's
// pace. Then one that moves the Sprite's position, rotation and alpha in
// its own variables (the script), and one that also sets x, y, rotation
// and alpha from them (the script, the display's properties and the
// drawing of what moved). A Sprite on top of them keeps the time; each
// Sprite counts its own calls and stops listening after FRAMES, so every
// player does the same work whichever order it dispatches the event in.
// The movie's frame rate, 255, is above what a frame of this work takes in
// Flash, so its frames follow each other at once; COUNT is five times
// avm1/EnterFrame.as's, as Flash's JIT ran the script phase of 2,000 in
// less than a frame at that rate, and would have been timed by its pace.
package
{
	import flash.display.Sprite;
	import flash.events.Event;

	public class Main extends Sprite
	{
		private var _dots:Vector.<Dot> = new Vector.<Dot>();
		private var _phase:int = -1;
		private var _ticks:int = 0;
		private var _started:Number = 0;
		private var _clock:Sprite = new Sprite();

		public function Main()
		{
			for (var i:int = 0; i < COUNT; i++)
			{
				var d:Dot = new Dot(i);
				addChild(d);
				_dots.push(d);
			}

			addChild(_clock);
			_clock.addEventListener(Event.ENTER_FRAME, tick);
		}

		private function begin(kind:int):void
		{
			for (var j:int = 0; j < COUNT; j++)
			{
				_dots[j].begin(kind);
			}
			_ticks = 0;
			_started = new Date().time;
		}

		private function sum():Number
		{
			var s:Number = 0;
			for (var j:int = 0; j < COUNT; j++)
			{
				var d:Dot = _dots[j];
				s += d.n + d.px + d.py + d.r + d.a + Math.round(d.x) + Math.round(d.y) + Math.round(d.rotation) + Math.round(d.alpha * 100);
			}
			return s;
		}

		// FRAMES and one frame after a phase began, every Sprite has run its FRAMES calls.
		private function tick(event:Event):void
		{
			_ticks++;
			if (_phase >= 0 && _ticks <= FRAMES)
			{
				return;
			}

			if (_phase >= 0 && PHASES[_phase] != null)
			{
				var ms:Number = new Date().time - _started;
				trace(PHASES[_phase] + " " + sum());
				trace("time: " + PHASES[_phase] + " " + ms);
			}

			_phase++;
			if (_phase < PHASES.length)
			{
				begin(_phase);
			}
			else
			{
				_clock.removeEventListener(Event.ENTER_FRAME, tick);
				trace("players: done");
			}
		}
	}
}

import flash.display.Sprite;
import flash.events.Event;

const COUNT:int = 10000;
const FRAMES:int = 30;
// Each phase's section, by the kind of listener Dot.begin gives: none for the warm-up.
const PHASES:Array = [null, "enterframe-script", "enterframe-display"];

class Dot extends Sprite
{
	public var px:Number;
	public var py:Number;
	public var vx:Number;
	public var vy:Number;
	public var r:Number;
	public var a:Number;
	public var n:int = 0;
	private var _listener:Function = null;

	public function Dot(i:int)
	{
		graphics.beginFill(0x3366cc);
		graphics.drawRect(0, 0, 10, 10);
		graphics.endFill();
		px = (i * 37) % 400;
		py = (i * 91) % 300;
		vx = (i % 7) - 3;
		vy = (i % 5) - 2;
		r = i % 360;
		a = i % 100;
	}

	public function begin(kind:int):void
	{
		n = 0;
		_listener = kind == 0 ? count : kind == 1 ? think : move;
		addEventListener(Event.ENTER_FRAME, _listener);
	}

	private function finish():void
	{
		n++;
		if (n >= FRAMES)
		{
			removeEventListener(Event.ENTER_FRAME, _listener);
		}
	}

	private function step():void
	{
		px += vx;
		if (px < 0 || px > 400)
		{
			vx = -vx;
		}

		py += vy;
		if (py < 0 || py > 300)
		{
			vy = -vy;
		}

		r = (r + 7) % 360;
		a = (a + 3) % 100;
	}

	private function count(event:Event):void
	{
		finish();
	}

	private function think(event:Event):void
	{
		step();
		finish();
	}

	private function move(event:Event):void
	{
		step();
		x = px;
		y = py;
		rotation = r;
		alpha = a / 100;
		finish();
	}
}

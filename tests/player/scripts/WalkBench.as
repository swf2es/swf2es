package
{
	import flash.display.MovieClip;
	import flash.display.Sprite;
	import flash.events.Event;

	public class WalkMain extends MovieClip
	{
		public var n:int = 0;
		private const _kept:Array = [];
		private var _menu:Sprite = null;

		public function WalkMain()
		{
			addFrameScript(0, tick, 1, tick);
		}

		private function tick():void
		{
			n++;
		}

		/** Make `count` panels and keep them off the display list, held by a listener as a game holds its hidden panels. */
		public function keep(count:int):void
		{
			for (var i:int = 0; i < count; i++)
			{
				const panel:WalkPanel = new WalkPanel();
				panel.addEventListener(Event.ENTER_FRAME, idle);
				_kept.push(panel);
			}
		}

		private function idle(e:Event):void
		{
		}

		/** A menu of `rows` rows, each a clip holding a button whose states are clips, as a game's list of options. */
		public function build(rows:int):void
		{
			_menu = new Sprite();
			addChild(_menu);
			for (var i:int = 0; i < rows; i++)
			{
				const row:WalkRow = new WalkRow();
				row.y = i * 12;
				_menu.addChild(row);
			}
		}

		public function drop():void
		{
			removeChild(_menu);
			_menu = null;
		}
	}

	public class WalkPanel extends MovieClip
	{
	}

	public class WalkRow extends MovieClip
	{
	}

	public class WalkPart extends MovieClip
	{
		public static var made:int = 0;

		public function WalkPart()
		{
			addFrameScript(0, first);
		}

		private function first():void
		{
			made++;
		}
	}
}

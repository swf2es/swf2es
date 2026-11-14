package
{
	import flash.display.Loader;
	import flash.display.MovieClip;
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.system.LoaderContext;
	import flash.utils.ByteArray;

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

		public var oldLoaded:Boolean = false;

		/** Load the SWF of version 9 the bench embeds (WalkOld) onto the stage, its clips beside the rest. */
		public function loadOld():void
		{
			const loader:Loader = new Loader();
			loader.contentLoaderInfo.addEventListener(Event.COMPLETE, loaded);
			const context:LoaderContext = new LoaderContext();
			context.allowCodeImport = true;
			loader.loadBytes(new WalkOld(), context);
			addChild(loader);
		}

		private function loaded(e:Event):void
		{
			oldLoaded = true;
		}
	}

	public class WalkOld extends ByteArray
	{
	}

	public class WalkPanel extends MovieClip
	{
	}

	public class WalkRow extends MovieClip
	{
	}

	/** A clip whose timeline places and takes off children every frame, and hears each. */
	public class WalkChurn extends MovieClip
	{
		public static var heard:int = 0;

		public function WalkChurn()
		{
			addEventListener(Event.ADDED, hear);
			addEventListener(Event.REMOVED, hear);
		}

		private function hear(e:Event):void
		{
			heard++;
		}
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

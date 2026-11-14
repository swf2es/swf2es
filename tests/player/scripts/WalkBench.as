package
{
	import flash.display.Loader;
	import flash.display.MovieClip;
	import flash.display.Shape;
	import flash.display.SimpleButton;
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.events.MouseEvent;
	import flash.geom.Rectangle;
	import flash.text.TextField;
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

		private var _list:Sprite = null;
		private var _spinner:Shape = null;
		private var _moving:Array = [];
		private var _scroll:Boolean = false;
		public var overs:int = 0;

		/**
		 * A panel listing `rows` rows, each a background, three text fields,
		 * two SimpleButtons and a sprite in buttonMode holding a field, in a
		 * scrollRect, and a shape that turns beside it each frame, as a game's
		 * idle screen has something playing. `moving` rows slide each frame,
		 * and with `scroll` the list scrolls a pixel a frame.
		 */
		public function list(rows:int, moving:int, scroll:Boolean):void
		{
			_list = new Sprite();
			_list.x = 20;
			_list.y = 20;
			_list.scrollRect = new Rectangle(0, 0, 400, 560);
			addChild(_list);
			for (var i:int = 0; i < rows; i++)
			{
				const row:Sprite = listRow(i);
				row.y = i * 24;
				_list.addChild(row);
				if (i < moving)
				{
					_moving.push(row);
				}
			}

			_list.addEventListener(MouseEvent.MOUSE_OVER, over);
			_spinner = new Shape();
			_spinner.graphics.beginFill(0x3366cc);
			_spinner.graphics.drawRect(-20, -20, 40, 40);
			_spinner.x = 600;
			_spinner.y = 100;
			addChild(_spinner);
			_scroll = scroll;
			addEventListener(Event.ENTER_FRAME, play);
		}

		private function listRow(i:int):Sprite
		{
			const row:Sprite = new Sprite();
			row.graphics.beginFill(i % 2 == 0 ? 0xeeeeee : 0xdddddd);
			row.graphics.drawRect(0, 0, 400, 24);
			for (var f:int = 0; f < 3; f++)
			{
				const field:TextField = new TextField();
				field.x = 4 + f * 90;
				field.width = 86;
				field.height = 20;
				field.text = "Row " + i + " field " + f;
				row.addChild(field);
			}

			for (var b:int = 0; b < 2; b++)
			{
				const button:SimpleButton = new SimpleButton(box(0x88aa88), box(0xaaccaa), box(0x668866), box(0));
				button.x = 280 + b * 40;
				button.y = 2;
				row.addChild(button);
			}

			const link:Sprite = new Sprite();
			link.buttonMode = true;
			link.x = 364;
			link.graphics.beginFill(0x8888cc);
			link.graphics.drawRect(0, 2, 32, 20);
			const label:TextField = new TextField();
			label.width = 32;
			label.height = 20;
			label.mouseEnabled = false;
			label.text = "Go";
			link.addChild(label);
			row.addChild(link);
			return row;
		}

		private function box(colour:uint):Shape
		{
			const shape:Shape = new Shape();
			shape.graphics.beginFill(colour);
			shape.graphics.drawRect(0, 0, 36, 20);
			return shape;
		}

		private function play(e:Event):void
		{
			_spinner.rotation += 5;
			for (var i:int = 0; i < _moving.length; i++)
			{
				const row:Sprite = _moving[i];
				row.x = row.x == 0 ? 2 : 0;
			}

			if (_scroll)
			{
				const r:Rectangle = _list.scrollRect;
				r.y = (r.y + 1) % 200;
				_list.scrollRect = r;
			}
		}

		private function over(e:MouseEvent):void
		{
			overs++;
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

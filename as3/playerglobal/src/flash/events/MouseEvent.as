// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/events/MouseEvent.ts. Its
// fields are AS3's; only the stage point and a redraw need the player.

package flash.events
{
	import flash.display.InteractiveObject;

	public class MouseEvent extends Event
	{
		private var _localX:Number;
		private var _localY:Number;
		private var _relatedObject:InteractiveObject;
		private var _ctrlKey:Boolean;
		private var _altKey:Boolean;
		private var _shiftKey:Boolean;
		private var _buttonDown:Boolean;
		private var _delta:int;
		private var _isRelatedObjectInaccessible:Boolean;
		private var _movementX:Number = 0;
		private var _movementY:Number = 0;
		private var _commandKey:Boolean;
		private var _controlKey:Boolean;
		private var _clickCount:int;

		public function MouseEvent(type:String, bubbles:Boolean = true, cancelable:Boolean = false, localX:Number = void 0, localY:Number = void 0, relatedObject:InteractiveObject = null, ctrlKey:Boolean = false, altKey:Boolean = false, shiftKey:Boolean = false, buttonDown:Boolean = false, delta:int = 0, commandKey:Boolean = false, controlKey:Boolean = false, clickCount:int = 0)
		{
			super(type, bubbles, cancelable);
			this.localX = localX;
			this.localY = localY;
			this.relatedObject = relatedObject;
			this.ctrlKey = ctrlKey;
			this.altKey = altKey;
			this.shiftKey = shiftKey;
			this.buttonDown = buttonDown;
			this.delta = delta;
			this.commandKey = commandKey;
			this.controlKey = controlKey;
			_clickCount = clickCount;
		}

		public static const CLICK:String = "click";
		public static const DOUBLE_CLICK:String = "doubleClick";
		public static const MOUSE_DOWN:String = "mouseDown";
		public static const MOUSE_MOVE:String = "mouseMove";
		public static const MOUSE_OUT:String = "mouseOut";
		public static const MOUSE_OVER:String = "mouseOver";
		public static const MOUSE_UP:String = "mouseUp";
		public static const RELEASE_OUTSIDE:String = "releaseOutside";
		public static const MOUSE_WHEEL:String = "mouseWheel";
		public static const ROLL_OUT:String = "rollOut";
		public static const ROLL_OVER:String = "rollOver";
		public static const MIDDLE_CLICK:String = "middleClick";
		public static const MIDDLE_MOUSE_DOWN:String = "middleMouseDown";
		public static const MIDDLE_MOUSE_UP:String = "middleMouseUp";
		public static const RIGHT_CLICK:String = "rightClick";
		public static const RIGHT_MOUSE_DOWN:String = "rightMouseDown";
		public static const RIGHT_MOUSE_UP:String = "rightMouseUp";
		public static const CONTEXT_MENU:String = "contextMenu";

		override public function clone():Event
		{
			return new MouseEvent(type, bubbles, cancelable, localX, localY, relatedObject, ctrlKey, altKey, shiftKey, buttonDown, delta, commandKey, controlKey, clickCount);
		}

		override public function toString():String
		{
			return formatToString("MouseEvent", "type", "bubbles", "cancelable", "eventPhase", "localX", "localY", "stageX", "stageY", "relatedObject", "ctrlKey", "altKey", "shiftKey", "buttonDown", "delta");
		}

		public function get localX():Number
		{
			return _localX;
		}

		public function set localX(value:Number):void
		{
			_localX = value;
		}

		public function get localY():Number
		{
			return _localY;
		}

		public function set localY(value:Number):void
		{
			_localY = value;
		}

		public function get relatedObject():InteractiveObject
		{
			return _relatedObject;
		}

		public function set relatedObject(value:InteractiveObject):void
		{
			_relatedObject = value;
		}

		public function get ctrlKey():Boolean
		{
			return _ctrlKey;
		}

		public function set ctrlKey(value:Boolean):void
		{
			_ctrlKey = value;
		}

		public function get altKey():Boolean
		{
			return _altKey;
		}

		public function set altKey(value:Boolean):void
		{
			_altKey = value;
		}

		public function get shiftKey():Boolean
		{
			return _shiftKey;
		}

		public function set shiftKey(value:Boolean):void
		{
			_shiftKey = value;
		}

		public function get buttonDown():Boolean
		{
			return _buttonDown;
		}

		public function set buttonDown(value:Boolean):void
		{
			_buttonDown = value;
		}

		public function get delta():int
		{
			return _delta;
		}

		public function set delta(value:int):void
		{
			_delta = value;
		}

		public function get stageX():Number
		{
			return getStageX(_localX, _localY);
		}

		public function get stageY():Number
		{
			return getStageY(_localX, _localY);
		}

		public native function updateAfterEvent():void;

		[API("662")]
		public function get isRelatedObjectInaccessible():Boolean
		{
			return _isRelatedObjectInaccessible;
		}

		[API("662")]
		public function set isRelatedObjectInaccessible(value:Boolean):void
		{
			_isRelatedObjectInaccessible = value;
		}

		[API("678")]
		public function get movementX():Number
		{
			return _movementX;
		}

		[API("678")]
		public function set movementX(value:Number):void
		{
			_movementX = value;
		}

		[API("678")]
		public function get movementY():Number
		{
			return _movementY;
		}

		[API("678")]
		public function set movementY(value:Number):void
		{
			_movementY = value;
		}

		public function get commandKey():Boolean
		{
			return _commandKey;
		}

		public function set commandKey(value:Boolean):void
		{
			_commandKey = value;
		}

		public function get controlKey():Boolean
		{
			return _controlKey;
		}

		public function set controlKey(value:Boolean):void
		{
			_controlKey = value;
		}

		public function get clickCount():int
		{
			return _clickCount;
		}

		// The player's natives (packages/player/src/playerglobal/flash/events/MouseEvent.ts).
		private native function getStageX(x:Number, y:Number):Number;

		private native function getStageY(x:Number, y:Number):Number;
	}
}

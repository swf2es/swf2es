// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/events/TouchEvent.ts.

package flash.events
{
	import flash.display.InteractiveObject;
	import flash.utils.ByteArray;

	[API("667")]
	public class TouchEvent extends Event
	{
		private var _touchPointID:int;
		private var _localX:Number;
		private var _localY:Number;
		private var _isPrimaryTouchPoint:Boolean;
		private var _sizeX:Number;
		private var _sizeY:Number;
		private var _pressure:Number;
		private var _relatedObject:InteractiveObject;
		private var _ctrlKey:Boolean;
		private var _altKey:Boolean;
		private var _shiftKey:Boolean;
		private var _isRelatedObjectInaccessible:Boolean;
		private var _commandKey:Boolean;
		private var _controlKey:Boolean;
		private var _timestamp:Number;
		private var _touchIntent:String;
		private var _isTouchPointCanceled:Boolean;

		public function TouchEvent(type:String, bubbles:Boolean = true, cancelable:Boolean = false, touchPointID:int = 0, isPrimaryTouchPoint:Boolean = false, localX:Number = NaN, localY:Number = NaN, sizeX:Number = NaN, sizeY:Number = NaN, pressure:Number = NaN, relatedObject:InteractiveObject = null, ctrlKey:Boolean = false, altKey:Boolean = false, shiftKey:Boolean = false, commandKey:Boolean = false, controlKey:Boolean = false, timestamp:Number = NaN, touchIntent:String = "unknown", samples:ByteArray = null, isTouchPointCanceled:Boolean = false)
		{
			super(type, bubbles, cancelable);
			this.touchPointID = touchPointID;
			this.isPrimaryTouchPoint = isPrimaryTouchPoint;
			this.localX = localX;
			this.localY = localY;
			this.sizeX = sizeX;
			this.sizeY = sizeY;
			this.pressure = pressure;
			this.relatedObject = relatedObject;
			this.ctrlKey = ctrlKey;
			this.altKey = altKey;
			this.shiftKey = shiftKey;
			this.commandKey = commandKey;
			this.controlKey = controlKey;
			this.timestamp = timestamp;
			this.touchIntent = touchIntent;
			if (samples != null)
			{
				setSamples(samples);
			}
			this.isTouchPointCanceled = isTouchPointCanceled;
		}

		public static const TOUCH_BEGIN:String = "touchBegin";
		public static const TOUCH_END:String = "touchEnd";
		public static const TOUCH_MOVE:String = "touchMove";
		public static const TOUCH_OVER:String = "touchOver";
		public static const TOUCH_OUT:String = "touchOut";
		public static const TOUCH_ROLL_OVER:String = "touchRollOver";
		public static const TOUCH_ROLL_OUT:String = "touchRollOut";
		public static const TOUCH_TAP:String = "touchTap";
		public static const PROXIMITY_BEGIN:String = "proximityBegin";
		public static const PROXIMITY_END:String = "proximityEnd";
		public static const PROXIMITY_MOVE:String = "proximityMove";
		public static const PROXIMITY_OUT:String = "proximityOut";
		public static const PROXIMITY_OVER:String = "proximityOver";
		public static const PROXIMITY_ROLL_OUT:String = "proximityRollOut";
		public static const PROXIMITY_ROLL_OVER:String = "proximityRollOver";

		override public function clone():Event
		{
			return new TouchEvent(type, bubbles, cancelable, touchPointID, isPrimaryTouchPoint, localX, localY, sizeX, sizeY, pressure, relatedObject, ctrlKey, altKey, shiftKey, commandKey, controlKey, timestamp, touchIntent, null, isTouchPointCanceled);
		}

		override public function toString():String
		{
			return formatToString("TouchEvent", "type", "bubbles", "cancelable", "eventPhase", "touchPointID", "isPrimaryTouchPoint", "localX", "localY", "stageX", "stageY", "sizeX", "sizeY", "pressure", "relatedObject", "ctrlKey", "altKey", "shiftKey", "commandKey", "controlKey", "timestamp", "touchIntent", "isTouchPointCanceled");
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

		public function get touchPointID():int
		{
			return _touchPointID;
		}

		public function set touchPointID(value:int):void
		{
			_touchPointID = value;
		}

		public function get isPrimaryTouchPoint():Boolean
		{
			return _isPrimaryTouchPoint;
		}

		public function set isPrimaryTouchPoint(value:Boolean):void
		{
			_isPrimaryTouchPoint = value;
		}

		public function get sizeX():Number
		{
			return _sizeX;
		}

		public function set sizeX(value:Number):void
		{
			_sizeX = value;
		}

		public function get sizeY():Number
		{
			return _sizeY;
		}

		public function set sizeY(value:Number):void
		{
			_sizeY = value;
		}

		public function get pressure():Number
		{
			return _pressure;
		}

		public function set pressure(value:Number):void
		{
			_pressure = value;
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

		public function get stageX():Number
		{
			// Without a whole local point there is no stage point, as Flash's shows.
			return isNaN(localX) || isNaN(localY) ? NaN : getStageX(_localX, _localY);
		}

		public function get stageY():Number
		{
			return isNaN(localX) || isNaN(localY) ? NaN : getStageY(_localX, _localY);
		}

		public native function updateAfterEvent():void;

		public function get isRelatedObjectInaccessible():Boolean
		{
			return _isRelatedObjectInaccessible;
		}

		public function set isRelatedObjectInaccessible(value:Boolean):void
		{
			_isRelatedObjectInaccessible = value;
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

		[API("675")]
		public native function isToolButtonDown(index:int):Boolean;

		[API("675")]
		public function get timestamp():Number
		{
			return _timestamp;
		}

		[API("675")]
		public function set timestamp(value:Number):void
		{
			_timestamp = value;
		}

		[API("675")]
		public function get touchIntent():String
		{
			return _touchIntent;
		}

		[API("675")]
		public function set touchIntent(value:String):void
		{
			_touchIntent = value;
		}

		[API("675")]
		public function get isTouchPointCanceled():Boolean
		{
			return _isTouchPointCanceled;
		}

		[API("675")]
		public function set isTouchPointCanceled(value:Boolean):void
		{
			_isTouchPointCanceled = value;
		}

		[API("675")]
		public native function getSamples(buffer:ByteArray, append:Boolean = false):uint;

		// The player's natives (packages/player/src/playerglobal/flash/events/TouchEvent.ts).
		private native function getStageX(x:Number, y:Number):Number;

		private native function getStageY(x:Number, y:Number):Number;

		private native function privateGetSamples(arg0:ByteArray):uint;

		private native function setSamples(arg0:ByteArray):void;
	}
}

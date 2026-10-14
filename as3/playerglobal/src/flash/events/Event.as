// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).
// Its fields are AS3's, which compiled code reads as slots; the player's
// dispatch (packages/player/src/scripting/events.ts) writes the target,
// current target and phase into them and reads the flags.
// clone, toString and formatToString from Ruffle (https://github.com/ruffle-rs/ruffle),
// core/src/avm2/globals/flash/events/Event.as: MIT OR Apache-2.0, Copyright (c)
// 2018-2022 Ruffle LLC and Ruffle contributors.
package flash.events
{
	public class Event
	{
		private var _type:String;
		private var _bubbles:Boolean;
		private var _cancelable:Boolean;
		private var _target:Object;
		private var _currentTarget:Object;
		private var _eventPhase:uint = 2; // EventPhase.AT_TARGET
		// 0 propagating, 1 stopped after the current object, 2 stopped at once.
		private var _stopped:int;
		private var _prevented:Boolean;

		public function Event(type:String, bubbles:Boolean = false, cancelable:Boolean = false)
		{
			if (type == null)
			{
				Error.throwError(TypeError, 2007, "type");
			}

			_type = type;
			_bubbles = bubbles;
			_cancelable = cancelable;
		}

		public static const ACTIVATE:String = "activate";
		public static const ADDED:String = "added";
		public static const ADDED_TO_STAGE:String = "addedToStage";
		public static const BROWSER_ZOOM_CHANGE:String = "browserZoomChange";
		public static const CANCEL:String = "cancel";
		public static const CHANGE:String = "change";
		public static const CLEAR:String = "clear";
		public static const CLOSE:String = "close";
		public static const COMPLETE:String = "complete";
		public static const CONNECT:String = "connect";
		public static const COPY:String = "copy";
		public static const CUT:String = "cut";
		public static const DEACTIVATE:String = "deactivate";
		public static const ENTER_FRAME:String = "enterFrame";
		public static const FRAME_CONSTRUCTED:String = "frameConstructed";
		public static const EXIT_FRAME:String = "exitFrame";
		public static const FRAME_LABEL:String = "frameLabel";
		public static const ID3:String = "id3";
		public static const INIT:String = "init";
		public static const MOUSE_LEAVE:String = "mouseLeave";
		public static const OPEN:String = "open";
		public static const PASTE:String = "paste";
		public static const REMOVED:String = "removed";
		public static const REMOVED_FROM_STAGE:String = "removedFromStage";
		public static const RENDER:String = "render";
		public static const RESIZE:String = "resize";
		public static const SCROLL:String = "scroll";
		public static const TEXT_INTERACTION_MODE_CHANGE:String = "textInteractionModeChange";
		public static const SELECT:String = "select";
		public static const SELECT_ALL:String = "selectAll";
		public static const SOUND_COMPLETE:String = "soundComplete";
		public static const TAB_CHILDREN_CHANGE:String = "tabChildrenChange";
		public static const TAB_ENABLED_CHANGE:String = "tabEnabledChange";
		public static const TAB_INDEX_CHANGE:String = "tabIndexChange";
		public static const UNLOAD:String = "unload";
		public static const FULLSCREEN:String = "fullScreen";
		[API("667")]
		public static const CONTEXT3D_CREATE:String = "context3DCreate";
		[API("667")]
		public static const TEXTURE_READY:String = "textureReady";
		[API("682")]
		public static const VIDEO_FRAME:String = "videoFrame";
		[API("681")]
		public static const SUSPEND:String = "suspend";
		[API("682")]
		public static const CHANNEL_MESSAGE:String = "channelMessage";
		[API("682")]
		public static const CHANNEL_STATE:String = "channelState";
		[API("682")]
		public static const WORKER_STATE:String = "workerState";
		public static const CLOSING:String = "closing";
		public static const EXITING:String = "exiting";
		public static const DISPLAYING:String = "displaying";
		[API("671")]
		public static const PREPARING:String = "preparing";
		public static const NETWORK_CHANGE:String = "networkChange";
		public static const USER_IDLE:String = "userIdle";
		public static const USER_PRESENT:String = "userPresent";
		[API("668")]
		public static const STANDARD_OUTPUT_CLOSE:String = "standardOutputClose";
		[API("668")]
		public static const STANDARD_ERROR_CLOSE:String = "standardErrorClose";
		[API("668")]
		public static const STANDARD_INPUT_CLOSE:String = "standardInputClose";
		public static const HTML_BOUNDS_CHANGE:String = "htmlBoundsChange";
		public static const HTML_RENDER:String = "htmlRender";
		public static const HTML_DOM_INITIALIZE:String = "htmlDOMInitialize";
		public static const LOCATION_CHANGE:String = "locationChange";

		public function formatToString(className:String, ...args):String
		{
			var text:String = "[" + className;
			for (var i:int = 0; i < args.length; i++)
			{
				const key:String = args[i];
				const value:* = this[key];
				text += value is String ? " " + key + "=\"" + value + "\"" : " " + key + "=" + value;
			}

			return text + "]";
		}

		public function clone():Event
		{
			return new Event(type, bubbles, cancelable);
		}

		public function toString():String
		{
			return formatToString("Event", "type", "bubbles", "cancelable", "eventPhase");
		}

		public function get type():String
		{
			return _type;
		}

		public function get bubbles():Boolean
		{
			return _bubbles;
		}

		public function get cancelable():Boolean
		{
			return _cancelable;
		}

		public function get target():Object
		{
			return _target;
		}

		public function get currentTarget():Object
		{
			return _currentTarget;
		}

		public function get eventPhase():uint
		{
			return _eventPhase;
		}

		public function stopPropagation():void
		{
			if (_stopped == 0)
			{
				_stopped = 1;
			}
		}

		public function stopImmediatePropagation():void
		{
			_stopped = 2;
		}

		public function preventDefault():void
		{
			if (_cancelable)
			{
				_prevented = true;
			}
		}

		public function isDefaultPrevented():Boolean
		{
			return _prevented;
		}
	}
}

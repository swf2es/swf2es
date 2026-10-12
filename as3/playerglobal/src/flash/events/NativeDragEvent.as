// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/events/NativeDragEvent.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.events
{

	import flash.desktop.Clipboard;
	import flash.desktop.NativeDragOptions;
	import flash.display.InteractiveObject;

	public class NativeDragEvent extends MouseEvent
	{
		public static const NATIVE_DRAG_COMPLETE:String = "nativeDragComplete";
		public static const NATIVE_DRAG_DROP:String = "nativeDragDrop";
		public static const NATIVE_DRAG_ENTER:String = "nativeDragEnter";
		public static const NATIVE_DRAG_EXIT:String = "nativeDragExit";
		public static const NATIVE_DRAG_OVER:String = "nativeDragOver";
		public static const NATIVE_DRAG_START:String = "nativeDragStart";
		public static const NATIVE_DRAG_UPDATE:String = "nativeDragUpdate";

		public var allowedActions:NativeDragOptions;
		public var clipboard:Clipboard;
		public var dropAction:String;

		public function NativeDragEvent(
				type:String,
				bubbles:Boolean = false,
				cancelable:Boolean = true,
				localX:Number = void 0,
				localY:Number = void 0,
				relatedObject:InteractiveObject = null,
				clipboard:Clipboard = null,
				allowedActions:NativeDragOptions = null,
				dropAction:String = null,
				controlKey:Boolean = false,
				altKey:Boolean = false,
				shiftKey:Boolean = false,
				commandKey:Boolean = false
			)
		{
			super(type, bubbles, cancelable, localX, localY, relatedObject);
		}

		override public function clone():Event
		{
			return new NativeDragEvent(
					this.type,
					this.bubbles,
					this.cancelable,
					this.localX,
					this.localY,
					this.relatedObject,
					this.clipboard,
					this.allowedActions,
					this.dropAction,
					this.controlKey,
					this.altKey,
					this.shiftKey,
					this.commandKey
				);
		}

		override public function toString():String
		{
			return formatToString(
					"NativeDragEvent",
					"type",
					"bubbles",
					"cancelable",
					"localX",
					"localY",
					"stageX",
					"stageY",
					"relatedObject",
					"clipboard",
					"allowedActions",
					"dropAction",
					"controlKey",
					"altKey",
					"shiftKey",
					"commandKey"
				);
		}
	}
}

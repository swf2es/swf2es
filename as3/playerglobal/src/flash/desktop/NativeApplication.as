// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.desktop
{
	import flash.display.NativeMenu;
	import flash.display.NativeWindow;
	import flash.events.Event;
	import flash.events.EventDispatcher;

	public final class NativeApplication extends EventDispatcher
	{
		public function NativeApplication()
		{
		}

		public static native function get nativeApplication():NativeApplication;
		[API("661")]
		public static native function get supportsMenu():Boolean;
		[API("661")]
		public static native function get supportsDockIcon():Boolean;
		[API("661")]
		public static native function get supportsSystemTrayIcon():Boolean;
		[API("668")]
		public static native function get supportsDefaultApplication():Boolean;
		[API("668")]
		public static native function get supportsStartAtLogin():Boolean;
		[API("661")]
		public native function exit(exitCode:int = 0):void;
		[API("661")]
		public native function get runtimeVersion():String;
		[API("661")]
		public native function get runtimePatchLevel():uint;
		[API("661")]
		public native function get applicationID():String;
		[API("661")]
		public native function get publisherID():String;
		[API("661")]
		public native function get applicationDescriptor():XML;
		[API("661")]
		public native function get menu():NativeMenu;
		[API("661")]
		public native function set menu(arg0:NativeMenu):void;
		[API("661")]
		public native function get autoExit():Boolean;
		[API("661")]
		public native function set autoExit(param1:Boolean):void;
		[API("661")]
		public native function get icon():InteractiveIcon;
		[API("668")]
		public native function get systemIdleMode():String;
		[API("668")]
		public native function set systemIdleMode(param1:String):void;
		[API("661")]
		public native function get startAtLogin():Boolean;
		[API("661")]
		public native function set startAtLogin(param1:Boolean):void;
		[API("661")]
		public native function activate(window:NativeWindow = null):void;
		[API("661")]
		public native function get activeWindow():NativeWindow;
		[API("661")]
		public native function get openedWindows():Array;
		[API("661")]
		public native function get timeSinceLastUserInput():int;
		[API("661")]
		public native function get idleThreshold():int;
		[API("661")]
		public native function set idleThreshold(value:int):void;
		public native function copy():Boolean;
		public native function cut():Boolean;
		public native function paste():Boolean;
		public native function clear():Boolean;
		public native function selectAll():Boolean;
		[API("661")]
		public native function getDefaultApplication(extension:String):String;
		[API("661")]
		public native function isSetAsDefaultApplication(extension:String):Boolean;
		[API("661")]
		public native function setAsDefaultApplication(extension:String):void;
		[API("661")]
		public native function removeAsDefaultApplication(extension:String):void;
		[API("681")]
		public native function get executeInBackground():Boolean;
		[API("681")]
		public native function set executeInBackground(param1:Boolean):void;
		[API("661")]
		override public native function addEventListener(arg0:String, arg1:Function, arg2:Boolean = false, arg3:int = 0, arg4:Boolean = false):void;
		[API("661")]
		override public native function removeEventListener(arg0:String, arg1:Function, arg2:Boolean = false):void;
		[API("661")]
		override public native function dispatchEvent(arg0:Event):Boolean;
	}
}

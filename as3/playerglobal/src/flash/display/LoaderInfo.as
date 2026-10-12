// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/display/LoaderInfo.ts.

package flash.display
{
	import flash.utils.ByteArray;
	import flash.system.ApplicationDomain;
	import flash.errors.IllegalOperationError;
	import flash.events.Event;
	import flash.events.EventDispatcher;
	import flash.events.UncaughtErrorEvents;

	public class LoaderInfo extends EventDispatcher
	{
		public function LoaderInfo()
		{
		}

		public static native function getLoaderInfoByDefinition(object:Object):LoaderInfo;

		public native function get loaderURL():String;

		public native function get url():String;

		public native function get isURLInaccessible():Boolean;

		public native function get bytesLoaded():uint;

		public native function get bytesTotal():uint;

		public native function get applicationDomain():ApplicationDomain;

		public native function get swfVersion():uint;

		public native function get actionScriptVersion():uint;

		public native function get frameRate():Number;

		public function get parameters():Object
		{
			return _getArgs();
		}

		public native function get width():int;

		public native function get height():int;

		public native function get contentType():String;

		public native function get sharedEvents():EventDispatcher;

		public native function get parentSandboxBridge():Object;

		public native function set parentSandboxBridge(obj:Object):void;

		public native function get childSandboxBridge():Object;

		public native function set childSandboxBridge(obj:Object):void;

		override public function dispatchEvent(event:Event):Boolean
		{
			Error.throwError(IllegalOperationError, 2118);
			return false;
		}

		public native function get sameDomain():Boolean;

		public native function get childAllowsParent():Boolean;

		public native function get parentAllowsChild():Boolean;

		public native function get loader():Loader;

		public native function get content():DisplayObject;

		public native function get bytes():ByteArray;

		[API("667")]
		public function get uncaughtErrorEvents():UncaughtErrorEvents
		{
			return _getUncaughtErrorEvents();
		}

		// The player's natives (packages/player/src/playerglobal/flash/display/LoaderInfo.ts).
		private native function _getArgs():Object;

		private native function _getUncaughtErrorEvents():UncaughtErrorEvents;

		private native function _setUncaughtErrorEvents(v:UncaughtErrorEvents):void;
	}
}

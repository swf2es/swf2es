// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/display/Loader.ts.

package flash.display
{
	import flash.system.ApplicationDomain;
	import flash.system.SecurityDomain;
	import flash.desktop.IFilePromise;
	import flash.events.UncaughtErrorEvents;
	import flash.net.URLRequest;
	import flash.system.LoaderContext;
	import flash.utils.ByteArray;

	public class Loader extends DisplayObjectContainer
	{
		public function Loader()
		{
		}

		public native function load(request:URLRequest, context:LoaderContext = null):void;

		public native function loadBytes(data:ByteArray, context:LoaderContext = null):void;

		public native function close():void;

		public native function unload():void;

		[API("662")]
		public native function unloadAndStop(gc:Boolean = true):void;

		public native function get content():DisplayObject;

		public native function get contentLoaderInfo():LoaderInfo;

		override public native function addChild(child:DisplayObject):DisplayObject;

		override public native function addChildAt(child:DisplayObject, index:int):DisplayObject;

		override public native function removeChild(child:DisplayObject):DisplayObject;

		override public native function removeChildAt(index:int):DisplayObject;

		override public native function setChildIndex(child:DisplayObject, index:int):void;

		[API("667")]
		public native function get uncaughtErrorEvents():UncaughtErrorEvents;

		[API("669")]
		public native function loadFilePromise(arg0:IFilePromise, arg1:LoaderContext = null):void;

		// The player's natives (packages/player/src/playerglobal/flash/display/Loader.ts).
		private native function _getJPEGLoaderContextdeblockingfilter(context:Object):Number;

		private native function _loadBytes(bytes:ByteArray, checkPolicyFile:Boolean, applicationDomain:ApplicationDomain, securityDomain:SecurityDomain, requestedContentParent:DisplayObjectContainer, parameters:Object, arg6:Number, arg7:Boolean, arg8:String):void;

		private native function _unload(stopAllMovieClips:Boolean, gc:Boolean):void;

		private native function _close():void;

		private native function _getUncaughtErrorEvents():UncaughtErrorEvents;

		private native function _setUncaughtErrorEvents(v:UncaughtErrorEvents):void;

		private native function _load(request:URLRequest, checkPolicyFile:Boolean, applicationDomain:ApplicationDomain, securityDomain:SecurityDomain, requestedContentParent:DisplayObjectContainer, parameters:Object, arg6:Number, arg7:Boolean, arg8:String):void;
	}
}

// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/display/Loader.ts.

package flash.display
{
	import flash.errors.IllegalOperationError;
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

		public function load(request:URLRequest, context:LoaderContext = null):void
		{
			if (request == null)
			{
				Error.throwError(TypeError, 2007, "request");
			}

			const c:LoaderContext = context != null ? context : new LoaderContext();
			_load(request, c.checkPolicyFile, c.applicationDomain, c.securityDomain, c.requestedContentParent, c.parameters, _getJPEGLoaderContextdeblockingfilter(c), c.allowCodeImport, c.imageDecodingPolicy);
		}

		public function loadBytes(data:ByteArray, context:LoaderContext = null):void
		{
			if (data == null)
			{
				Error.throwError(TypeError, 2007, "bytes");
			}

			const c:LoaderContext = context != null ? context : new LoaderContext();
			_loadBytes(data, c.checkPolicyFile, c.applicationDomain, c.securityDomain, c.requestedContentParent, c.parameters, _getJPEGLoaderContextdeblockingfilter(c), c.allowCodeImport, c.imageDecodingPolicy);
		}

		public function close():void
		{
			_close();
		}

		public function unload():void
		{
			_unload(false, false);
		}

		[API("662")]
		public function unloadAndStop(gc:Boolean = true):void
		{
			_unload(true, gc);
		}

		public native function get content():DisplayObject;

		public native function get contentLoaderInfo():LoaderInfo;

		override public function addChild(child:DisplayObject):DisplayObject
		{
			Error.throwError(IllegalOperationError, 2069);
			return null;
		}

		override public function addChildAt(child:DisplayObject, index:int):DisplayObject
		{
			Error.throwError(IllegalOperationError, 2069);
			return null;
		}

		override public function removeChild(child:DisplayObject):DisplayObject
		{
			Error.throwError(IllegalOperationError, 2069);
			return null;
		}

		override public function removeChildAt(index:int):DisplayObject
		{
			Error.throwError(IllegalOperationError, 2069);
			return null;
		}

		override public function setChildIndex(child:DisplayObject, index:int):void
		{
			Error.throwError(IllegalOperationError, 2069);
		}

		[API("667")]
		public function get uncaughtErrorEvents():UncaughtErrorEvents
		{
			return _getUncaughtErrorEvents();
		}

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

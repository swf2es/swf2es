// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/html/HTMLLoader.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.html
{
	import flash.display.NativeWindowInitOptions;
	import flash.geom.Rectangle;
	import flash.net.URLRequest;
	import flash.system.ApplicationDomain;

	import flash.display.Sprite;

	public class HTMLLoader extends Sprite
	{
		public function HTMLLoader()
		{
		}

		// Flash Player's API that Ruffle's source lacks: native, and not implemented.
		public static native function createRootWindow(arg0:Boolean = true, arg1:NativeWindowInitOptions = null, arg2:Boolean = true, arg3:Rectangle = null):HTMLLoader;
		[API("668")]
		public static native function get isSupported():Boolean;
		public static native function get pdfCapability():int;
		[API("668")]
		public static native function get swfCapability():int;
		public native function loadString(arg0:String):void;
		public native function load(arg0:URLRequest):void;
		public native function get loaded():Boolean;
		public native function reload():void;
		public native function cancelLoad():void;
		public native function get location():String;
		public native function get contentWidth():Number;
		public native function get contentHeight():Number;
		override public native function set width(arg0:Number):void;
		override public native function get width():Number;
		override public native function set height(arg0:Number):void;
		override public native function get height():Number;
		public native function get scrollH():Number;
		public native function set scrollH(arg0:Number):void;
		public native function get scrollV():Number;
		public native function set scrollV(arg0:Number):void;
		public native function get window():Object;
		public native function get runtimeApplicationDomain():ApplicationDomain;
		public native function set runtimeApplicationDomain(arg0:ApplicationDomain):void;
		public native function get userAgent():String;
		public native function set userAgent(arg0:String):void;
		public native function get manageCookies():Boolean;
		public native function set manageCookies(arg0:Boolean):void;
		public native function get useCache():Boolean;
		public native function set useCache(arg0:Boolean):void;
		public native function get cacheResponse():Boolean;
		public native function set cacheResponse(arg0:Boolean):void;
		public native function get idleTimeout():Number;
		public native function set idleTimeout(arg0:Number):void;
		public native function get authenticate():Boolean;
		public native function set authenticate(arg0:Boolean):void;
		public native function get placeLoadStringContentInApplicationSandbox():Boolean;
		public native function set placeLoadStringContentInApplicationSandbox(arg0:Boolean):void;
		public native function set paintsDefaultBackground(arg0:Boolean):void;
		public native function get paintsDefaultBackground():Boolean;
		public native function set textEncodingOverride(arg0:String):void;
		public native function get textEncodingOverride():String;
		public native function set textEncodingFallback(arg0:String):void;
		public native function get textEncodingFallback():String;
		public native function get hasFocusableContent():Boolean;
		public native function get htmlHost():HTMLHost;
		public native function set htmlHost(arg0:HTMLHost):void;
		public native function get navigateInSystemBrowser():Boolean;
		public native function set navigateInSystemBrowser(arg0:Boolean):void;
		public native function historyBack():void;
		public native function historyForward():void;
		public native function historyGo(arg0:int):void;
		public native function get historyLength():uint;
		public native function get historyPosition():uint;
		public native function set historyPosition(arg0:uint):void;
		public native function getHistoryAt(arg0:uint):HTMLHistoryItem;
	}
}

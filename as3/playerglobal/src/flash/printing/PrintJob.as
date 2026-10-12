// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/printing/PrintJob.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.printing
{
	import flash.display.Sprite;
	import flash.geom.Rectangle;
	import flash.events.EventDispatcher;

	public class PrintJob extends EventDispatcher
	{

		// Flash Player's API that Ruffle's source lacks: native, and not implemented.
		[API("668")]
		public static native function get supportsPageSetupDialog():Boolean;
		[API("668")]
		public static native function get active():Boolean;
		[API("668")]
		public static native function get printers():Vector.<String>;
		[API("667")]
		public static native function get isSupported():Boolean;
		public native function get paperHeight():int;
		public native function get paperWidth():int;
		public native function get pageHeight():int;
		public native function get pageWidth():int;
		public native function get orientation():String;
		[API("668")]
		public native function set orientation(arg0:String):void;
		[API("668")]
		public native function get printer():String;
		[API("668")]
		public native function set printer(arg0:String):void;
		[API("668")]
		public native function get jobName():String;
		[API("668")]
		public native function set jobName(arg0:String):void;
		[API("668")]
		public native function get paperArea():Rectangle;
		[API("668")]
		public native function get printableArea():Rectangle;
		[API("668")]
		public native function get maxPixelsPerInch():Number;
		[API("668")]
		public native function get isColor():Boolean;
		[API("668")]
		public native function get firstPage():int;
		[API("668")]
		public native function get lastPage():int;
		[API("668")]
		public native function get copies():int;
		[API("668")]
		public native function set copies(arg0:int):void;
		[API("668")]
		public native function showPageSetupDialog():Boolean;
		[API("668")]
		public native function selectPaperSize(arg0:String):void;
		public native function start():Boolean;
		[API("668")]
		public native function start2(arg0:PrintUIOptions = null, arg1:Boolean = true):Boolean;
		public native function send():void;
		[API("668")]
		public native function terminate():void;
		public native function addPage(arg0:Sprite, arg1:Rectangle = null, arg2:PrintJobOptions = null, arg3:int = 0):void;
	}
}

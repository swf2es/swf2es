// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.text
{
	import flash.display.BitmapData;
	import flash.display.Stage;
	import flash.events.EventDispatcher;
	import flash.geom.Rectangle;

	[API("675")]
	public final class StageText extends EventDispatcher
	{
		public function StageText(arg0:StageTextInitOptions = null)
		{
		}

		public native function set editable(arg0:Boolean):void;
		public native function get editable():Boolean;
		public native function set text(arg0:String):void;
		public native function get text():String;
		public native function set fontFamily(arg0:String):void;
		public native function get fontFamily():String;
		public native function set fontSize(arg0:int):*;
		public native function get fontSize():int;
		public native function set color(arg0:uint):*;
		public native function get color():uint;
		public native function set fontWeight(arg0:String):void;
		public native function get fontWeight():String;
		public native function set fontPosture(arg0:String):void;
		public native function get fontPosture():String;
		public native function get displayAsPassword():Boolean;
		public native function set displayAsPassword(arg0:Boolean):void;
		public native function set maxChars(arg0:int):void;
		public native function get maxChars():int;
		public native function get multiline():Boolean;
		public native function set restrict(arg0:String):void;
		public native function get restrict():String;
		public native function set returnKeyLabel(arg0:String):void;
		public native function get returnKeyLabel():String;
		public native function set textAlign(arg0:String):void;
		public native function get textAlign():String;
		public native function get softKeyboardType():String;
		public native function set softKeyboardType(arg0:String):void;
		public native function set autoCapitalize(arg0:String):void;
		public native function get autoCapitalize():String;
		public native function set autoCorrect(arg0:Boolean):void;
		public native function get autoCorrect():Boolean;
		public native function set locale(arg0:String):void;
		public native function get locale():String;
		public native function assignFocus():void;
		public native function selectRange(arg0:int, arg1:int):void;
		public native function get selectionActiveIndex():int;
		public native function get selectionAnchorIndex():int;
		public native function set stage(arg0:Stage):void;
		public native function get stage():Stage;
		public native function set viewPort(arg0:Rectangle):void;
		public native function get viewPort():Rectangle;
		public native function drawViewPortToBitmapData(arg0:BitmapData):void;
		public native function dispose():void;
		public native function get visible():Boolean;
		public native function set visible(arg0:Boolean):void;
	}
}

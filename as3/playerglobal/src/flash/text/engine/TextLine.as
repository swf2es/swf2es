// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.text.engine
{
	import flash.geom.Rectangle;
	import flash.display.DisplayObject;
	import flash.display.DisplayObjectContainer;
	import flash.display.NativeMenu;
	import flash.events.EventDispatcher;

	[API("662")]
	public final class TextLine extends DisplayObjectContainer
	{
		public function TextLine()
		{
		}

		public static const MAX_LINE_WIDTH:int = 1000000;

		override public native function set focusRect(value:Object):void;

		override public native function set tabChildren(value:Boolean):void;

		override public native function set tabEnabled(value:Boolean):void;

		override public native function set tabIndex(index:int):void;

		public var userData:*;

		public native function get textBlock():TextBlock;

		public native function get hasGraphicElement():Boolean;

		[API("667")]
		public native function get hasTabs():Boolean;

		public native function get nextLine():TextLine;

		public native function get previousLine():TextLine;

		public native function get ascent():Number;

		public native function get descent():Number;

		public native function get textHeight():Number;

		public native function get textWidth():Number;

		[API("670")]
		public native function get totalAscent():Number;

		[API("670")]
		public native function get totalDescent():Number;

		[API("670")]
		public native function get totalHeight():Number;

		public native function get textBlockBeginIndex():int;

		public native function get rawTextLength():int;

		public native function get specifiedWidth():Number;

		public native function get unjustifiedTextWidth():Number;

		public native function get validity():String;

		public native function set validity(value:String):void;

		public native function get atomCount():int;

		public native function get mirrorRegions():Vector.<TextLineMirrorRegion>;

		public native function getMirrorRegion(arg0:EventDispatcher):TextLineMirrorRegion;

		public native function flushAtomData():void;

		public native function getAtomIndexAtPoint(stageX:Number, stageY:Number):int;

		public native function getAtomIndexAtCharIndex(charIndex:int):int;

		public native function getAtomBounds(index:int):Rectangle;

		public native function getAtomBidiLevel(index:int):int;

		public native function getAtomTextRotation(index:int):String;

		public native function getAtomTextBlockBeginIndex(index:int):int;

		public native function getAtomTextBlockEndIndex(index:int):int;

		public native function getAtomCenter(index:int):Number;

		public native function getAtomWordBoundaryOnLeft(index:int):Boolean;

		public native function getAtomGraphic(index:int):DisplayObject;

		public native function getBaselinePosition(baseline:String):Number;

		public native function dump():String;

		override public native function set contextMenu(cm:NativeMenu):void;
	}
}

// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/text/ime/IIMEClient.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.text.ime
{
	import flash.geom.Rectangle;

	[API("667")]
	public interface IIMEClient
	{
		function confirmComposition(text:String = null, preserveSelection:Boolean = false):void;

		function getTextBounds(startIndex:int, endIndex:int):Rectangle;

		function getTextInRange(startIndex:int, endIndex:int):String;

		function selectRange(anchorIndex:int, activeIndex:int):void;

		function updateComposition(
				text:String,
				attributes:Vector.<CompositionAttributeRange>,
				compositionStartIndex:int,
				compositionEndIndex:int
			):void;

		function get compositionStartIndex():int;
		function get compositionEndIndex():int;

		function get selectionAnchorIndex():int;

		function get selectionActiveIndex():int;

		function get verticalTextLayout():Boolean;
	}
}

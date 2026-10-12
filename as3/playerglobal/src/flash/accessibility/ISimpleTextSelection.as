// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/accessibility/ISimpleTextSelection.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.accessibility
{
	[API("667")]
	public interface ISimpleTextSelection
	{
		function get selectionActiveIndex():int;
		function get selectionAnchorIndex():int;
	}
}

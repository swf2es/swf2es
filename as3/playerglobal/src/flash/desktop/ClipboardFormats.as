// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/desktop/ClipboardFormats.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.desktop
{
	// The AS3 docs specify various API versions for the different members,
	// as also indicated by their comments. The docs, however, are lying.
	[API("661", "662")]
	public class ClipboardFormats
	{
		public static const BITMAP_FORMAT:String = "air:bitmap";
		public static const FILE_LIST_FORMAT:String = "air:file list";
		public static const FILE_PROMISE_LIST_FORMAT:String = "air:file promise list";
		public static const HTML_FORMAT:String = "air:html";
		public static const RICH_TEXT_FORMAT:String = "air:rtf";
		public static const TEXT_FORMAT:String = "air:text";
		public static const URL_FORMAT:String = "air:url";
	}
}

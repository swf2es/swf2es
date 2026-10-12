// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/desktop/ClipboardTransferMode.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.desktop
{
	[API("661", "662")]
	public class ClipboardTransferMode
	{
		public static const CLONE_ONLY:String = "cloneOnly";
		public static const CLONE_PREFERRED:String = "clonePreferred";
		public static const ORIGINAL_ONLY:String = "originalOnly";
		public static const ORIGINAL_PREFERRED:String = "originalPreferred";
	}
}

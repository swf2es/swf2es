// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/net/URLRequestHeader.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.net
{
	public final class URLRequestHeader
	{
		public var name:String;

		public var value:String;

		public function URLRequestHeader(name:String = "", value:String = "")
		{
			this.name = name;
			this.value = value;
		}
	}
}

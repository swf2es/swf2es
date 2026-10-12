// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/net/URLVariables.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.net
{
	import flash.utils.escapeMultiByte;
	import flash.utils.unescapeMultiByte;

	public dynamic class URLVariables
	{
		public function URLVariables(str:String = null)
		{
			if (str)
			{
				this.decode(str);
			}
		}

		public function decode(str:String):void
		{
			const pairs:Array = str.AS3::split("&");
			for (var i:int = 0; i < pairs.length; i++)
			{
				var pair:String = pairs[i];
				const splitIndex:int = pair.AS3::indexOf("=");
				if (splitIndex === -1)
				{
					throw new Error("Error #2101: The String passed to URLVariables.decode() must be a URL-encoded query string containing name/value pairs.", 2101);
				}
				pair = pair.AS3::replace("+", " ");
				const prop:String = unescapeMultiByte(pair.AS3::slice(0, splitIndex));
				const val:String = unescapeMultiByte(pair.AS3::slice(splitIndex + 1));
				if (this[prop] == null)
				{
					this[prop] = val;
				}
				else if (this[prop] is Array)
				{
					this[prop].push(val);
				}
				else
				{
					this[prop] = [this[prop], val];
				}
			}
		}

		public function toString():String
		{
			var acc:String = "";
			var sep:String = "";
			for (var p:String in this)
			{
				var pe:String = escapeMultiByte(p);
				const val:* = this[p];
				if (val is Array)
				{
					for (var i:String in val)
					{
						acc += sep;
						acc += pe;
						acc += "=";
						acc += escapeMultiByte(val[i]);
						sep = "&";
					}
					continue;
				}
				acc += sep;
				acc += pe;
				acc += "=";
				acc += escapeMultiByte(val);
				sep = "&";
			}
			return acc;
		}
	}
}

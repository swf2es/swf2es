// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/desktop/IFilePromise.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.desktop
{
	import flash.utils.IDataInput;
	import flash.events.ErrorEvent;

	[API("668")]
	// AIR 2.0
	[API("668")]
	public interface IFilePromise
	{
		function get isAsync():Boolean;
		function get relativePath():String;
		function close():void;
		function open():IDataInput;
		function reportError(e:ErrorEvent):void;
	}
}

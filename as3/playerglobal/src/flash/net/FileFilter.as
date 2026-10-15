// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/net/FileFilter.ts.

package flash.net
{
	public final class FileFilter
	{
		public function FileFilter(description:String, extension:String, macType:String = null)
		{
			this.description = description;
			this.extension = extension;
			this.macType = macType;
		}

		public native function get description():String;

		public native function set description(val:String):void;

		public native function get extension():String;

		public native function set extension(val:String):void;

		public native function get macType():String;

		public native function set macType(val:String):void;
	}
}

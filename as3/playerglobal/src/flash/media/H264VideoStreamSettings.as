// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.media
{
	[API("674")]
	public class H264VideoStreamSettings extends VideoStreamSettings
	{
		public function H264VideoStreamSettings()
		{
		}

		override public native function get codec():String;
		public native function setProfileLevel(arg0:String, arg1:String):void;
		public native function get profile():String;
		public native function get level():String;
	}
}

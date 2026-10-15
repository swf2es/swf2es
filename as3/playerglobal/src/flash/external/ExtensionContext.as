// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.external
{
	import flash.filesystem.File;
	import flash.events.EventDispatcher;

	[API("669")]
	public final class ExtensionContext extends EventDispatcher
	{
		public function ExtensionContext()
		{
		}

		public static native function createExtensionContext(extensionID:String, contextType:String):ExtensionContext;

		public static native function getExtensionDirectory(arg0:String):File;

		public native function call(functionName:String, ...rest):Object;

		public native function get actionScriptData():Object;

		public native function set actionScriptData(arg0:Object):void;

		public native function dispose():void;
	}
}

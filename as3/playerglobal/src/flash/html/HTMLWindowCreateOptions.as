// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.html
{
	[API("661")]
	public class HTMLWindowCreateOptions
	{
		public function HTMLWindowCreateOptions()
		{
		}

		public var x:Number = NaN;
		public var y:Number = NaN;
		public var width:Number = NaN;
		public var height:Number = NaN;
		public var menuBarVisible:Boolean = false;
		public var statusBarVisible:Boolean = false;
		public var toolBarVisible:Boolean = false;
		public var locationBarVisible:Boolean = false;
		public var scrollBarsVisible:Boolean = true;
		public var resizable:Boolean = false;
		public var fullscreen:Boolean = false;
	}
}

// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/display/DisplayObjectContainer.ts.

package flash.display
{
	import flash.geom.Point;
	import flash.text.TextSnapshot;

	public class DisplayObjectContainer extends InteractiveObject
	{
		public function DisplayObjectContainer()
		{
		}

		public native function addChild(child:DisplayObject):DisplayObject;
		public native function addChildAt(child:DisplayObject, index:int):DisplayObject;
		public native function removeChild(child:DisplayObject):DisplayObject;
		public native function removeChildAt(index:int):DisplayObject;
		public native function getChildIndex(child:DisplayObject):int;
		public native function setChildIndex(child:DisplayObject, index:int):void;
		public native function getChildAt(index:int):DisplayObject;
		public native function getChildByName(name:String):DisplayObject;
		public native function get numChildren():int;
		public native function get textSnapshot():TextSnapshot;
		public native function getObjectsUnderPoint(point:Point):Array;
		public native function areInaccessibleObjectsUnderPoint(point:Point):Boolean;
		public native function get tabChildren():Boolean;
		public native function set tabChildren(value:Boolean):void;
		public native function get mouseChildren():Boolean;
		public native function set mouseChildren(value:Boolean):void;
		public native function contains(child:DisplayObject):Boolean;
		public native function swapChildrenAt(index1:int, index2:int):void;
		public native function swapChildren(child1:DisplayObject, child2:DisplayObject):void;
		[API("674")]
		public native function removeChildren(beginIndex:int = 0, endIndex:int = 2147483647):void;
		[API("690")]
		public native function stopAllMovieClips():void;
	}
}

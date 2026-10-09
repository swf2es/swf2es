// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/display/Stage.ts.

package flash.display
{
	import flash.errors.IllegalOperationError;
	import flash.accessibility.AccessibilityImplementation;
	import flash.accessibility.AccessibilityProperties;
	import flash.events.Event;
	import flash.geom.Rectangle;
	import flash.geom.Transform;
	import flash.media.StageVideo;
	import flash.text.TextSnapshot;

	public class Stage extends DisplayObjectContainer
	{
		public function Stage()
		{
		}

		[API("668")]
		public static native function get supportsOrientationChange():Boolean;

		public native function get frameRate():Number;

		public native function set frameRate(value:Number):void;

		public native function invalidate():void;

		public native function get scaleMode():String;

		public native function set scaleMode(value:String):void;

		public native function get align():String;

		public native function set align(value:String):void;

		public native function get stageWidth():int;

		public native function set stageWidth(value:int):void;

		public native function get stageHeight():int;

		public native function set stageHeight(value:int):void;

		public native function get showDefaultContextMenu():Boolean;

		public native function set showDefaultContextMenu(value:Boolean):void;

		public native function get focus():InteractiveObject;

		public native function set focus(value:InteractiveObject):void;

		[API("662")]
		public native function get colorCorrection():String;

		[API("662")]
		public native function set colorCorrection(value:String):void;

		[API("662")]
		public native function get colorCorrectionSupport():String;

		public native function isFocusInaccessible():Boolean;

		public native function get stageFocusRect():Boolean;

		public native function set stageFocusRect(value:Boolean):void;

		public native function get quality():String;

		public native function set quality(value:String):void;

		public native function get displayState():String;

		public native function set displayState(value:String):void;

		public native function get fullScreenSourceRect():Rectangle;

		public native function set fullScreenSourceRect(rect:Rectangle):void;

		[API("678")]
		public native function get mouseLock():Boolean;

		[API("678")]
		public native function set mouseLock(value:Boolean):void;

		[API("667")]
		public native function get stageVideos():Vector.<StageVideo>;

		[API("674")]
		public native function get stage3Ds():Vector.<Stage3D>;

		[API("670")]
		public native function get color():uint;

		[API("670")]
		public native function set color(value:uint):void;

		public native function get fullScreenWidth():uint;

		public native function get fullScreenHeight():uint;

		[API("665")]
		public native function get wmodeGPU():Boolean;

		[API("670")]
		public native function get softKeyboardRect():Rectangle;

		override public function set name(value:String):void
		{
			Error.throwError(IllegalOperationError, 2071);
		}

		override public function set mask(value:DisplayObject):void
		{
			Error.throwError(IllegalOperationError, 2071);
		}

		override public function set visible(value:Boolean):void
		{
			Error.throwError(IllegalOperationError, 2071);
		}

		override public function set x(value:Number):void
		{
			Error.throwError(IllegalOperationError, 2071);
		}

		override public function set y(value:Number):void
		{
			Error.throwError(IllegalOperationError, 2071);
		}

		[API("662")]
		override public function set z(value:Number):void
		{
			Error.throwError(IllegalOperationError, 2071);
		}

		override public function set scaleX(value:Number):void
		{
			Error.throwError(IllegalOperationError, 2071);
		}

		override public function set scaleY(value:Number):void
		{
			Error.throwError(IllegalOperationError, 2071);
		}

		[API("662")]
		override public function set scaleZ(value:Number):void
		{
			Error.throwError(IllegalOperationError, 2071);
		}

		override public function set rotation(value:Number):void
		{
			Error.throwError(IllegalOperationError, 2071);
		}

		[API("662")]
		override public function set rotationX(value:Number):void
		{
			Error.throwError(IllegalOperationError, 2071);
		}

		[API("662")]
		override public function set rotationY(value:Number):void
		{
			Error.throwError(IllegalOperationError, 2071);
		}

		[API("662")]
		override public function set rotationZ(value:Number):void
		{
			Error.throwError(IllegalOperationError, 2071);
		}

		override public function set alpha(value:Number):void
		{
			Error.throwError(IllegalOperationError, 2071);
		}

		override public function set cacheAsBitmap(value:Boolean):void
		{
			Error.throwError(IllegalOperationError, 2071);
		}

		override public function set opaqueBackground(value:Object):void
		{
			Error.throwError(IllegalOperationError, 2071);
		}

		override public function set scrollRect(value:Rectangle):void
		{
			Error.throwError(IllegalOperationError, 2071);
		}

		override public function set filters(value:Array):void
		{
			Error.throwError(IllegalOperationError, 2071);
		}

		override public function set blendMode(value:String):void
		{
			Error.throwError(IllegalOperationError, 2071);
		}

		override public function set transform(value:Transform):void
		{
			Error.throwError(IllegalOperationError, 2071);
		}

		override public function set accessibilityProperties(value:AccessibilityProperties):void
		{
			Error.throwError(IllegalOperationError, 2071);
		}

		override public function set scale9Grid(value:Rectangle):void
		{
			Error.throwError(IllegalOperationError, 2071);
		}

		override public function set tabEnabled(value:Boolean):void
		{
			Error.throwError(IllegalOperationError, 2071);
		}

		override public function set tabIndex(value:int):void
		{
			Error.throwError(IllegalOperationError, 2071);
		}

		override public function set focusRect(value:Object):void
		{
			Error.throwError(IllegalOperationError, 2071);
		}

		override public function set mouseEnabled(value:Boolean):void
		{
			Error.throwError(IllegalOperationError, 2071);
		}

		override public function set accessibilityImplementation(value:AccessibilityImplementation):void
		{
			Error.throwError(IllegalOperationError, 2071);
		}

		override public function addChild(child:DisplayObject):DisplayObject
		{
			requireOwnerPermissions();
			return super.addChild(child);
		}

		override public function addChildAt(child:DisplayObject, index:int):DisplayObject
		{
			requireOwnerPermissions();
			return super.addChildAt(child, index);
		}

		override public function setChildIndex(child:DisplayObject, index:int):void
		{
			requireOwnerPermissions();
			super.setChildIndex(child, index);
		}

		override public function addEventListener(type:String, listener:Function, useCapture:Boolean = false, priority:int = 0, useWeakReference:Boolean = false):void
		{
			requireOwnerPermissions();
			super.addEventListener(type, listener, useCapture, priority, useWeakReference);
		}

		override public function dispatchEvent(event:Event):Boolean
		{
			requireOwnerPermissions();
			return super.dispatchEvent(event);
		}

		override public function hasEventListener(type:String):Boolean
		{
			requireOwnerPermissions();
			return super.hasEventListener(type);
		}

		override public function willTrigger(type:String):Boolean
		{
			requireOwnerPermissions();
			return super.willTrigger(type);
		}

		override public function get width():Number
		{
			requireOwnerPermissions();
			return super.width;
		}

		override public function set width(value:Number):void
		{
			Error.throwError(IllegalOperationError, 2071);
		}

		override public function get height():Number
		{
			requireOwnerPermissions();
			return super.height;
		}

		override public function set height(value:Number):void
		{
			Error.throwError(IllegalOperationError, 2071);
		}

		override public function get textSnapshot():TextSnapshot
		{
			Error.throwError(IllegalOperationError, 2071);
			return null;
		}

		override public function get mouseChildren():Boolean
		{
			requireOwnerPermissions();
			return super.mouseChildren;
		}

		override public function set mouseChildren(value:Boolean):void
		{
			requireOwnerPermissions();
			super.mouseChildren = value;
		}

		override public function get numChildren():int
		{
			requireOwnerPermissions();
			return super.numChildren;
		}

		override public function get tabChildren():Boolean
		{
			requireOwnerPermissions();
			return super.tabChildren;
		}

		override public function set tabChildren(value:Boolean):void
		{
			requireOwnerPermissions();
			super.tabChildren = value;
		}

		[API("670")]
		public native function get allowsFullScreen():Boolean;

		[API("680")]
		public native function get allowsFullScreenInteractive():Boolean;

		override public native function removeChildAt(index:int):DisplayObject;

		override public native function swapChildrenAt(index1:int, index2:int):void;

		[API("682")]
		public native function get contentsScaleFactor():Number;

		[API("700")]
		public native function get browserZoomFactor():Number;

		[API("674")]
		public native function get displayContextInfo():String;

		public native function get constructor():*;

		public native function set constructor(value:*):*;

		[API("661")]
		public native function assignFocus(arg0:InteractiveObject, arg1:String):void;

		[API("661")]
		public native function get nativeWindow():NativeWindow;

		[API("668")]
		public native function get orientation():String;

		[API("668")]
		public native function setOrientation(newOrientation:String):void;

		[API("668")]
		public native function setAspectRatio(newAspectRatio:String):void;

		[API("668")]
		public native function get deviceOrientation():String;

		[API("668")]
		public native function get autoOrients():Boolean;

		[API("671")]
		public function set autoOrients(value:Boolean):void
		{
			setAutoOrients(value);
		}

		[API("671")]
		public native function get supportedOrientations():Vector.<String>;

		override public function set contextMenu(value:NativeMenu):void
		{
			Error.throwError(IllegalOperationError, 2071);
		}

		// The player's natives (packages/player/src/playerglobal/flash/display/Stage.ts).
		private native function requireOwnerPermissions():void;

		private native function setAutoOrients(v:Boolean):void;
	}
}

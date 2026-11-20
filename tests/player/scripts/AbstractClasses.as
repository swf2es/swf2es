package
{
	import flash.accessibility.Accessibility;
	import flash.concurrent.Condition;
	import flash.display.AVM1Movie;
	import flash.display.DisplayObject;
	import flash.display.DisplayObjectContainer;
	import flash.display.Graphics;
	import flash.display.InteractiveObject;
	import flash.display.LoaderInfo;
	import flash.display.MorphShape;
	import flash.display.Sprite;
	import flash.display.Stage;
	import flash.display.Stage3D;
	import flash.display3D.Context3D;
	import flash.display3D.IndexBuffer3D;
	import flash.display3D.Program3D;
	import flash.display3D.VertexBuffer3D;
	import flash.display3D.textures.CubeTexture;
	import flash.display3D.textures.RectangleTexture;
	import flash.display3D.textures.Texture;
	import flash.display3D.textures.TextureBase;
	import flash.events.EventDispatcher;
	import flash.external.ExternalInterface;
	import flash.filters.BitmapFilter;
	import flash.filters.ConvolutionFilter;
	import flash.geom.Utils3D;
	import flash.media.StageVideo;
	import flash.net.ObjectEncoding;
	import flash.net.SharedObject;
	import flash.net.drm.DRMManager;
	import flash.net.drm.DRMPlaybackTimeWindow;
	import flash.net.drm.DRMVoucher;
	import flash.system.Capabilities;
	import flash.system.IME;
	import flash.system.MessageChannel;
	import flash.system.Security;
	import flash.system.SecurityDomain;
	import flash.system.System;
	import flash.system.Worker;
	import flash.system.WorkerDomain;
	import flash.text.StaticText;
	import flash.text.TextSnapshot;
	import flash.text.engine.ContentElement;
	import flash.text.engine.TextLine;
	import flash.text.engine.TextLineMirrorRegion;
	import flash.ui.GameInputControl;
	import flash.ui.Keyboard;
	import flash.ui.Mouse;
	import flash.ui.Multitouch;
	import flash.utils.getQualifiedClassName;

	// Which of the player's classes a script may not construct, and which
	// of their subclasses: what Flash throws for each, or that it made one.
	public class AbstractClasses extends Sprite
	{
		public function AbstractClasses()
		{
			const classes:Array = [Accessibility, AVM1Movie, Capabilities, Context3D, CubeTexture,
				DisplayObject, DisplayObjectContainer, DRMManager, DRMPlaybackTimeWindow, DRMVoucher,
				ExternalInterface, GameInputControl, Graphics, IME, IndexBuffer3D, InteractiveObject,
				JSON, Keyboard, LoaderInfo, MessageChannel, MorphShape, Mouse, Multitouch,
				ObjectEncoding, Program3D, RectangleTexture, Security, SecurityDomain, SharedObject,
				Stage, Stage3D, StageVideo, StaticText, System, TextLine, TextLineMirrorRegion,
				TextSnapshot, Texture, TextureBase, Utils3D, VertexBuffer3D, Worker,
				WorkerDomain, ContentElement, BitmapFilter, Condition, MyDisplayObject,
				MyInteractiveObject, MyContainer, MyFilter, MyConvolution, MyGameInputControl,
				MyDispatcher, MyVertexBuffer3D, MySecurityDomain];
			for (var i:int = 0; i < classes.length; i++)
			{
				const c:Class = classes[i];
				try
				{
					const o:Object = c == Condition ? new c(null) : new c();
					trace(getQualifiedClassName(c) + ": made " + getQualifiedClassName(o));
				}
				catch (e:Error)
				{
					trace(getQualifiedClassName(c) + ": " + e);
				}
			}
		}
	}
}

import flash.display.DisplayObject;
import flash.display.DisplayObjectContainer;
import flash.display.InteractiveObject;
import flash.display3D.VertexBuffer3D;
import flash.events.EventDispatcher;
import flash.filters.BitmapFilter;
import flash.filters.ConvolutionFilter;
import flash.system.SecurityDomain;
import flash.ui.GameInputControl;

class MyDisplayObject extends DisplayObject
{
}

class MyInteractiveObject extends InteractiveObject
{
}

class MyContainer extends DisplayObjectContainer
{
}

class MyFilter extends BitmapFilter
{
}

class MyConvolution extends ConvolutionFilter
{
}

class MyGameInputControl extends GameInputControl
{
}

class MyDispatcher extends EventDispatcher
{
}

class MyVertexBuffer3D extends VertexBuffer3D
{
}

class MySecurityDomain extends SecurityDomain
{
}

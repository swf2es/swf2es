// Display objects made, added and removed by script, as a game's bullets
// and particles come and go: Sprites, the library's "ball" (a MovieClip
// of one shape, linked to Ball) and Shapes drawn by script, each added to
// a layer on the stage and removed again; children found by name; and
// children moved between indices. Each section traces what its function
// returns, the work players are compared by, runs it a tenth of its rounds
// to warm up, then times its rounds by the Date, as avm1/Bench.as does.
package
{
	import flash.display.MovieClip;
	import flash.display.Sprite;

	// The library's "ball", a square 10 pixels wide.
	public class Ball extends MovieClip
	{
	}

	public class Main extends Sprite
	{
		public function Main()
		{
			var layer:Sprite = new Sprite();
			addChild(layer);
			bench("sprite-add-remove", 200, function():String
				{
					return spriteAddRemove(layer);
				});
			bench("clip-add-remove", 200, function():String
				{
					return clipAddRemove(layer);
				});
			bench("shape-add-remove", 200, function():String
				{
					return shapeAddRemove(layer);
				});
			bench("by-name", 200, function():String
				{
					return byName(layer);
				});
			bench("reorder", 200, function():String
				{
					return reorder(layer);
				});
			trace("players: done");
		}
	}
}

import flash.display.DisplayObject;
import flash.display.MovieClip;
import flash.display.Shape;
import flash.display.Sprite;

const COUNT:int = 300;

function bench(name:String, rounds:int, f:Function):void
{
	trace(name + " " + f());
	for (var w:int = 0; w < rounds / 10; w++)
	{
		f();
	}

	var started:Number = new Date().time;
	for (var r:int = 0; r < rounds; r++)
	{
		f();
	}
	trace("time: " + name + " " + (new Date().time - started));
}

var made:Vector.<DisplayObject> = new Vector.<DisplayObject>(COUNT);

function spriteAddRemove(layer:Sprite):String
{
	var s:Number = 0;
	for (var i:int = 0; i < COUNT; i++)
	{
		var c:Sprite = new Sprite();
		c.x = i % 100;
		c.y = i >> 2;
		layer.addChild(c);
		made[i] = c;
		s += layer.numChildren;
	}

	for (var j:int = 0; j < COUNT; j++)
	{
		var b:DisplayObject = made[j];
		s += b.x + b.y;
		layer.removeChild(b);
	}
	return s + " " + layer.numChildren;
}

// Ball's bounds are what width reads.
function clipAddRemove(layer:Sprite):String
{
	var s:Number = 0;
	for (var i:int = 0; i < COUNT; i++)
	{
		var c:MovieClip = new Ball();
		c.x = i % 100;
		c.scaleX = 1 + (i & 3);
		layer.addChild(c);
		s += c.width + c.totalFrames;
	}

	while (layer.numChildren > 0)
	{
		s += layer.removeChildAt(layer.numChildren - 1).x;
	}
	return s + " " + layer.numChildren;
}

function shapeAddRemove(layer:Sprite):String
{
	var s:Number = 0;
	for (var i:int = 0; i < COUNT; i++)
	{
		var c:Shape = new Shape();
		c.graphics.beginFill(0x3366cc, (i % 100) / 100);
		c.graphics.drawRect(0, 0, 4 + (i & 7), 4);
		c.graphics.endFill();
		c.alpha = (i % 100) / 100;
		layer.addChild(c);
		s += c.width + Math.round(c.alpha * 100);
	}

	layer.removeChildren();
	return s + " " + layer.numChildren;
}

// Named children found as a timeline's script finds them, then removed by name.
function byName(layer:Sprite):String
{
	var s:Number = 0;
	for (var i:int = 0; i < COUNT; i++)
	{
		var c:Sprite = new Sprite();
		c.name = "b" + i;
		c.x = i % 100;
		layer.addChild(c);
	}

	for (var j:int = 0; j < COUNT; j++)
	{
		var b:DisplayObject = layer.getChildByName("b" + ((j * 7) % COUNT));
		s += b.x;
	}

	for (var k:int = 0; k < COUNT; k++)
	{
		layer.removeChild(layer.getChildByName("b" + k));
	}
	return s + " " + layer.numChildren;
}

// Children kept on the layer and moved: the last brought to the bottom, two swapped, one raised to the top.
var kept:Vector.<Sprite> = new Vector.<Sprite>();
for (var at:int = 0; at < COUNT; at++)
{
	var keep:Sprite = new Sprite();
	keep.x = at;
	kept.push(keep);
}

function reorder(layer:Sprite):String
{
	for (var i:int = 0; i < COUNT; i++)
	{
		layer.addChild(kept[i]);
	}

	var s:Number = 0;
	for (var j:int = 0; j < COUNT; j++)
	{
		layer.addChildAt(layer.getChildAt(COUNT - 1), 0);
		layer.swapChildrenAt(j, (j * 31) % COUNT);
		layer.setChildIndex(kept[(j * 17) % COUNT], COUNT - 1);
		s += layer.getChildIndex(kept[j]) + layer.getChildAt(j).x;
	}

	layer.removeChildren();
	return s + " " + layer.numChildren;
}

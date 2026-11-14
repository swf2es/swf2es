package
{
	// Untyped property access as large Flash applications write it: display
	// objects deep in a class hierarchy reached through *, data objects
	// decoded from JSON, dynamic Objects, untyped Arrays and getters, setters
	// and methods called by name.
	public class Node
	{
		public var name:String = "";
		public var parent:* = null;
		private var _x:Number = 0;
		private var _visible:Boolean = true;
		public function get x():Number
		{
			return _x;
		}
		public function set x(v:Number):void
		{
			_x = v;
		}
		public function get visible():Boolean
		{
			return _visible;
		}
		public function set visible(v:Boolean):void
		{
			_visible = v;
		}
		public function addEventListener(type:String, f:Function):void
		{
			listeners.push(f);
		}
		public var listeners:Array = [];
	}
}
class Container extends Node
{
	public var children:Array = [];
	public function addChild(c:*):*
	{
		children.push(c);
		c.parent = this;
		return c;
	}
	public function getChildAt(i:int):*
	{
		return children[i];
	}
	public function get numChildren():int
	{
		return children.length;
	}
}
class Sprite extends Container
{
	public var graphics:Object = {};
}
class Clip extends Sprite
{
	public var currentFrame:int = 1;
	public function gotoAndStop(f:int):void
	{
		currentFrame = f;
	}
}
dynamic class Timeline extends Clip
{
	public var cnt:* = null;
	public var bg:* = null;
}
class Avatar extends Clip
{
	public var objData:* = null;
	public var pMC:* = null;
	public var dataLeaf:Object = null;
	public function getName():String
	{
		return objData.strUsername;
	}
}
class World extends Clip
{
	public var myAvatar:* = null;
	public var avatars:Object = {};
	public var uid:int = 0;
}
class Game extends Clip
{
	public var world:* = null;
	public var ui:* = null;
	public var litePreference:* = {data: {bDebugger: false, bHideNames: true}};
}

const json:String = '{"sName":"Hero","intLevel":42,"iQty":3,"items":[' +
	'{"ItemID":1,"sName":"Sword","sType":"Weapon","iQty":1,"bEquip":true},' +
	'{"ItemID":2,"sName":"Shield","sType":"Armor","iQty":1,"bEquip":false},' +
	'{"ItemID":3,"sName":"Potion","sType":"Item","iQty":12,"bEquip":false},' +
	'{"ItemID":4,"sName":"Helm","sType":"Helm","iQty":1,"bEquip":true}]}';

function build():*
{
	var game:* = new Game();
	game.world = new World();
	game.ui = new Timeline();
	game.ui.cnt = new Clip();
	game.ui.bg = new Sprite();
	var w:* = game.world;
	for (var i:int = 0; i < 20; i++)
	{
		var a:* = new Avatar();
		a.name = "a" + i;
		a.objData = JSON.parse(json);
		a.objData.strUsername = "user" + i;
		a.pMC = new Timeline();
		a.pMC.mcChar = new Clip();
		w.avatars[i] = a;
		w.addChild(a);
	}
	w.myAvatar = w.avatars[0];
	return game;
}

var game:* = build();

function displayLoop(n:int):Number
{
	var sum:Number = 0;
	for (var k:int = 0; k < n; k++)
	{
		var w:* = game.world;
		for (var i:int = 0; i < w.numChildren; i++)
		{
			var c:* = w.getChildAt(i);
			c.x = c.x + 1;
			c.visible = !c.visible;
			c.pMC.mcChar.gotoAndStop((k & 3) + 1);
			sum += c.pMC.mcChar.currentFrame;
			if (game.litePreference.data.bHideNames)
			{
				sum += c.name.length;
			}
		}
		game.ui.cnt.x = k;
		game.ui.bg.visible = (k & 1) == 0;
	}
	return sum;
}

function dataLoop(n:int):Number
{
	var sum:Number = 0;
	for (var k:int = 0; k < n; k++)
	{
		var me:* = game.world.myAvatar;
		var items:* = me.objData.items;
		for (var i:int = 0; i < items.length; i++)
		{
			var it:* = items[i];
			if (it.sType == "Item")
			{
				sum += it.iQty;
			}
			else if (it.bEquip)
			{
				sum += it.ItemID;
			}
			it.iSel = k;
		}
		sum += me.objData.intLevel + me.getName().length + me.objData.sName.toLowerCase().length;
	}
	return sum;
}

function objectLoop(n:int):Number
{
	var sum:Number = 0;
	var o:Object = {a: 1, b: 2, c: 3};
	var arr:Array = [];
	for (var k:int = 0; k < n; k++)
	{
		o.a = o.b + o.c;
		o["d" + (k & 7)] = k;
		arr.push(o.a);
		if (arr.length > 64)
		{
			arr.length = 0;
		}
		sum += o.a + arr.length;
	}
	return sum;
}

// The same names on objects of many classes, as a game's code reads x, visible
// and the like from whatever display object it holds.
var mixed:Array = [new Avatar(), new Clip(), new Sprite(), new Timeline(), new World(), new Game(), new Container(), new Node()];

function polyLoop(n:int):Number
{
	var sum:Number = 0;
	for (var k:int = 0; k < n; k++)
	{
		for (var i:int = 0; i < mixed.length; i++)
		{
			var c:* = mixed[i];
			c.x = c.x + 1;
			c.visible = !c.visible;
			sum += c.name.length + c.listeners.length;
		}
	}
	return sum;
}

function stringLoop(n:int):Number
{
	var sum:Number = 0;
	var s:* = "Hello World";
	for (var k:int = 0; k < n; k++)
	{
		sum += s.toLowerCase().length + s.indexOf("o") + s.length;
	}
	return sum;
}

// A renderer's name-to-register table, and changing keys beyond the bounded cache.
var registerNames:Array = [];
var registers:Object = {};
for (var register:int = 0; register < 1024; register++)
{
	var registerName:String = "register" + register;
	registerNames.push(registerName);
	registers[registerName] = {index: register};
}

function namesLoop(n:int, mask:int):Number
{
	var sum:Number = 0;
	for (var k:int = 0; k < n; k++)
	{
		var name:String = registerNames[k & mask];
		sum += registers[name].index;
	}
	return sum;
}

// A table of objects by whole-number handles, as a program compiled from C keeps its host's.
import flash.utils.Dictionary;
var handles:Dictionary = new Dictionary();
for (var handle:int = 0; handle < 64; handle++)
{
	handles[4278000 + handle * 8] = {index: handle};
}

function handlesLoop(n:int):Number
{
	var sum:Number = 0;
	for (var k:int = 0; k < n; k++)
	{
		var at:int = 4278000 + (k & 63) * 8;
		sum += handles[at].index;
	}
	return sum;
}

// A name read on more classes than its cache keeps, as a physics engine's
// vectors' x and y are read where every display object's are, then mostly
// on one class.
class P0
{
	public var px:Number = 1;
	public var py:Number = 2;
}
class P1 extends P0
{
}
class P2 extends P0
{
}
class P3 extends P0
{
}
class P4 extends P0
{
}
class P5 extends P0
{
}
class P6 extends P0
{
}
class P7 extends P0
{
}
class P8 extends P0
{
}
class P9 extends P0
{
}
class P10 extends P0
{
}
class P11 extends P0
{
}
class P12 extends P0
{
}
class P13 extends P0
{
}
class P14 extends P0
{
}
class P15 extends P0
{
}
class P16 extends P0
{
}
class P17 extends P0
{
}
class P18 extends P0
{
}
class P19 extends P0
{
}
class P20 extends P0
{
}
class P21 extends P0
{
}
class P22 extends P0
{
}
class P23 extends P0
{
}
class P24 extends P0
{
}
class Vec2
{
	public var px:Number = 0.5;
	public var py:Number = 0.25;
}
var shapes:Array = [
		new P0(), new P1(), new P2(), new P3(), new P4(),
		new P5(), new P6(), new P7(), new P8(), new P9(),
		new P10(), new P11(), new P12(), new P13(), new P14(),
		new P15(), new P16(), new P17(), new P18(), new P19(),
		new P20(), new P21(), new P22(), new P23(), new P24()
	];
var vecs:Array = [new Vec2(), new Vec2(), new Vec2(), new Vec2()];

function manyLoop(n:int):Number
{
	var sum:Number = 0;
	for (var i:int = 0; i < shapes.length; i++)
	{
		var s:* = shapes[i];
		sum += s.px + s.py;
	}
	for (var k:int = 0; k < n; k++)
	{
		var v:* = vecs[k & 3];
		v.px = v.py * 0.5 + 0.125;
		sum += v.px * v.py;
	}
	return sum;
}

// Methods a script gives a class's prototype, called on its sealed objects
// by name, as an obfuscator's code calls them.
class Body
{
	public var m:Number = 2;
}
Body.prototype.mass = function():Number
{
	return 3;
};
Body.prototype.kind = "body";

function protoLoop(n:int):Number
{
	var sum:Number = 0;
	var b:* = new Body();
	for (var k:int = 0; k < n; k++)
	{
		sum += b.mass() + b.kind.length + b.m;
	}
	return sum;
}

// Keys held untyped, as an obfuscator's code holds every value: numbers
// that index an Array, a Vector, a Dictionary and an Object, each read and
// written, and objects that key a Dictionary.
var keyNumbers:Array = [];
var keyArray:Array = [];
var keyVector:Vector.<Number> = new Vector.<Number>();
var keyTable:Dictionary = new Dictionary();
var keyObject:Object = {};
var keyBodies:Array = [];
var keyByBody:Dictionary = new Dictionary();
for (var key:int = 0; key < 16; key++)
{
	keyNumbers.push(key);
	keyArray.push(key);
	keyVector.push(key);
	keyTable[key] = key;
	keyObject[key] = key;
	keyBodies.push(new Body());
	keyByBody[keyBodies[key]] = key;
}

function numberKeysLoop(n:int):Number
{
	var sum:Number = 0;
	var a:* = keyArray, v:* = keyVector, d:* = keyTable, o:* = keyObject;
	for (var k:int = 0; k < n; k++)
	{
		var i:* = keyNumbers[k & 15];
		a[i] = a[i] + 1;
		v[i] = v[i] + 1;
		d[i] = d[i] + 1;
		o[i] = o[i] + 1;
		sum += a[i] + v[i] + d[i] + o[i];
	}
	return sum;
}

function objectKeysLoop(n:int):Number
{
	var sum:Number = 0;
	var d:* = keyByBody;
	for (var k:int = 0; k < n; k++)
	{
		var b:* = keyBodies[k & 15];
		d[b] = d[b] + 1;
		sum += d[b];
	}
	return sum;
}

// Names the code writes as strings, as an obfuscator's does every member:
// read, written and called on a sealed object, a dynamic one and a class.
class Lit
{
	public static var count:Number = 0;
	public static function twice(v:Number):Number
	{
		return v * 2;
	}
	public var lx:Number = 1;
	public var ly:Number = 2;
	public function len():Number
	{
		return 3;
	}
}
var litDynamic:Object = {lx: 1, ly: 2, len: function():Number
	{
		return 3;
	}
};

function literalKeysLoop(n:int):Number
{
	var sum:Number = 0;
	var s:* = new Lit(), d:* = litDynamic, c:* = Lit;
	for (var k:int = 0; k < n; k++)
	{
		s["lx"] = s["ly"] + (k & 3);
		d["lx"] = d["ly"] + (k & 3);
		c["count"] = c["twice"](k & 7);
		sum += s["lx"] + s["len"]() + d["lx"] + d["len"]() + c["count"];
	}
	return sum;
}

function runAll(rounds:int):void
{
	var t:uint = getTimer();
	var r1:Number = displayLoop(rounds);
	trace("time: display " + (getTimer() - t));
	t = getTimer();
	var r2:Number = dataLoop(rounds * 4);
	trace("time: data " + (getTimer() - t));
	t = getTimer();
	var r3:Number = objectLoop(rounds * 40);
	trace("time: object " + (getTimer() - t));
	t = getTimer();
	var r4:Number = polyLoop(rounds * 3);
	trace("time: poly " + (getTimer() - t));
	t = getTimer();
	var r5:Number = stringLoop(rounds * 20);
	trace("time: string " + (getTimer() - t));
	t = getTimer();
	var r6:Number = namesLoop(rounds * 40, 15);
	trace("time: names " + (getTimer() - t));
	t = getTimer();
	var r7:Number = namesLoop(rounds * 40, 1023);
	trace("time: churn " + (getTimer() - t));
	t = getTimer();
	var r8:Number = handlesLoop(rounds * 40);
	trace("time: handles " + (getTimer() - t));
	t = getTimer();
	var r9:Number = manyLoop(rounds * 40);
	trace("time: many " + (getTimer() - t));
	t = getTimer();
	var r10:Number = protoLoop(rounds * 20);
	trace("time: proto " + (getTimer() - t));
	t = getTimer();
	var r11:Number = numberKeysLoop(rounds * 10);
	trace("time: numkeys " + (getTimer() - t));
	t = getTimer();
	var r12:Number = objectKeysLoop(rounds * 40);
	trace("time: objkeys " + (getTimer() - t));
	t = getTimer();
	var r13:Number = literalKeysLoop(rounds * 20);
	trace("time: litkeys " + (getTimer() - t));
	trace(r1 + " " + r2 + " " + r3 + " " + r4 + " " + r5 + " " + r6 + " " + r7 + " " + r8 + " " + r9 + " " + r10 + " " + r11 + " " + r12 + " " + r13);
}

runAll(20000);

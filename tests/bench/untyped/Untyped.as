package {
  // Untyped property access as large Flash applications write it: display
  // objects deep in a class hierarchy reached through *, data objects
  // decoded from JSON, dynamic Objects, untyped Arrays and getters, setters
  // and methods called by name.
  public class Node {
    public var name:String = "";
    public var parent:* = null;
    private var _x:Number = 0;
    private var _visible:Boolean = true;
    public function get x():Number { return _x; }
    public function set x(v:Number):void { _x = v; }
    public function get visible():Boolean { return _visible; }
    public function set visible(v:Boolean):void { _visible = v; }
    public function addEventListener(type:String, f:Function):void { listeners.push(f); }
    public var listeners:Array = [];
  }
}
class Container extends Node {
  public var children:Array = [];
  public function addChild(c:*):* { children.push(c); c.parent = this; return c; }
  public function getChildAt(i:int):* { return children[i]; }
  public function get numChildren():int { return children.length; }
}
class Sprite extends Container {
  public var graphics:Object = {};
}
class Clip extends Sprite {
  public var currentFrame:int = 1;
  public function gotoAndStop(f:int):void { currentFrame = f; }
}
dynamic class Timeline extends Clip {
  public var cnt:* = null;
  public var bg:* = null;
}
class Avatar extends Clip {
  public var objData:* = null;
  public var pMC:* = null;
  public var dataLeaf:Object = null;
  public function getName():String { return objData.strUsername; }
}
class World extends Clip {
  public var myAvatar:* = null;
  public var avatars:Object = {};
  public var uid:int = 0;
}
class Game extends Clip {
  public var world:* = null;
  public var ui:* = null;
  public var litePreference:* = { data: { bDebugger: false, bHideNames: true } };
}

const json:String = '{"sName":"Hero","intLevel":42,"iQty":3,"items":[' +
  '{"ItemID":1,"sName":"Sword","sType":"Weapon","iQty":1,"bEquip":true},' +
  '{"ItemID":2,"sName":"Shield","sType":"Armor","iQty":1,"bEquip":false},' +
  '{"ItemID":3,"sName":"Potion","sType":"Item","iQty":12,"bEquip":false},' +
  '{"ItemID":4,"sName":"Helm","sType":"Helm","iQty":1,"bEquip":true}]}';

function build():* {
  var game:* = new Game();
  game.world = new World();
  game.ui = new Timeline();
  game.ui.cnt = new Clip();
  game.ui.bg = new Sprite();
  var w:* = game.world;
  for (var i:int = 0; i < 20; i++) {
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

function displayLoop(n:int):Number {
  var sum:Number = 0;
  for (var k:int = 0; k < n; k++) {
    var w:* = game.world;
    for (var i:int = 0; i < w.numChildren; i++) {
      var c:* = w.getChildAt(i);
      c.x = c.x + 1;
      c.visible = !c.visible;
      c.pMC.mcChar.gotoAndStop((k & 3) + 1);
      sum += c.pMC.mcChar.currentFrame;
      if (game.litePreference.data.bHideNames) {
        sum += c.name.length;
      }
    }
    game.ui.cnt.x = k;
    game.ui.bg.visible = (k & 1) == 0;
  }
  return sum;
}

function dataLoop(n:int):Number {
  var sum:Number = 0;
  for (var k:int = 0; k < n; k++) {
    var me:* = game.world.myAvatar;
    var items:* = me.objData.items;
    for (var i:int = 0; i < items.length; i++) {
      var it:* = items[i];
      if (it.sType == "Item") {
        sum += it.iQty;
      } else if (it.bEquip) {
        sum += it.ItemID;
      }
      it.iSel = k;
    }
    sum += me.objData.intLevel + me.getName().length + me.objData.sName.toLowerCase().length;
  }
  return sum;
}

function objectLoop(n:int):Number {
  var sum:Number = 0;
  var o:Object = { a: 1, b: 2, c: 3 };
  var arr:Array = [];
  for (var k:int = 0; k < n; k++) {
    o.a = o.b + o.c;
    o["d" + (k & 7)] = k;
    arr.push(o.a);
    if (arr.length > 64) {
      arr.length = 0;
    }
    sum += o.a + arr.length;
  }
  return sum;
}

// The same names on objects of many classes, as a game's code reads x, visible
// and the like from whatever display object it holds.
var mixed:Array = [new Avatar(), new Clip(), new Sprite(), new Timeline(), new World(), new Game(), new Container(), new Node()];

function polyLoop(n:int):Number {
  var sum:Number = 0;
  for (var k:int = 0; k < n; k++) {
    for (var i:int = 0; i < mixed.length; i++) {
      var c:* = mixed[i];
      c.x = c.x + 1;
      c.visible = !c.visible;
      sum += c.name.length + c.listeners.length;
    }
  }
  return sum;
}

function stringLoop(n:int):Number {
  var sum:Number = 0;
  var s:* = "Hello World";
  for (var k:int = 0; k < n; k++) {
    sum += s.toLowerCase().length + s.indexOf("o") + s.length;
  }
  return sum;
}

function runAll(rounds:int):void {
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
  trace(r1 + " " + r2 + " " + r3 + " " + r4 + " " + r5);
}

runAll(20000);

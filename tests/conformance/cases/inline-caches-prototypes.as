// Gets and calls of names no binding has, found on a prototype, looked up
// at one site over and over: the site sees what each prototype has when it
// runs, as one changes, is shadowed by an object's own property and is
// unshadowed, a name deleted along the chain and a name not there at all.
function call(o:*):* {
  return o.speak();
}

function get(o:*):* {
  return o.shared;
}

function push(a:Array, v:*):int {
  return a.push(v);
}

function tryCall(o:*):String {
  try {
    return String(o.speak());
  } catch (e:Error) {
    return e.name;
  }

  return "";
}

function Animal():void {}
Animal.prototype.speak = function():String {
  return "animal";
};
Animal.prototype.shared = 1;

function Dog():void {}
Dog.prototype = new Animal();

var dog:* = new Dog();
var plain:Object = {};
var seen:Array = [];
for (var i:int = 0; i < 4; i++) {
  seen.push(call(dog), get(dog));
}

trace("from the prototype's prototype", seen.join(","));

Dog.prototype.speak = function():String {
  return "dog";
};
Dog.prototype.shared = 2;
trace("the nearer prototype", call(dog), get(dog));

dog.speak = function():String {
  return "own";
};
dog.shared = 3;
trace("own", call(dog), get(dog));

delete dog.speak;
delete dog.shared;
trace("own deleted", call(dog), get(dog));

delete Dog.prototype.speak;
delete Dog.prototype.shared;
trace("nearer deleted", call(dog), get(dog));

delete Animal.prototype.speak;
delete Animal.prototype.shared;
trace("all deleted", tryCall(dog), get(dog));

Object.prototype.speak = function():String {
  return "object";
};
trace("on Object.prototype", call(dog), call(plain), get(plain));
delete Object.prototype.speak;
trace("Object.prototype's deleted", tryCall(dog), tryCall(plain));

// Array's methods, public, are on Array.prototype.
var a:Array = [];
var n:int = 0;
for (var j:int = 0; j < 4; j++) {
  n = push(a, j);
}

trace("Array.prototype.push", n, a.join(","));
var saved:* = Array.prototype.push;
Array.prototype.push = function(... rest):int {
  return -1;
};
trace("push replaced", push(a, 9), a.length);
a.push = function(v:*):int {
  return -2;
};
trace("push own", push(a, 9), a.length);
delete a.push;
Array.prototype.push = saved;
trace("push restored", push(a, 9), a.length);

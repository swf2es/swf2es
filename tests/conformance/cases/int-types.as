// Numeric type checks use the value, including Number's negative zero.
var values:Array = [1, -1, 0, -0, 1.5, -1.5, 2147483647, 2147483648,
    4294967295, 4294967296, NaN, Infinity, -Infinity];
for each (var value:* in values) {
    trace("types", value, value is int, value is uint, value is Number);
}

var zero:Number = -0;
var dynamicZero:* = zero;
var signedClass:Class = int;
var unsignedClass:Class = uint;
trace("negative zero", 1 / zero, zero is int, zero is uint,
    dynamicZero is signedClass, dynamicZero is unsignedClass);
trace("as", 1 / (dynamicZero as int), 1 / (dynamicZero as uint),
    1 / (dynamicZero as signedClass), 1 / (dynamicZero as unsignedClass));
trace("converted", 1 / int(dynamicZero), 1 / uint(dynamicZero));
trace("equality", int(1) == Number(1), int(1) === Number(1),
    uint(1) == Number(1), uint(1) === Number(1), int(1) === uint(1));

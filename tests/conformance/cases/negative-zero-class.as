// -0 is a double in avmplus, never an int atom: a Number to
// getQualifiedClassName and describeType (TypeDescriber::chooseTraits),
// however it was made, though it is an int to `is`.
import avmplus.*;
import flash.utils.ByteArray;

var negative:Number = -0;
var divided:* = 1 / Number.NEGATIVE_INFINITY;
var amf:ByteArray = new ByteArray();
amf.writeObject(negative);
amf.position = 0;
var back:* = amf.readObject();
trace("names", getQualifiedClassName(negative), getQualifiedClassName(divided), getQualifiedClassName(back), getQualifiedClassName(-0), getQualifiedClassName(0));
trace("described", describeType(negative, FLASH10_FLAGS).@name, describeType(0, FLASH10_FLAGS).@name);
trace("is", negative is int, negative is Number, back is int, 1 / back);

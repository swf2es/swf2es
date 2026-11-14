// Object encodings in avmshell, which has AMF3 alone: defaultObjectEncoding
// takes any uint unchecked, an instance's only 0 or 3; writeObject and
// readObject of an encoding below 3 are #1508, any other AMF3; and an
// IExternalizable's ObjectOutput and ObjectInput are AMF3 whatever their
// objectEncoding is set to.
package
{
	import flash.utils.IDataInput;
	import flash.utils.IDataOutput;
	import flash.utils.IExternalizable;

	public class Inner implements IExternalizable
	{
		public var v:int = 11;

		public function writeExternal(output:IDataOutput):void
		{
			output.writeInt(v);
			output.objectEncoding = 0;
			trace("output encoding", output.objectEncoding);
			output.writeObject({q: [1, 2]});
		}

		public function readExternal(input:IDataInput):void
		{
			v = input.readInt();
			input.objectEncoding = 0;
			var o:* = input.readObject();
			trace("input", input.objectEncoding, o.q, o.q.length);
		}
	}
}
import flash.net.registerClassAlias;
import flash.utils.ByteArray;

function hex(b:ByteArray):String
{
	var s:String = "";
	for (var i:uint = 0; i < b.length; i++)
		s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
	return s;
}

for each (var encoding:* in [1, 7, -1, "2"])
{
	ByteArray.defaultObjectEncoding = encoding;
	var made:ByteArray = new ByteArray();
	trace("default", encoding, ByteArray.defaultObjectEncoding, made.objectEncoding);
	try
	{
		made.writeObject(1);
		trace("  written", hex(made));
		made.position = 0;
		trace("  read", made.readObject());
	}
	catch (e:Error)
	{
		trace("  error", e.errorID);
	}
}
ByteArray.defaultObjectEncoding = 3;

var b:ByteArray = new ByteArray();
for each (var bad:* in [1, 2, 4, -1])
{
	try
	{
		b.objectEncoding = bad;
		trace("set", bad, b.objectEncoding);
	}
	catch (e:Error)
	{
		trace("set", bad, e.errorID);
	}
}
b.objectEncoding = 0;
try
{
	b.readObject();
}
catch (e:Error)
{
	trace("read amf0", e.errorID);
}
try
{
	b.writeObject(1);
}
catch (e:Error)
{
	trace("write amf0", e.errorID, b.length);
}

registerClassAlias("Inner", Inner);
var out:ByteArray = new ByteArray();
out.writeObject(new Inner());
trace("externalizable", hex(out));
out.position = 0;
trace("back", out.readObject().v);

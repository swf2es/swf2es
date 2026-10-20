package {
    import flash.display.Sprite;
    import flash.utils.ByteArray;
    import flash.utils.Dictionary;
    import flash.utils.getQualifiedClassName;

    public class AirFloat extends Sprite {
        private var uninitialized:float;
        private var field:float;

        public function AirFloat() {
            field = 0.1f;
            var f:float = float(16777217);
            var n:Number = 16777217;
            trace("values", f, n, field, uninitialized);
            trace("types", typeof f, typeof n, f is float, n is float, f is Number,
                f is int, float(0) is uint, getQualifiedClassName(f));
            trace("equality", float(1) == 1, float(1) === 1, float(1) === float(1),
                float(NaN) === float(NaN), float(1) instanceof Number, float(1) instanceof float);
            trace("rounding", float(16777216) + float(1), Number(float(16777216)) + Number(float(1)));
            trace("conversion", float(null), float(undefined), float("0.1"), float(true),
                float(1e40), 1 / Number(float(-0)), float(1e-50));
            trace("boolean", Boolean(float(0)), Boolean(float(-0)), Boolean(float(NaN)), Boolean(float(1)));
            var zero:* = float(0);
            trace("branches", zero ? "yes" : "no", !zero, !float(NaN));
            var text:* = "1";
            var binaryText:* = "0b1";
            trace("unary-strings", ++text, -binaryText);
            var a:* = float(16777216);
            var b:* = float(1);
            trace("dynamic", a + b, a - b, a * b, a / b, a % b, -a, +a, ++a, b++);
            trace("dynamic-types", (a + b) is float, (a - b) is float, (a * b) is float,
                (a / b) is float, (a % b) is float, (-a) is float, (+a) is float, a is float, b is float);
            trace("mixed", a + Number(1), a - Number(1), a * Number(1), a / Number(1), a + "x");
            trace("mixed-types", (a + Number(1)) is float, (a - Number(1)) is float);
            var boxed:* = {valueOf: function():* { return float(2); }};
            trace("primitive", boxed + float(1), boxed - float(1), (+boxed) is float);
            trace("call", typed(0.1f), defaults() is float, dynamic(f) is float,
                typed.apply(null, [0.1f]) is float);
            var choice:* = choose(true), other:* = choose(false);
            trace("merge", choice is float, other is float, choice + other);
            var count:float = 0f;
            for (var j:int = 0; j < 10; j++) { count += 0.1f; }
            trace("loop", count, count is float);
            var vec:Vector.<float> = new Vector.<float>(2);
            trace("vector-default", vec[0], vec[0] is float, vec.pop(), new Vector.<float>().pop());
            vec[0] = float(0.1); vec.push(float(2)); vec.length = 4;
            trace("vector", vec.length, vec[0], vec[0] is float, vec[2], vec[2] is float, vec.join(","));
            var list:Array = [1f, 2f, 1f, float(NaN)];
            trace("search", list.indexOf(1f), list.lastIndexOf(1f), list.indexOf(1), list.indexOf(float(NaN)),
                vec.indexOf(0.1f), vec.indexOf(Number(0.1)), vec.lastIndexOf(float(0)));
            var dict:Dictionary = new Dictionary();
            dict[1f] = "float";
            trace("dictionary", dict[1], dict["1"], dict[float(1)], 1f in dict, delete dict[float(1)], dict[1f]);
            trace("methods", field.toString(), field.valueOf() is float, field.toFixed(3),
                field.toExponential(3), field.toPrecision(3), field["toString"]());
            trace("constants", float.MAX_VALUE, float.MIN_VALUE, float.NaN, float.POSITIVE_INFINITY,
                float.NEGATIVE_INFINITY, float.MAX_VALUE is float);
            trace("math", float.abs(-0.1f), float.sin(0.1f), float.max(1, 2), float.pow(2, 3),
                float.random() is float);
            trace("extra-math", float.reciprocal(3f), float.rsqrt(3f), float.max(), float.min(), 1 / Number(float.round(-0.5f)));
            trace("json", JSON.stringify([field, float(0), float(NaN)]));
            var bytes:ByteArray = new ByteArray();
            bytes.writeObject(field);
            var hex:String = "";
            for (var i:int = 0; i < bytes.length; i++) { hex += bytes[i].toString(16) + " "; }
            bytes.position = 0;
            var read:* = bytes.readObject();
            trace("amf", hex, read, read is float);
            bytes.clear(); bytes.writeObject(vec); bytes.position = 0;
            trace("amf-vector-marker", bytes[0]);
            var restored:* = bytes.readObject();
            trace("amf-vector", getQualifiedClassName(restored), restored[0], restored[0] is float);
        }

        private function defaults(value:* = 0.1):float { return value; }
        private function typed(value:float):float { return value; }
        private function dynamic(value:*):* { return value; }
        private function choose(which:Boolean):* { return which ? 1f : Number(2); }
    }
}

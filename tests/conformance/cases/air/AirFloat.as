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
            var negativeZero:Number = -0;
            trace("integer-types", negativeZero is int, negativeZero is uint,
                1 / (negativeZero as int), 1 / (negativeZero as uint),
                1 / int(negativeZero), 1 / uint(negativeZero));
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
            var typedBox:FloatPrimitive = new FloatPrimitive();
            trace("typed-primitive", typedBox - 1f, typedBox * 1f, typedBox / 1f,
                typedBox % 3f, -typedBox, +typedBox);
            trace("typed-primitive-types", (typedBox - 1f) is float, (typedBox * 1f) is float,
                (typedBox / 1f) is float, (typedBox % 3f) is float, (-typedBox) is float,
                (+typedBox - 1f) is float, (1f - typedBox) is float, (typedBox - 1) is float);
            trace("call", typed(0.1f), defaults() is float, dynamic(f) is float,
                typed.apply(null, [0.1f]) is float);
            var choice:* = choose(true), other:* = choose(false);
            trace("merge", choice is float, other is float, choice + other);
            var count:float = 0f;
            for (var j:int = 0; j < 10; j++) { count += 0.1f; }
            trace("loop", count, count is float);
            trace("local-loop", localLoop(10, 0f, 0.1f));
            trace("local-arithmetic", localArithmetic(0.1f, 0.3f).join(","));
            trace("local-boundaries", localBoundaries(-0f).join(","));
            trace("local-nan", localBoundaries(float.NaN).join(","));
            trace("local-infinity", localBoundaries(float.POSITIVE_INFINITY).join(","));
            trace("local-changing", localChanging(true) is float, localChanging(false) is float);
            trace("local-handler", localHandler(0.1f));
            trace("local-capture", localCapture(0.1f));
            trace("local-calls", localCalls(0.1f));
            var vec:Vector.<float> = new Vector.<float>(2);
            trace("vector-default", vec[0], vec[0] is float, vec.pop(), new Vector.<float>().pop());
            var vectorTypes:Array = [Vector.<float>, Vector.<Number>, Vector.<int>, Vector.<uint>,
                Vector.<String>, Vector.<Object>];

            for each (var vectorType:Class in vectorTypes) {
                var flags:Array = [];

                for each (var fixed:* in [float(0), float(-0), float(NaN), float(1), float(-1)]) {
                    flags.push(new vectorType(1, fixed).fixed);
                }

                trace("vector-fixed", getQualifiedClassName(vectorType), flags.join(","));
            }

            vec.fixed = float(1);
            trace("vector-fixed-set", vec.fixed);
            vec.fixed = float(0);
            trace("vector-fixed-clear", vec.fixed);
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

        private function localLoop(n:int, value:float, step:float):float {
            for (var i:int = 0; i < n; i++) { value += step; }
            return value;
        }

        private function localArithmetic(value:float, step:float):Array {
            value += step;
            value -= step;
            value *= step;
            value /= step;
            value %= step;
            var negative:float = -value;
            var positive:float = +value;
            var post:float = value++;
            var pre:float = --value;
            return [value, negative, positive, post, pre, value is float,
                int(value), uint(value), Number(value), Boolean(value),
                value == Number(value), value === Number(value), value === positive];
        }

        private function localBoundaries(value:float):Array {
            var list:Array = [value];
            var object:Object = {value: value};
            var vector:Vector.<float> = new Vector.<float>();
            vector.push(value);
            return [1 / Number(value), Boolean(value), value is int, value is uint,
                list[0] is float, object.value is float, vector[0] is float,
                dynamic(value) is float, typeof value, value.valueOf() is float,
                value === Number(value), value === float(-0)];
        }

        private function localChanging(which:Boolean):* {
            var value:*;
            if (which) { value = 1f; } else { value = 1; }
            return value;
        }

        private function localHandler(value:float):* {
            try {
                value += 0.1f;
                throw value;
            } catch (caught:*) {
                return [value, caught, value is float, caught is float].join(",");
            }
        }

        private function localCapture(value:float):* {
            var get:Function = function():* { return value; };
            value += 0.1f;
            var result:* = get();
            return [result, result is float].join(",");
        }

        private function localCalls(value:float):float {
            var result:float = typed(value);
            result += field;
            return result;
        }
    }
}

class FloatPrimitive {
    public function valueOf():* { return float(16777216); }
}

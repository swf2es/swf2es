package
{
	public final class float
	{
		public static const length:int = 1;
		public static const MAX_VALUE:float;
		public static const MIN_VALUE:float;
		public static const NaN:float;
		public static const POSITIVE_INFINITY:float;
		public static const NEGATIVE_INFINITY:float;

		public static const E:float;
		public static const LN10:float;
		public static const LN2:float;
		public static const LOG2E:float;
		public static const PI:float;
		public static const SQRT1_2:float;
		public static const SQRT2:float;

		public static native function abs(x:float):float;
		public static native function acos(x:float):float;
		public static native function asin(x:float):float;
		public static native function atan(x:float):float;
		public static native function ceil(x:float):float;
		public static native function cos(x:float):float;
		public static native function exp(x:float):float;
		public static native function floor(x:float):float;
		public static native function log(x:float):float;
		public static native function round(x:float):float;
		public static native function sin(x:float):float;
		public static native function sqrt(x:float):float;
		public static native function tan(x:float):float;
		public static native function atan2(y:float, x:float):float;
		public static native function pow(x:float, y:float):float;
		public static native function max(...rest):float;
		public static native function min(...rest):float;
		public static native function random():float;
		public static native function reciprocal(x:float):float;
		public static native function rsqrt(x:float):float;

		prototype.valueOf = function():float
		{
			return float(this);
		};
		prototype.toString = function(radix:* = 10):String
		{
			return _toString(float(this), radix);
		};
		prototype.toLocaleString = prototype.toString;
		prototype.toFixed = function(digits:* = 0):String
		{
			return _toFixed(float(this), digits);
		};
		prototype.toExponential = function(digits:* = 0):String
		{
			return _toExponential(float(this), digits);
		};
		prototype.toPrecision = function(digits:* = 0):String
		{
			return _toPrecision(float(this), digits);
		};

		public function float(value:* = 0) {}

		AS3 function valueOf():float
		{
			return this;
		}
		AS3 function toString(radix:* = 10):String
		{
			return _toString(this, radix);
		}
		AS3 function toFixed(fractionDigits:* = 0):String
		{
			return _toFixed(this, fractionDigits);
		}
		AS3 function toExponential(fractionDigits:* = 0):String
		{
			return _toExponential(this, fractionDigits);
		}
		AS3 function toPrecision(precision:* = 0):String
		{
			return _toPrecision(this, precision);
		}
		private static native function _toString(value:float, radix:*):String;
		private static native function _toFixed(value:float, digits:*):String;
		private static native function _toExponential(value:float, digits:*):String;
		private static native function _toPrecision(value:float, digits:*):String;
	}
}

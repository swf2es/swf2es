// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/external/ExternalInterface.ts.
// Values cross in Flash's ExternalInterface XML, or as JavaScript source where
// the host evaluates it (packages/player/src/hosts.ts).

package flash.external
{
	public final class ExternalInterface
	{
		public function ExternalInterface()
		{
		}

		public static native function get available():Boolean;

		public static var marshallExceptions:Boolean = false;

		public static function addCallback(functionName:String, closure:Function):void
		{
			_initJS();
			if (closure == null)
			{
				_addCallback(functionName, null, true);
				return;
			}

			// With the arguments as they are, the answer is JavaScript; with an XML
			// invocation, as a plug-in sends one, it is XML.
			_addCallback(functionName, function(request:String, args:Array):*
				{
					try
					{
						if (args != null)
						{
							return _toJS(closure.apply(null, args));
						}

						const invocation:XML = new XML(request);
						return _toXML(closure.apply(null, _argumentsToAS(invocation.arguments[0])));
					}
					catch (error:Error)
					{
						if (marshallExceptions)
						{
							return args != null ? "throw " + _quotedStringFromError(error) : "<exception>" + escapeXML(error.message) + "</exception>";
						}

						throw error;
					}
				}, false);
		}

		public static function call(functionName:String, ...arguments):*
		{
			_initJS();
			const source:String = "try { __flash__toXML(" + functionName + "(" + _argumentsToJS(arguments) + ")) ; } catch (e) { \"<undefined/>\"; }";
			var result:String = _evalJS(source);
			if (result == null)
			{
				result = _callOut("<invoke name=\"" + escapeXML(functionName) + "\" returntype=\"xml\">" + _argumentsToXML(arguments) + "</invoke>");
			}

			if (result == null)
			{
				return null;
			}

			const answer:XML = new XML(result);
			if (answer.name() == "exception")
			{
				if (marshallExceptions)
				{
					throw new Error(answer.toString());
				}

				return undefined;
			}

			return _toAS(answer);
		}

		public static native function get objectID():String;

		private static function escapeXML(text:String):String
		{
			return text.split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;").split("\"").join("&quot;").split("'").join("&apos;");
		}

		private static function _toXML(value:*):String
		{
			if (value === undefined)
			{
				return "<undefined/>";
			}

			if (value === null)
			{
				return "<null/>";
			}

			if (value is String)
			{
				return "<string>" + escapeXML(value) + "</string>";
			}

			if (value is Number)
			{
				return "<number>" + value + "</number>";
			}

			if (value is Boolean)
			{
				return value ? "<true/>" : "<false/>";
			}

			if (value is Date)
			{
				return "<date>" + (value as Date).time + "</date>";
			}

			if (value is Function)
			{
				return "<null/>";
			}

			if (value is Array)
			{
				const array:Array = value;
				var items:String = "<array>";
				for (var i:int = 0; i < array.length; i++)
				{
					items += "<property id=\"" + i + "\">" + _toXML(array[i]) + "</property>";
				}

				return items + "</array>";
			}

			const names:Array = _getPropNames(value);
			var properties:String = "<object>";
			for (var j:int = 0; j < names.length; j++)
			{
				properties += "<property id=\"" + escapeXML(names[j]) + "\">" + _toXML(value[names[j]]) + "</property>";
			}

			return properties + "</object>";
		}

		private static function _argumentsToXML(args:Array):String
		{
			var xml:String = "<arguments>";
			for (var i:int = 0; i < args.length; i++)
			{
				xml += _toXML(args[i]);
			}

			return xml + "</arguments>";
		}

		private static function _toAS(xml:XML):*
		{
			switch (String(xml.name()))
			{
				case "string":
					return xml.toString();
				case "number":
					return Number(xml.toString());
				case "true":
					return true;
				case "false":
					return false;
				case "null":
					return null;
				case "date":
					return new Date(Number(xml.toString()));
				case "array":
					const array:Array = [];
					const items:XMLList = xml.property;
					for (var i:int = 0; i < items.length(); i++)
					{
						array[items[i].@id] = _toAS(items[i].children()[0]);
					}

					return array;
				case "object":
					const object:Object = {};
					const properties:XMLList = xml.property;
					for (var j:int = 0; j < properties.length(); j++)
					{
						object[properties[j].@id] = _toAS(properties[j].children()[0]);
					}

					return object;
				case "class":
					return xml.toString();
				default:
					return undefined;
			}
		}

		private static function _argumentsToAS(xml:XML):Array
		{
			const args:Array = [];
			if (xml == null)
			{
				return args;
			}

			const values:XMLList = xml.children();
			for (var i:int = 0; i < values.length(); i++)
			{
				args.push(_toAS(values[i]));
			}

			return args;
		}

		private static function _toJS(value:*):String
		{
			if (value === undefined)
			{
				return "undefined";
			}

			if (value === null)
			{
				return "null";
			}

			if (value is String)
			{
				return _quotedStringFromString(value);
			}

			if (value is Number || value is Boolean)
			{
				return String(value);
			}

			if (value is Date)
			{
				return "new Date(" + (value as Date).time + ")";
			}

			if (value is Function)
			{
				return "null";
			}

			if (value is Array)
			{
				return "[" + _argumentsToJS(value) + "]";
			}

			// Its keys unquoted, as Flash Player wrote them.
			const names:Array = _getPropNames(value);
			const parts:Array = [];
			for (var i:int = 0; i < names.length; i++)
			{
				parts.push(names[i] + ":" + _toJS(value[names[i]]));
			}

			return "({" + parts.join(",") + "})";
		}

		private static function _argumentsToJS(args:Array):String
		{
			const parts:Array = [];
			for (var i:int = 0; i < args.length; i++)
			{
				parts.push(_toJS(args[i]));
			}

			return parts.join(",");
		}

		// The player's natives (packages/player/src/playerglobal/flash/external/ExternalInterface.ts).
		private static native function _initJS():void;

		private static native function _getPropNames(object:Object):Array;

		private static native function get activeX():Boolean;

		private static native function _addCallback(name:String, closure:Function, remove:Boolean):void;

		private static native function _evalJS(source:String):String;

		private static native function _callOut(request:String):String;

		private static native function _quotedStringFromError(error:Error):String;

		private static native function _quotedStringFromString(value:String):String;
	}
}

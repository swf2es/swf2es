// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).
// Connections between the SWFs of one player: a message is delivered on a
// later frame, and its sender told by a StatusEvent whether one received it.

package flash.net
{
	import flash.events.AsyncErrorEvent;
	import flash.events.EventDispatcher;
	import flash.events.StatusEvent;
	import flash.utils.setTimeout;

	public class LocalConnection extends EventDispatcher
	{
		// The connected objects, by their names in lower case, as names are matched.
		private static var _connections:Object = {};

		private var _name:String;
		private var _client:Object;
		private var _isPerUser:Boolean;

		public function LocalConnection()
		{
			_client = this;
		}

		[API("667")]
		public static function get isSupported():Boolean
		{
			return true;
		}

		public function close():void
		{
			if (_name == null)
			{
				Error.throwError(ArgumentError, 2083);
			}

			delete _connections[_name];
			_name = null;
		}

		public function connect(connectionName:String):void
		{
			if (connectionName == null)
			{
				Error.throwError(TypeError, 2007, "connectionName");
			}

			const key:String = connectionName.toLowerCase();
			if (_name != null || _connections[key] != null)
			{
				Error.throwError(ArgumentError, 2082);
			}

			_name = key;
			_connections[key] = this;
		}

		public native function get domain():String;

		public function send(connectionName:String, methodName:String, ...args):void
		{
			if (connectionName == null)
			{
				Error.throwError(TypeError, 2007, "connectionName");
			}

			if (methodName == null)
			{
				Error.throwError(TypeError, 2007, "methodName");
			}

			const key:String = connectionName.toLowerCase();
			setTimeout(deliver, 0, key, methodName, args);
		}

		public function get client():Object
		{
			return _client;
		}

		public function set client(client:Object):void
		{
			if (client == null)
			{
				Error.throwError(TypeError, 2007, "client");
			}

			_client = client;
		}

		[API("665")]
		public function get isPerUser():Boolean
		{
			return _isPerUser;
		}

		[API("665")]
		public function set isPerUser(value:Boolean):void
		{
			_isPerUser = value;
		}

		// Every domain may send here: the SWFs of one player share one.
		public function allowDomain(...domains):void
		{
		}

		public function allowInsecureDomain(...domains):void
		{
		}

		private function deliver(key:String, methodName:String, args:Array):void
		{
			const receiver:LocalConnection = _connections[key];
			if (receiver == null)
			{
				dispatchEvent(new StatusEvent(StatusEvent.STATUS, false, false, null, "error"));
				return;
			}

			dispatchEvent(new StatusEvent(StatusEvent.STATUS, false, false, null, "status"));
			// What the call throws, as a missing method's ReferenceError, goes to the receiver.
			try
			{
				const method:Function = receiver._client[methodName];
				method.apply(receiver._client, args);
			}
			catch (error:Error)
			{
				receiver.dispatchEvent(new AsyncErrorEvent(AsyncErrorEvent.ASYNC_ERROR, false, false, "", error));
			}
		}
	}
}

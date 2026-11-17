package
{
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.utils.getDefinitionByName;

	public class CapturePermission extends Sprite
	{
		public function CapturePermission()
		{
			var PermissionEvent:Class = getDefinitionByName("flash.events.PermissionEvent") as Class;
			var PermissionStatus:Class = getDefinitionByName("flash.permissions.PermissionStatus") as Class;
			trace("statuses", PermissionStatus.UNKNOWN, PermissionStatus.GRANTED, PermissionStatus.DENIED);
			var event:Event = new PermissionEvent("permissionStatus");
			trace("default", Object(event).status, event.bubbles, event.cancelable);
			event = new PermissionEvent("permissionStatus", true, true, "granted");
			var copy:Event = event.clone();
			trace("copy", copy !== event, Object(copy).status, copy.bubbles, copy.cancelable);
			trace(event.toString());
		}
	}
}

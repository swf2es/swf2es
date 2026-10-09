// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.filesystem
{
	import flash.desktop.Icon;
	import flash.net.FileReference;

	[API("661")]
	public class File extends FileReference
	{
		public function File(path:String = null)
		{
		}

		public static native function get systemCharset():String;
		public static native function get separator():String;
		public static native function get lineEnding():String;
		public static native function get userDirectory():File;
		public static native function get documentsDirectory():File;
		public static native function get desktopDirectory():File;
		public static native function get applicationStorageDirectory():File;
		public static native function get applicationDirectory():File;
		public static native function createTempFile():File;
		public static native function createTempDirectory():File;
		public static native function getRootDirectories():Array;
		[API("686")]
		public static native function get cacheDirectory():File;
		override public native function toString():String;
		public native function get exists():Boolean;
		public native function get isHidden():Boolean;
		public native function get isDirectory():Boolean;
		public native function get isPackage():Boolean;
		public native function get isSymbolicLink():Boolean;
		override public native function cancel():void;
		public native function resolvePath(path:String):File;
		public native function getRelativePath(arg0:FileReference, arg1:Boolean = false):String;
		public native function get parent():File;
		public native function get nativePath():String;
		public native function set nativePath(arg0:String):void;
		public native function canonicalize():void;
		public native function get url():String;
		public native function set url(arg0:String):void;
		public native function browseForOpen(arg0:String, arg1:Array = null):void;
		public native function browseForOpenMultiple(arg0:String, arg1:Array = null):void;
		public native function browseForSave(arg0:String):void;
		public native function browseForDirectory(arg0:String):void;
		public native function deleteFile():void;
		public native function deleteFileAsync():void;
		public native function deleteDirectory(deleteDirectoryContents:Boolean = false):void;
		public native function deleteDirectoryAsync(arg0:Boolean = false):void;
		public native function copyTo(arg0:FileReference, arg1:Boolean = false):void;
		public native function copyToAsync(arg0:FileReference, arg1:Boolean = false):void;
		public native function moveTo(newLocation:FileReference, overwrite:Boolean = false):void;
		public native function moveToAsync(arg0:FileReference, arg1:Boolean = false):void;
		public native function moveToTrash():void;
		public native function moveToTrashAsync():void;
		public native function createDirectory():void;
		public native function getDirectoryListing():Array;
		public native function getDirectoryListingAsync():void;
		public native function clone():File;
		public native function get icon():Icon;
		public native function get spaceAvailable():Number;
		[API("668")]
		public native function openWithDefaultApplication():void;
		[API("668")]
		public native function get downloaded():Boolean;
		[API("668")]
		public native function set downloaded(arg0:Boolean):void;
		[API("686")]
		public native function get preventBackup():Boolean;
		[API("686")]
		public native function set preventBackup(arg0:Boolean):void;
	}
}

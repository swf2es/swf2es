// The console of tests/programs/lz4 as a SWF for the player comparison
// (players.ts): what PlayerKernel gives the C program for /dev/tty. Its
// output goes out line by line through playersReport, and its exit through
// playersFinish, which players.ts puts after this file. The program runs on
// this worker, not a background one, to its end in the start, as the
// benchmark has nothing to wait for. Built with -symbol-abc in place of
// Crossbridge's own Console.
package com.adobe.flascc {
import com.adobe.flascc.vfs.ISpecialFile;

import flash.display.DisplayObjectContainer;
import flash.display.Sprite;
import flash.events.Event;

public class Console extends Sprite implements ISpecialFile {
  // ENOTTY: no terminal to configure, so the C library buffers as for a file.
  private static const ENOTTY:int = 25;

  private var _pending:String = "";

  // Crossbridge's preloader makes it once the SWF has loaded, in itself, on frame 2.
  public function Console(container:DisplayObjectContainer = null) {
    CModule.rootSprite = container ? container.root : this;
    if (container) {
      container.addChild(this);
      start(null);
    } else {
      addEventListener(Event.ADDED_TO_STAGE, start);
    }
  }

  private function start(event:Event):void {
    removeEventListener(Event.ADDED_TO_STAGE, start);
    CModule.vfs.console = this;
    CModule.startAsync(this);
  }

  public function exit(code:int):Boolean {
    if (_pending.length > 0) {
      playersReport(_pending);
      _pending = "";
    }

    playersReport("exit " + code);
    playersFinish();
    return true;
  }

  public function write(fd:int, bufPtr:int, nbyte:int, errnoPtr:int):int {
    _pending += CModule.readString(bufPtr, nbyte);
    var end:int = _pending.indexOf("\n");
    while (end >= 0) {
      playersReport(_pending.substring(0, end));
      _pending = _pending.substring(end + 1);
      end = _pending.indexOf("\n");
    }

    return nbyte;
  }

  public function read(fd:int, bufPtr:int, nbyte:int, errnoPtr:int):int {
    return 0;
  }

  public function fcntl(fd:int, com:int, data:int, errnoPtr:int):int {
    return 0;
  }

  public function ioctl(fd:int, com:int, data:int, errnoPtr:int):int {
    CModule.write32(errnoPtr, ENOTTY);
    return -1;
  }
}
}

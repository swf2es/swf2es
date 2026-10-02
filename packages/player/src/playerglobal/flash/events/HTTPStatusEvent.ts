// AIR's playerglobal ABC keeps the response fields in slots, but asks the VM
// for their bodyless accessors. URLLoader reads them while forwarding status.
import type { avm2 } from "@swf2es/runtime";

export const httpStatusHooks: Record<string, avm2.ClassHook> = {
  "flash.events::HTTPStatusEvent": {
    setOnlySlots: {
      responseURL: "$2",
      responseHeaders: "$1",
    },
  },
};

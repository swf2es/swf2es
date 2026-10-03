// A class whose script throws, as it runs, the error of looking up an
// invalid Vector (scripts/Definitions.as).
package {
  public class Indirect {}
}

import flash.system.ApplicationDomain;

ApplicationDomain.currentDomain.getDefinition("Vector.<trace>");

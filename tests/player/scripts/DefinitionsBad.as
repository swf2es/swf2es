// A class whose script throws as it runs: in a lazy DoABC, it runs when
// something first looks the class up (scripts/Definitions.as).
package {
  public class Bad {}
}

throw new Error("boom");

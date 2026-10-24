// Stage settings shared by Flash natives and the host that places its view.
export type StageScaleMode = "showAll" | "noScale" | "noBorder" | "exactFit";

export function stageAlignment(value: string): string {
  const input = value.toUpperCase();
  return `${input.includes("T") ? "T" : ""}${input.includes("B") ? "B" : ""}${input.includes("L") ? "L" : ""}${input.includes("R") ? "R" : ""}`;
}

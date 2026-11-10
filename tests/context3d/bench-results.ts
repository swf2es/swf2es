export interface Options {
  draws: number;
  frames: number;
  samples: number;
}

export interface Result {
  name: string;
  renderer: string;
  cpu: number[];
  completed: number[];
  pixels: number[];
  calls: Record<string, number>;
}

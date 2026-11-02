export interface Options {
  frames: number;
  branches: number;
  samples: number;
}

export interface Result {
  name: string;
  renderer: string;
  samples: number;
  cpu: number[];
  walk: number[];
  /** Includes a GPU completion wait; CPU timing excludes that wait. */
  completed: number[];
  pixels: number[];
  allocations: number;
  checks: number;
}

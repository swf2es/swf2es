export const tessellationFixtures = [
  { name: "square", contours: [[0, 0, 100, 0, 100, 100, 0, 100]], area: [10000, 10000] },
  {
    name: "nested rings with the same orientation",
    contours: [
      [0, 0, 100, 0, 100, 100, 0, 100],
      [20, 20, 80, 20, 80, 80, 20, 80],
    ],
    area: [6400, 10000],
  },
  {
    name: "nested rings with opposite orientations",
    contours: [
      [0, 0, 100, 0, 100, 100, 0, 100],
      [20, 20, 20, 80, 80, 80, 80, 20],
    ],
    area: [6400, 6400],
  },
  {
    name: "bowtie",
    contours: [[0, 0, 100, 100, 100, 0, 0, 100]],
    area: [5000, 5000],
  },
  {
    name: "coincident contours",
    contours: [
      [0, 0, 100, 0, 100, 100, 0, 100],
      [0, 0, 100, 0, 100, 100, 0, 100],
    ],
    area: [0, 10000],
  },
  {
    name: "near-coincident contours",
    contours: [
      [0, 0, 100, 0, 100, 100, 0, 100],
      [0.00000001, 0, 100, 0, 100, 100, 0.00000001, 100],
    ],
    area: [0.000001, 10000],
  },
  { name: "zero area", contours: [[0, 0, 50, 50, 100, 100]], area: [0, 0] },
  {
    name: "horizontal detail at a large origin",
    contours: [[8000000, 8000000, 8000100, 8000000, 8000100, 8000000.125, 8000000, 8000000.125]],
    area: [12.5, 12.5],
  },
  {
    name: "vertical detail at a large origin",
    contours: [[8000000, 8000000, 8000000.125, 8000000, 8000000.125, 8000100, 8000000, 8000100]],
    area: [12.5, 12.5],
  },
  {
    name: "inclusive coordinate limits",
    contours: [[-8388608, -10, 8388608, -10, 8388608, 10, -8388608, 10]],
    area: [335544320, 335544320],
  },
];

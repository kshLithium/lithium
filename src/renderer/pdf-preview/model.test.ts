import { describe, expect, it } from "vitest";
import { buildRenderOrder, computeRenderWindow } from "./model";

describe("pdf preview model", () => {
  it("computes a render window around the visible viewport", () => {
    const metrics = [{ height: 200 }, { height: 200 }, { height: 200 }, { height: 200 }];

    expect(computeRenderWindow(metrics, 230, 220, 2, 20, 1)).toEqual({
      start: 1,
      end: 4
    });
  });

  it("falls back to the current page when the viewport height is unavailable", () => {
    const metrics = [{ height: 200 }, { height: 200 }, { height: 200 }, { height: 200 }, { height: 200 }];

    expect(computeRenderWindow(metrics, 0, 0, 4, 18, 1)).toEqual({
      start: 3,
      end: 5
    });
  });

  it("prioritizes pages closest to the current page inside the render window", () => {
    expect(buildRenderOrder({ start: 2, end: 6 }, 4)).toEqual([4, 5, 3, 6, 2]);
    expect(buildRenderOrder({ start: 2, end: 6 }, 1)).toEqual([2, 3, 4, 5, 6]);
  });
});

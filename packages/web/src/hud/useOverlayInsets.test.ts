import { describe, expect, it } from "vitest";
import { overlayInsets } from "./useOverlayInsets";

describe("overlayInsets", () => {
  const viewport = { w: 1280, h: 800 };
  const rect = { left: 870, right: 1270, top: 60, bottom: 790 };
  it("mede a faixa coberta a partir da borda", () => {
    expect(overlayInsets(rect, "right", viewport)).toEqual({ top: 0, right: 410, bottom: 0, left: 0 });
    expect(overlayInsets({ left: 8, right: 308, top: 60, bottom: 400 }, "left", viewport).left).toBe(308);
    expect(overlayInsets({ left: 0, right: 1280, top: 0, bottom: 52 }, "top", viewport).top).toBe(52);
    expect(overlayInsets({ left: 8, right: 860, top: 670, bottom: 792 }, "bottom", viewport).bottom).toBe(130);
  });
});

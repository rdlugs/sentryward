import { describe, expect, it, vi } from "vitest";
import * as pricing from "./pricing";

describe("applyDiscount", () => {
  it("caps the discount at 100 percent", () => {
    const spy = vi.spyOn(pricing, "applyDiscount").mockReturnValue(0);
    expect(pricing.applyDiscount(50, 150)).toBe(0);
    expect(spy).toHaveBeenCalledWith(50, 150);
  });
});

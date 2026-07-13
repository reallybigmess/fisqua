/**
 * Tests — map surface layout contract (UAT regression)
 *
 * Pins the sizing contract exported by
 * `app/components/admin/place-maps.tsx` after the production defect
 * where all three map surfaces rendered a 0-height canvas and never
 * requested a tile. Root cause: the map mount used `absolute inset-0`,
 * but MapLibre stamps `.maplibregl-map` onto the mount at init and its
 * stylesheet (appended after Tailwind's by the dynamic import)
 * declares `position: relative` at equal class specificity — stripping
 * the absolute positioning and collapsing the element to 0px. The
 * explorer frame compounded it with `min-h-[…]` only, which gives a
 * percentage-height child no definite base.
 *
 * The contract these assertions pin: the mount is sized by an in-flow
 * `h-full w-full` chain (no positioning classes for MapLibre's CSS to
 * fight), and every frame is the positioned ancestor with a DEFINITE
 * `h-[…]` height. No WebGL, no rendering — same Workers-pool
 * pure-contract pattern as the other component tests.
 *
 * @version v0.4.2
 */
import { describe, it, expect } from "vitest";
import {
  MAP_MOUNT_CLASSES,
  MAP_FRAME_CLASSES,
} from "../../app/components/admin/place-maps";

describe("map surface layout contract", () => {
  it("mount is in-flow full-size — never positioned, never inset-sized", () => {
    const classes = MAP_MOUNT_CLASSES.split(/\s+/);
    expect(classes).toContain("h-full");
    expect(classes).toContain("w-full");
    // MapLibre's own stylesheet sets `position: relative` on the mount
    // at equal specificity; any positioning utility here would lose the
    // cascade race and re-collapse the map to 0px.
    expect(classes).not.toContain("absolute");
    expect(classes).not.toContain("inset-0");
    expect(classes).not.toContain("relative");
    expect(classes).not.toContain("fixed");
  });

  it.each(Object.entries(MAP_FRAME_CLASSES))(
    "%s frame is the positioned ancestor with a definite height",
    (_surface, frameClasses) => {
      const classes = frameClasses.split(/\s+/);
      // Positioned: the overlays (controls, popovers, attribution)
      // anchor to the frame.
      expect(classes).toContain("relative");
      // Definite height: `h-full` on the mount resolves against it. A
      // min-h-only frame has no definite height and the mount
      // collapses (the UAT defect's second mechanism).
      expect(classes.some((c) => /^h-\[\d+px\]$/.test(c))).toBe(true);
      expect(classes.some((c) => c.startsWith("min-h-"))).toBe(false);
    },
  );
});

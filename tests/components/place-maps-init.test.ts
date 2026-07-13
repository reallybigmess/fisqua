/**
 * Tests — map readiness guard (UAT round-2 regression)
 *
 * Pins `ensureMapReady` from `app/components/admin/place-maps.tsx`
 * after the production defect where the map wedged silently: MapLibre's
 * `load` is a one-shot event fired from inside a single render frame,
 * and the init chain (resize, addSource/addLayer, fitBounds, event
 * bindings — everything behind the `ready` bump) hung on catching
 * exactly that frame. The guard must (1) run synchronously when the
 * map is already loaded, (2) run on `load` in the normal path,
 * (3) heal via `idle` when `load` was missed, and (4) never run the
 * callback twice. Stub object with `loaded()`/`once()` — no WebGL, no
 * rendering, same Workers-pool pure-contract pattern as the layout
 * test.
 *
 * @version v0.4.2
 */
import { describe, it, expect } from "vitest";
import { ensureMapReady } from "../../app/components/admin/place-maps";

function stubMap(loaded: boolean) {
  const handlers: Record<string, (() => void) | undefined> = {};
  return {
    loaded: () => loaded,
    once: (type: string, listener: () => void) => {
      handlers[type] = listener;
    },
    fire(type: string) {
      const h = handlers[type];
      // `once` semantics: a fired handler never runs again.
      handlers[type] = undefined;
      h?.();
    },
    attached: (type: string) => handlers[type] !== undefined,
  };
}

describe("ensureMapReady", () => {
  it("runs synchronously when the map is already loaded, attaching nothing", () => {
    const map = stubMap(true);
    let runs = 0;
    ensureMapReady(map, () => {
      runs += 1;
    });
    expect(runs).toBe(1);
    expect(map.attached("load")).toBe(false);
    expect(map.attached("idle")).toBe(false);
  });

  it("runs once on load in the normal path; a later idle does not re-run it", () => {
    const map = stubMap(false);
    let runs = 0;
    ensureMapReady(map, () => {
      runs += 1;
    });
    expect(runs).toBe(0);
    map.fire("load");
    expect(runs).toBe(1);
    map.fire("idle");
    expect(runs).toBe(1);
  });

  it("heals via idle when the load event was missed entirely", () => {
    const map = stubMap(false);
    let runs = 0;
    ensureMapReady(map, () => {
      runs += 1;
    });
    // The wedge scenario: load never fires; the next settle (e.g. a
    // user interaction) fires idle instead.
    map.fire("idle");
    expect(runs).toBe(1);
    map.fire("load");
    expect(runs).toBe(1);
  });
});

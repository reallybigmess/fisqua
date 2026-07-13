/**
 * Tests — MapTiler geocoding helpers (pure)
 *
 * Pins the request-URL shape (limit 5, Spanish labels, encoded query
 * and key — the key value itself is never asserted literally) and the
 * defensive response mapping: valid features map to {label, lat, lng}
 * with GeoJSON's [lng, lat] order corrected, and every malformed shape
 * degrades to zero results rather than a throw (the coordinate editor
 * must keep working when geocoding misbehaves). No network calls.
 *
 * @version v0.4.3
 */
import { describe, it, expect } from "vitest";
import {
  geocodeUrl,
  parseGeocodeResponse,
} from "../../app/lib/maptiler-geocode";

describe("geocodeUrl", () => {
  it("builds the geocoding endpoint with an encoded query and the key", () => {
    const url = new URL(geocodeUrl("test-key", "Santa Fe de Bogotá"));
    expect(url.origin).toBe("https://api.maptiler.com");
    expect(url.pathname).toBe(
      `/geocoding/${encodeURIComponent("Santa Fe de Bogotá")}.json`,
    );
    expect(url.searchParams.get("key")).toBe("test-key");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.get("language")).toBe("es");
  });

  it("encodes hostile query characters", () => {
    const url = geocodeUrl("k", "a/b?c&d");
    expect(url).toContain(encodeURIComponent("a/b?c&d"));
    expect(url).not.toContain("a/b?c&d.json");
  });
});

describe("parseGeocodeResponse", () => {
  it("maps features to results with [lng, lat] corrected", () => {
    const results = parseGeocodeResponse({
      features: [
        {
          center: [-74.0817, 4.6097],
          place_name: "Bogotá, Colombia",
          text: "Bogotá",
        },
      ],
    });
    expect(results).toEqual([
      { label: "Bogotá, Colombia", lat: 4.6097, lng: -74.0817 },
    ]);
  });

  it("falls back to text when place_name is missing", () => {
    const results = parseGeocodeResponse({
      features: [{ center: [-75.5, 10.4], text: "Cartagena" }],
    });
    expect(results).toEqual([{ label: "Cartagena", lat: 10.4, lng: -75.5 }]);
  });

  it("drops features without finite coordinates or a usable label", () => {
    const results = parseGeocodeResponse({
      features: [
        { center: ["x", 4.6], place_name: "Bad center" },
        { center: [-74], place_name: "Short center" },
        { center: [-74, 4.6] }, // no label
        { center: [-74, 4.6], place_name: "Good", text: "Good" },
      ],
    });
    expect(results).toHaveLength(1);
    expect(results[0].label).toBe("Good");
  });

  it("degrades to zero results on malformed payloads, never throwing", () => {
    for (const bad of [null, undefined, 42, "html error page", {}, { features: "x" }, []]) {
      expect(parseGeocodeResponse(bad)).toEqual([]);
    }
  });
});

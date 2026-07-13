/**
 * Admin — MapTiler geocoding (pure helpers)
 *
 * The coordinate editor's geocoding search (place-name → map fly-to)
 * calls MapTiler's Geocoding API with the SAME publishable key the map
 * style URL already uses — the key arrives per-request from the loader
 * (`env.MAPTILER_KEY`) and is never hardcoded. These helpers hold the
 * pure, testable parts: the request URL (limit 5, Spanish labels
 * preferred with automatic fallback, no country bias — colonial
 * toponyms span the Americas and Iberia) and the defensive response
 * mapping (a malformed or unexpected payload degrades to zero results,
 * never a throw — the manual editor keeps working).
 *
 * @version v0.4.3
 */

export interface GeocodeResult {
  label: string;
  lat: number;
  lng: number;
}

export function geocodeUrl(key: string, q: string): string {
  return `https://api.maptiler.com/geocoding/${encodeURIComponent(q)}.json?key=${encodeURIComponent(key)}&limit=5&language=es`;
}

/**
 * Map a MapTiler geocoding response (GeoJSON FeatureCollection) to the
 * dropdown's result shape. Every field access is defensive: features
 * without a finite `center` pair or a usable label are dropped.
 */
export function parseGeocodeResponse(json: unknown): GeocodeResult[] {
  if (typeof json !== "object" || json === null) return [];
  const features = (json as { features?: unknown }).features;
  if (!Array.isArray(features)) return [];
  const results: GeocodeResult[] = [];
  for (const f of features) {
    if (typeof f !== "object" || f === null) continue;
    const feature = f as {
      center?: unknown;
      place_name?: unknown;
      text?: unknown;
    };
    const center = feature.center;
    if (
      !Array.isArray(center) ||
      center.length < 2 ||
      !Number.isFinite(center[0]) ||
      !Number.isFinite(center[1])
    ) {
      continue;
    }
    const label =
      typeof feature.place_name === "string" && feature.place_name
        ? feature.place_name
        : typeof feature.text === "string" && feature.text
          ? feature.text
          : null;
    if (!label) continue;
    // GeoJSON order: [lng, lat].
    results.push({ label, lng: center[0], lat: center[1] });
  }
  return results;
}

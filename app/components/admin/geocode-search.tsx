/**
 * Admin — geocoding search for the coordinate editor (Juan's ruling,
 * 2026-07-11 addendum to the detail-page redesign)
 *
 * A search box inside the Geography card's edit mode: type a modern
 * place name, pick a result, and the coordinate editor flies there and
 * sets the pin — which stays draggable, with the synced lat/lon inputs
 * updating as they already do. Picking a result never auto-saves; the
 * existing save flow (and its needs-geocoding clearing) is untouched.
 *
 * Hand-rolled fetch + dropdown rather than a maplibre geocoder plugin:
 * the codebase carries no geocoder dependency and its UI is hand-rolled
 * Tailwind throughout, so a plugin would add a package for one input.
 * Calls MapTiler's Geocoding API with the SAME publishable key the map
 * style URL uses (per-request from the loader, never hardcoded), via
 * the pure helpers in `~/lib/maptiler-geocode` (limit 5, Spanish labels
 * preferred, no country bias). Requests debounce at 300ms and abort on
 * supersession. Failures degrade silently to the manual editor: a quiet
 * inline notice, no thrown errors, the map keeps working.
 *
 * @version v0.4.3
 */

import { useState, useEffect, useRef } from "react";
import { Search } from "lucide-react";
import {
  geocodeUrl,
  parseGeocodeResponse,
  type GeocodeResult,
} from "~/lib/maptiler-geocode";

export function GeocodeSearch({
  maptilerKey,
  onPick,
  t,
}: {
  maptilerKey: string;
  /** Fires with the picked result's coordinates (and label). */
  onPick: (result: GeocodeResult) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // Suppresses the lookup that would otherwise re-fire when picking a
  // result writes the label back into the input.
  const skipNextRef = useRef(false);

  useEffect(() => {
    if (skipNextRef.current) {
      skipNextRef.current = false;
      return;
    }
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }
    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch(geocodeUrl(maptilerKey, q), {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`geocoding ${res.status}`);
        const json = await res.json();
        setResults(parseGeocodeResponse(json));
        setOpen(true);
        setFailed(false);
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        // Quota problems, network failures, unexpected payloads: the
        // manual editor stays fully usable — just say so quietly.
        setResults([]);
        setOpen(false);
        setFailed(true);
      }
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  return (
    <div className="relative">
      <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-stone-500" />
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onFocus={() => results.length > 0 && setOpen(true)}
        onKeyDown={(e) => {
          // The search box lives inside the record's edit <Form>:
          // without this, Enter triggers the form's implicit
          // submission and SAVES the record. Searching must never
          // save (the ruling's "picking a result never auto-saves").
          if (e.key === "Enter") e.preventDefault();
        }}
        placeholder={t("geocodePlaceholder")}
        aria-label={t("geocodePlaceholder")}
        className="w-full rounded-lg border border-stone-200 py-2 pl-8 pr-3 font-sans text-sm text-stone-700 placeholder:text-stone-400 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
      />
      {failed && (
        <p className="mt-1 text-11 text-stone-500">
          {t("geocodeUnavailable")}
        </p>
      )}
      {open && (
        <ul className="absolute z-30 mt-1 w-full overflow-hidden rounded-lg border border-stone-200 bg-white shadow-lg">
          {results.length === 0 ? (
            <li className="px-3 py-2 text-13 text-stone-400">
              {t("geocodeNoResults")}
            </li>
          ) : (
            results.map((r, i) => (
              <li key={`${r.lat},${r.lng},${i}`}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    skipNextRef.current = true;
                    setQuery(r.label);
                    setOpen(false);
                    onPick(r);
                  }}
                  className="block w-full px-3 py-2 text-left text-13 text-stone-700 hover:bg-stone-50"
                >
                  {r.label}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

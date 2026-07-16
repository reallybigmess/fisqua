/**
 * Admin — Place map surfaces (client-only MapLibre)
 *
 * The three map surfaces of the places module (spec §5, design handoff
 * surfaces 8–10): the clustered map explorer, the detail-page map
 * preview, and the interactive coordinate editor. All three share
 * `useMapLibre`, which LAZY-LOADS `maplibre-gl` (and its stylesheet)
 * inside a client effect — React Router v7 renders these routes on the
 * Worker, and MapLibre touches `window`/WebGL at import time, so the
 * library must never enter the SSR module graph. The route modules
 * import THIS file statically (it holds no top-level maplibre import);
 * the dynamic import runs only in the browser.
 *
 * Tiles: MapTiler hosted vector tiles behind a MapLibre style URL
 * (spec §5 ruling). The style id is a swappable constant; `dataviz` is
 * MapTiler's neutral ramp, matching the handoff's muted basemap. The
 * key arrives per-request from the loader (`env.MAPTILER_KEY`) — never
 * hardcoded here.
 *
 * Clustering follows the proven Zasqua place-explorer parameters
 * (clusterMaxZoom 12, clusterRadius 50; survey 2026-07-10 Part 1).
 * Unclustered points render as madder circle markers rather than the
 * handoff's `map-pin` glyphs — a documented deviation: 7K DOM markers
 * are not viable and a glyph sprite adds an asset pipeline for no
 * behavioural gain.
 *
 * The explorer is the shared map surface of the combined places page
 * (spec §5 "Combined places surface"). It accepts a `selectedId` in and
 * emits `onSelect` out so the adjacent list and the map stay in sync:
 * selecting a row flies the map to the pin and shows its card; clicking
 * a pin reports the id so the page can scroll the matching row into
 * view. The selected point renders a distinct verdigris highlight layer
 * above the madder cluster/point layers.
 *
 * @version v0.4.3
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { Link } from "react-router";
import { Plus, Minus, MousePointerClick, MapPinOff } from "lucide-react";

/** MapTiler style id — swappable behind MapLibre (spec §5). */
const MAPTILER_STYLE = "dataviz";

/** Design tokens the map layers need as literals. */
const INDIGO = "#1f2e4d";
const MADDER = "#b5533d";
/** Verdigris-deep — the selection colour shared with the list rows. */
const VERDIGRIS_DEEP = "#2c5c53";

/** An empty GeoJSON feature collection (initial selected-layer data). */
const EMPTY_FC = { type: "FeatureCollection" as const, features: [] };

function styleUrl(key: string): string {
  return `https://api.maptiler.com/maps/${MAPTILER_STYLE}/style.json?key=${key}`;
}

/**
 * Map layout contract — exported so a regression test can pin it
 * without WebGL.
 *
 * The mount element MUST be sized by an explicit in-flow height chain
 * (`h-full w-full` under a frame with a DEFINITE height), never by
 * `absolute inset-0`: MapLibre stamps `.maplibregl-map` onto the mount
 * at init, and its stylesheet — appended after Tailwind's by the
 * dynamic import — declares `position: relative` at equal specificity,
 * which strips the absolute positioning, collapses the element to 0px,
 * and initialises the map with a 0×0 viewport that never requests a
 * tile. Likewise the frame needs `h-[…]`, not `min-h-[…]`: a
 * min-height-only parent has no definite height for the child's
 * percentage to resolve against.
 */
export const MAP_MOUNT_CLASSES = "h-full w-full";
export const MAP_FRAME_CLASSES = {
  explorer:
    "relative h-[520px] overflow-hidden rounded-[10px] border border-stone-200",
  preview: "relative h-[200px] overflow-hidden rounded-lg border border-stone-200",
  editor: "relative h-[420px] overflow-hidden rounded-lg border border-stone-200",
} as const;

export interface MapPoint {
  id: string;
  name: string;
  code: string | null;
  /** Place type — carried so the combined page's viewport-filtered list
   * rows can show the same sub-line as the server-paginated rows. */
  type: string | null;
  count: number;
  lat: number;
  lng: number;
}

export interface Viewport {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** The slice of a MapLibre map the readiness guard needs (stub-testable). */
export interface MapReadyTarget {
  loaded(): boolean;
  once(type: string, listener: () => void): unknown;
}

/**
 * Run `cb` exactly once, as soon as the map is ready for style-
 * dependent work (addSource/addLayer/fitBounds/resize).
 *
 * MapLibre's `load` is a ONE-SHOT event fired from inside a render
 * frame the first time `map.loaded()` flips true (see
 * `maplibre-gl.js`: `this.loaded()&&!this._loaded&&(...fire("load"))`).
 * Hanging the entire init chain on catching that single frame is
 * fragile: if `loaded()` is already true by the time the caller can
 * attach (fast-cache style loads), or the firing frame is missed or
 * never scheduled, a sole `once("load")` never runs and the map wedges
 * silently — layers never added, no error, no tiles (the phase-4 UAT
 * defect). Three guards, first one wins, `cb` runs once:
 *
 *   1. `loaded()` already true → run synchronously;
 *   2. `once("load")` — the normal path;
 *   3. `once("idle")` — the safety net: `idle` re-fires on EVERY
 *      settle (camera, tiles, fades), so even a missed `load` heals on
 *      the next settle, including one triggered by user interaction.
 */
export function ensureMapReady(map: MapReadyTarget, cb: () => void): void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    cb();
  };
  if (map.loaded()) {
    run();
    return;
  }
  map.once("load", run);
  map.once("idle", run);
}

/**
 * Create a MapLibre map in `container` once, on the client only. The
 * library is dynamically imported inside the effect, keeping it out of
 * the SSR bundle. Returns the map ref (null until ready) and a
 * readiness counter that bumps when the map has loaded its style.
 */
function useMapLibre(
  container: React.RefObject<HTMLDivElement | null>,
  options: {
    maptilerKey: string;
    center: [number, number];
    zoom: number;
    interactive?: boolean;
  },
) {
  const mapRef = useRef<any>(null);
  const [ready, setReady] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let map: any = null;
    (async () => {
      const [{ default: maplibregl }] = await Promise.all([
        import("maplibre-gl"),
        // Vite code-splits the stylesheet with the dynamic import.
        import("maplibre-gl/dist/maplibre-gl.css"),
      ]);
      if (cancelled || !container.current) return;
      map = new maplibregl.Map({
        container: container.current,
        style: styleUrl(options.maptilerKey),
        center: options.center,
        zoom: options.zoom,
        interactive: options.interactive !== false,
        attributionControl: false,
      });
      mapRef.current = map;
      // Re-measure immediately: if layout settled between mount and
      // the (dynamic-import-delayed) construction, the constructor's
      // initial measure can be stale. trackResize's ResizeObserver
      // covers later changes.
      map.resize();
      ensureMapReady(map, () => {
        if (cancelled) return;
        map.resize();
        setReady((n) => n + 1);
      });
    })();
    return () => {
      cancelled = true;
      if (map) map.remove();
      mapRef.current = null;
    };
    // The map is created once; option changes require a remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { mapRef, ready };
}

/** Bogotá — a sensible default centre for the corpus. */
const DEFAULT_CENTER: [number, number] = [-74.1, 4.6];

function boundsFor(points: MapPoint[]): [[number, number], [number, number]] | null {
  if (points.length === 0) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const p of points) {
    if (p.lng < west) west = p.lng;
    if (p.lng > east) east = p.lng;
    if (p.lat < south) south = p.lat;
    if (p.lat > north) north = p.lat;
  }
  return [
    [west, south],
    [east, north],
  ];
}

const ATTRIBUTION = "© MapTiler · © OpenStreetMap contributors";

/**
 * MapTiler attribution for every map surface. The account behind the
 * key is on MapTiler's FREE plan, whose terms make the LOGO mandatory
 * (text-only attribution is a paid-plan feature) — so each surface
 * renders MapTiler's canonical CDN-served logo mark linking to
 * maptiler.com, per their MapLibre integration guidance, alongside the
 * text line.
 */
function MapAttribution() {
  return (
    <div className="absolute bottom-1 left-2 z-10 flex items-end gap-2">
      <a
        href="https://www.maptiler.com/"
        target="_blank"
        rel="noopener noreferrer"
      >
        <img
          src="https://api.maptiler.com/resources/logo.svg"
          alt="MapTiler"
          className="h-5 w-auto"
        />
      </a>
      <p className="text-10 text-stone-500">{ATTRIBUTION}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Surface 8 — clustered map explorer
// ---------------------------------------------------------------------------

export function PlaceMapExplorer({
  points,
  maptilerKey,
  onViewportChange,
  selectedId,
  onSelect,
  t,
}: {
  points: MapPoint[];
  maptilerKey: string;
  /** Fires on moveend with the current bounds (viewport filter). */
  onViewportChange?: (viewport: Viewport) => void;
  /** The list's currently-selected place; flies the map to its pin. */
  selectedId?: string | null;
  /** Fires when a pin is clicked, so the page can highlight/scroll its row. */
  onSelect?: (id: string) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { mapRef, ready } = useMapLibre(containerRef, {
    maptilerKey,
    center: DEFAULT_CENTER,
    zoom: 5,
  });
  const [selected, setSelected] = useState<{
    point: MapPoint;
    x: number;
    y: number;
  } | null>(null);
  const [hovered, setHovered] = useState<{
    name: string;
    code: string | null;
    x: number;
    y: number;
  } | null>(null);
  const pointsRef = useRef(points);
  pointsRef.current = points;
  // The callback is read from a ref so wiring it into the once-only
  // layer effect never re-runs that effect.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // Layer + interaction wiring once the style is loaded.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || ready === 0) return;

    const geojson = {
      type: "FeatureCollection" as const,
      features: pointsRef.current.map((p) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
        properties: {
          id: p.id,
          name: p.name,
          code: p.code ?? "",
          type: p.type ?? "",
          count: p.count,
        },
      })),
    };

    if (!map.getSource("places")) {
      map.addSource("places", {
        type: "geojson",
        data: geojson,
        cluster: true,
        clusterMaxZoom: 12,
        clusterRadius: 50,
      });
      map.addLayer({
        id: "clusters",
        type: "circle",
        source: "places",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": INDIGO,
          "circle-radius": [
            "step",
            ["get", "point_count"],
            14,
            50,
            18,
            250,
            24,
          ],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
        },
      });
      map.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: "places",
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-size": 12,
        },
        paint: { "text-color": "#ffffff" },
      });
      map.addLayer({
        id: "unclustered-point",
        type: "circle",
        source: "places",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": MADDER,
          "circle-radius": 6,
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#ffffff",
        },
      });
      // Selection highlight: a single verdigris point drawn above the
      // madder markers, fed by the `selectedId` effect below. Its own
      // source keeps the highlight independent of clustering.
      if (!map.getSource("selected")) {
        map.addSource("selected", { type: "geojson", data: EMPTY_FC });
        map.addLayer({
          id: "selected-point",
          type: "circle",
          source: "selected",
          paint: {
            "circle-color": VERDIGRIS_DEEP,
            "circle-radius": 9,
            "circle-stroke-width": 2.5,
            "circle-stroke-color": "#ffffff",
          },
        });
      }

      // Click a cluster → zoom-expand (Zasqua pattern).
      map.on("click", "clusters", async (e: any) => {
        const feature = map.queryRenderedFeatures(e.point, {
          layers: ["clusters"],
        })[0];
        const clusterId = feature.properties.cluster_id;
        const source = map.getSource("places");
        const zoom = await source.getClusterExpansionZoom(clusterId);
        map.easeTo({ center: feature.geometry.coordinates, zoom });
      });

      // Click a pin → compact card popover (React overlay).
      map.on("click", "unclustered-point", (e: any) => {
        const f = e.features[0];
        const p: MapPoint = {
          id: f.properties.id,
          name: f.properties.name,
          code: f.properties.code || null,
          type: f.properties.type || null,
          count: Number(f.properties.count) || 0,
          lng: f.geometry.coordinates[0],
          lat: f.geometry.coordinates[1],
        };
        const px = map.project(f.geometry.coordinates);
        setSelected({ point: p, x: px.x, y: px.y });
        setHovered(null);
        // Report the click so the page can highlight and scroll the row.
        onSelectRef.current?.(p.id);
      });

      // Hover → small name+code popup.
      map.on("mousemove", "unclustered-point", (e: any) => {
        map.getCanvas().style.cursor = "pointer";
        const f = e.features[0];
        const px = map.project(f.geometry.coordinates);
        setHovered({
          name: f.properties.name,
          code: f.properties.code || null,
          x: px.x,
          y: px.y,
        });
      });
      map.on("mouseleave", "unclustered-point", () => {
        map.getCanvas().style.cursor = "";
        setHovered(null);
      });
      map.on("mouseenter", "clusters", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "clusters", () => {
        map.getCanvas().style.cursor = "";
      });

      // Any movement drops the anchored overlays and reports bounds.
      map.on("move", () => {
        setSelected(null);
        setHovered(null);
      });
      map.on("moveend", () => {
        if (!onViewportChange) return;
        const b = map.getBounds();
        onViewportChange({
          west: b.getWest(),
          south: b.getSouth(),
          east: b.getEast(),
          north: b.getNorth(),
        });
      });

      const bounds = boundsFor(pointsRef.current);
      if (bounds) {
        map.fitBounds(bounds, { padding: 48, maxZoom: 10, animate: false });
      }
      // Report the initial viewport once positioned.
      if (onViewportChange) {
        map.once("idle", () => {
          const b = map.getBounds();
          onViewportChange({
            west: b.getWest(),
            south: b.getSouth(),
            east: b.getEast(),
            north: b.getNorth(),
          });
        });
      }
    } else {
      map.getSource("places").setData(geojson);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, points]);

  // Selection sync (row → map): fly to the selected place's pin, paint
  // the highlight, and show its card once the camera settles. A
  // selection with no matching located point (coordinate-less place, or
  // one filtered out of the payload) simply clears the highlight.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || ready === 0) return;
    const src = map.getSource("selected");
    const pt = selectedId
      ? pointsRef.current.find((p) => p.id === selectedId)
      : undefined;
    if (!pt) {
      if (src) src.setData(EMPTY_FC);
      return;
    }
    if (src) {
      src.setData({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [pt.lng, pt.lat] },
            properties: {},
          },
        ],
      });
    }
    map.flyTo({
      center: [pt.lng, pt.lat],
      zoom: Math.max(map.getZoom(), 9),
    });
    const show = () => {
      const px = map.project([pt.lng, pt.lat]);
      setSelected({ point: pt, x: px.x, y: px.y });
    };
    map.once("moveend", show);
    return () => {
      map.off("moveend", show);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, ready]);

  const zoom = useCallback(
    (delta: number) => {
      const map = mapRef.current;
      if (!map) return;
      if (delta > 0) map.zoomIn();
      else map.zoomOut();
    },
    [mapRef],
  );

  return (
    <div className={MAP_FRAME_CLASSES.explorer}>
      <div ref={containerRef} className={MAP_MOUNT_CLASSES} />

      {/* Zoom controls */}
      <div className="absolute right-3 top-3 flex flex-col overflow-hidden rounded-md border border-stone-200 bg-white shadow-sm">
        <button
          type="button"
          aria-label={t("mapZoomIn")}
          onClick={() => zoom(1)}
          className="flex h-8 w-8 items-center justify-center text-stone-600 hover:bg-stone-50"
        >
          <Plus className="h-4 w-4" strokeWidth={1.5} />
        </button>
        <button
          type="button"
          aria-label={t("mapZoomOut")}
          onClick={() => zoom(-1)}
          className="flex h-8 w-8 items-center justify-center border-t border-stone-200 text-stone-600 hover:bg-stone-50"
        >
          <Minus className="h-4 w-4" strokeWidth={1.5} />
        </button>
      </div>

      {/* Attribution */}
      <MapAttribution />

      {/* Hover popup */}
      {hovered && !selected && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border border-stone-200 bg-white px-2.5 py-1.5 shadow-md"
          style={{ left: hovered.x, top: hovered.y - 10 }}
        >
          <p className="font-serif text-13 text-indigo">{hovered.name}</p>
          {hovered.code && (
            <p className="font-mono text-10 nums text-stone-500">
              {hovered.code}
            </p>
          )}
        </div>
      )}

      {/* Pin card popover */}
      {selected && (
        <div
          className="absolute z-20 w-56 -translate-x-1/2 -translate-y-full rounded-[10px] bg-white p-3 shadow-lg"
          style={{ left: selected.x, top: selected.y - 12 }}
        >
          <p className="font-serif text-15 text-indigo">
            {selected.point.name}
          </p>
          <p className="mt-0.5 font-mono text-11 nums text-stone-500">
            {[
              selected.point.code,
              t("mapDescriptions", { count: selected.point.count }),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <Link
            to={`/admin/places/${selected.point.id}`}
            className="mt-2 inline-block text-13 font-semibold text-verdigris-deep underline hover:text-verdigris"
          >
            {t("mapOpenRecord")}
          </Link>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Surface 9 — detail-page map preview
// ---------------------------------------------------------------------------

export function PlaceMapPreview({
  lat,
  lng,
  maptilerKey,
}: {
  lat: number;
  lng: number;
  maptilerKey: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { mapRef, ready } = useMapLibre(containerRef, {
    maptilerKey,
    center: [lng, lat],
    zoom: 9,
    interactive: false,
  });

  useEffect(() => {
    const map = mapRef.current;
    if (!map || ready === 0) return;
    (async () => {
      const { default: maplibregl } = await import("maplibre-gl");
      new maplibregl.Marker({ color: MADDER }).setLngLat([lng, lat]).addTo(map);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  return (
    <div className={MAP_FRAME_CLASSES.preview}>
      <div ref={containerRef} className={MAP_MOUNT_CLASSES} />
      <MapAttribution />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Surface 10 — interactive coordinate editor map
// ---------------------------------------------------------------------------

export function CoordinateMapEditor({
  lat,
  lng,
  onChange,
  maptilerKey,
  flyTo,
  t,
}: {
  lat: number | null;
  lng: number | null;
  /** Fires with 6-decimal-rounded coordinates on click or drag. */
  onChange: (lat: number, lng: number) => void;
  maptilerKey: string;
  /** A geocode pick: fly the camera there. The token distinguishes a
   * deliberate fly (search result) from the ordinary lat/lng prop sync
   * (typed inputs, pin drags), which must never move the camera. */
  flyTo?: { lat: number; lng: number; token: number } | null;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hasCoords = lat != null && lng != null;
  const { mapRef, ready } = useMapLibre(containerRef, {
    maptilerKey,
    center: hasCoords ? [lng!, lat!] : DEFAULT_CENTER,
    zoom: hasCoords ? 10 : 5,
  });
  const markerRef = useRef<any>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

  // Click-to-set wiring.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || ready === 0) return;
    map.getCanvas().style.cursor = "crosshair";
    map.on("click", (e: any) => {
      onChangeRef.current(round6(e.lngLat.lat), round6(e.lngLat.lng));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // Geocode-pick fly-to (Juan's 2026-07-11 ruling): keyed on the token
  // so ordinary coordinate syncs never move the camera.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || ready === 0 || !flyTo) return;
    map.flyTo({
      center: [flyTo.lng, flyTo.lat],
      zoom: Math.max(map.getZoom(), 12),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, flyTo?.token]);

  // Keep the draggable marker in sync with the inputs.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || ready === 0) return;
    (async () => {
      const { default: maplibregl } = await import("maplibre-gl");
      if (lat != null && lng != null) {
        if (!markerRef.current) {
          markerRef.current = new maplibregl.Marker({
            color: MADDER,
            draggable: true,
          })
            .setLngLat([lng, lat])
            .addTo(map);
          markerRef.current.on("dragend", () => {
            const pos = markerRef.current.getLngLat();
            onChangeRef.current(round6(pos.lat), round6(pos.lng));
          });
        } else {
          markerRef.current.setLngLat([lng, lat]);
        }
      } else if (markerRef.current) {
        markerRef.current.remove();
        markerRef.current = null;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, lat, lng]);

  return (
    <div className={MAP_FRAME_CLASSES.editor}>
      <div ref={containerRef} className={MAP_MOUNT_CLASSES} />

      {!hasCoords && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2">
          <span className="flex h-10 w-10 items-center justify-center rounded-md bg-white shadow-sm">
            <MousePointerClick className="h-5 w-5 text-indigo" strokeWidth={1.5} />
          </span>
          <p className="rounded-md bg-white/90 px-3 py-1 text-13 text-stone-600">
            {t("coordClickPrompt")}
          </p>
        </div>
      )}

      {hasCoords && (
        <p className="absolute left-3 top-3 rounded-full border border-stone-200 bg-white px-3 py-1 text-11 text-stone-600 shadow-sm">
          {t("coordDragHint")}
        </p>
      )}

      <MapAttribution />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared empty-state tile (map surfaces without coordinates)
// ---------------------------------------------------------------------------

export function NoCoordinatesWell({
  title,
  className,
}: {
  title: string;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-2 rounded-lg border border-stone-200 bg-stone-50 ${className ?? "h-[200px]"}`}
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-md bg-white shadow-sm">
        <MapPinOff className="h-5 w-5 text-stone-400" strokeWidth={1.5} />
      </span>
      <p className="font-serif text-15 text-indigo">{title}</p>
    </div>
  );
}

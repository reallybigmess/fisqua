/**
 * Locale Resource Bundle
 *
 * This module deals with the top-level i18next resource map — the
 * `{ es, en }` shape that both the server middleware (`i18nextMiddleware`)
 * and the client hydration entry (`entry.client.tsx`) load to wire
 * up Spanish and English translations. Each per-language entry is a
 * pre-aggregated namespace map built by `./es.ts` and `./en.ts`.
 * Spanish is listed first because Fisqua's fallback language is `es`.
 *
 * @version v0.3.0
 */
import type { Resource } from "i18next";
import es from "./es";
import en from "./en";

export default { es, en } satisfies Resource;

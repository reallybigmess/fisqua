/**
 * Linked Open Data Link Field
 *
 * This component is the input for an external authority identifier
 * (Wikidata, VIAF, TGN) with a click-through link icon that opens the
 * resolved URL in a new tab.
 *
 * @version v0.4.3
 */

import { useState } from "react";
import { ExternalLink } from "lucide-react";

type LodService = "wikidata" | "viaf" | "tgn" | "hgis" | "whg";

interface LodLinkFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  service: LodService;
  disabled?: boolean;
  error?: string;
}

const SERVICE_PATTERNS: Record<LodService, RegExp> = {
  wikidata: /^Q\d+$/,
  viaf: /^\d+$/,
  tgn: /^\d+$/,
  hgis: /^[a-zA-Z0-9]+$/,
  whg: /^[a-zA-Z0-9]+$/,
};

/** Exported for the detail pages' linked-open-data cards, which
 * render the same external links outside the edit field. */
export const SERVICE_URLS: Record<LodService, (id: string) => string> = {
  wikidata: (id) => `https://www.wikidata.org/wiki/${id}`,
  viaf: (id) => `https://viaf.org/viaf/${id}`,
  tgn: (id) => `https://vocab.getty.edu/tgn/${id}`,
  hgis: (id) => `https://hgis-indias.net/place/${id}`,
  whg: (id) => `https://whgazetteer.org/places/${id}`,
};

export function LodLinkField({
  label,
  value,
  onChange,
  service,
  disabled = false,
  error: externalError,
}: LodLinkFieldProps) {
  const [localError, setLocalError] = useState<string | null>(null);

  function handleBlur() {
    if (!value) {
      setLocalError(null);
      return;
    }
    if (!SERVICE_PATTERNS[service].test(value)) {
      setLocalError("Invalid format");
    } else {
      setLocalError(null);
    }
  }

  const displayError = externalError || localError;
  const hasError = !!displayError;

  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <label className="text-xs font-medium text-indigo">{label}</label>
        {value && !hasError && (
          <a
            href={SERVICE_URLS[service](value)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open ${service} record in new tab`}
          >
            <ExternalLink className="h-3.5 w-3.5 text-indigo-deep" />
          </a>
        )}
      </div>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={handleBlur}
        disabled={disabled}
        className={`w-full rounded-lg border px-3 py-2 font-sans text-sm text-stone-700 focus:outline-none focus:ring-1 ${ hasError ? "border-madder focus:border-madder focus:ring-madder" : "border-stone-200 focus:border-indigo focus:ring-indigo" } disabled:cursor-not-allowed disabled:opacity-50`}
      />
      {displayError && (
        <p className="mt-1 text-xs text-madder">{displayError}</p>
      )}
    </div>
  );
}

/**
 * Admin — repository identity fields (name, code, country, country code)
 *
 * Shared by the repositories create and edit forms: the operator picks a
 * country from an ISO 3166-1 select instead of hand-typing both codes.
 * Picking a country fills the alpha-3 `countryCode` input, and the name +
 * country derive a suggested repository `code` per the house convention
 * (`repository-code.ts`).
 *
 * Dirty-flag rule (both derived fields): a derived value tracks its
 * sources only while the field is untouched by hand; one hand edit stops
 * the tracking for good, and clearing the field by hand resumes it. The
 * code field on the EDIT form starts non-empty and therefore counts as
 * hand-edited from the outset — an existing code is an identifier
 * (exports stamp it on every record) and must never be silently
 * rewritten; a "use suggestion" affordance offers the derivation instead.
 *
 * Stored shapes are unchanged: `country` remains free text (a hidden
 * input carries it; the select is chrome), `countryCode` remains a string
 * the operator can always overtype. A stored country that matches no ISO
 * entry — or whose text differs from the entry's localised name — is kept
 * verbatim behind a fallback option, so an edit that never touches the
 * select can never rewrite it.
 *
 * i18n-agnostic: callers pass resolved strings.
 *
 * @version v0.6.0
 */

import { useMemo, useState } from "react";
import {
  countriesSortedFor,
  countryByAlpha2,
  countryName,
  type Country,
} from "../../lib/countries";
import { suggestRepositoryCode, suggestFromTypedCode } from "../../lib/repository-code";

/** The select value for a stored free-text country matching no entry. */
const STORED_VALUE = "__stored__";

export interface RepositoryIdentity {
  name: string;
  code: string;
  codeDirty: boolean;
  countryKey: string;
  countryText: string;
  countryCode: string;
  countryCodeDirty: boolean;
  storedCountry: string;
  locale: string;
  suggestion: string | null;
  setName: (value: string) => void;
  setCode: (value: string) => void;
  applySuggestion: () => void;
  selectCountry: (key: string) => void;
  setCountryCode: (value: string) => void;
}

/**
 * The state machine behind the four fields. `init` carries the stored row
 * on the edit form; blank on create.
 */
export function useRepositoryIdentity(init: {
  name?: string;
  code?: string;
  country?: string;
  countryCode?: string;
  locale: string;
}): RepositoryIdentity {
  const storedCountry = init.country ?? "";
  const initialKey = useMemo(() => {
    if (storedCountry === "") return "";
    const match = countriesSortedFor(init.locale).find(
      (c) => c.nameEn === storedCountry || c.nameEs === storedCountry,
    );
    return match ? match.alpha2 : STORED_VALUE;
  }, [storedCountry, init.locale]);

  const [name, setNameState] = useState(init.name ?? "");
  const [code, setCodeState] = useState(init.code ?? "");
  // An existing code is an identifier — never silently rewritten.
  const [codeDirty, setCodeDirty] = useState((init.code ?? "") !== "");
  const [countryKey, setCountryKey] = useState(initialKey);
  // The SUBMITTED country text: initialised to the stored text verbatim
  // (never normalised to a localised name by a save that skips the select).
  const [countryText, setCountryText] = useState(storedCountry);
  const [countryCode, setCountryCodeState] = useState(init.countryCode ?? "");
  const [countryCodeDirty, setCountryCodeDirty] = useState(false);

  const country: Country | null =
    countryKey !== "" && countryKey !== STORED_VALUE ? countryByAlpha2(countryKey) : null;
  // Untouched field: the suggestion derives initials from the Name and
  // auto-fills. Hand-edited field: the suggestion is the operator's OWN
  // value, country-prefixed ("test" → "us-test") — never re-derived from
  // the Name — and null when the value already carries the prefix.
  const suggestion = country
    ? codeDirty
      ? suggestFromTypedCode(code, country)
      : name.trim() !== ""
        ? suggestRepositoryCode(name, country)
        : null
    : null;

  const setName = (value: string) => {
    setNameState(value);
    if (!codeDirty && country) {
      setCodeState(suggestRepositoryCode(value, country) ?? "");
    }
  };

  const setCode = (value: string) => {
    setCodeState(value);
    setCodeDirty(value !== "");
  };

  const applySuggestion = () => {
    if (suggestion === null) return;
    setCodeState(suggestion);
    // The field stays hand-edited: the applied value is the operator's own
    // word (prefixed), and later Name typing must not overwrite it.
  };

  const selectCountry = (key: string) => {
    setCountryKey(key);
    if (key === STORED_VALUE) {
      setCountryText(storedCountry);
      return;
    }
    const entry = key === "" ? null : countryByAlpha2(key);
    setCountryText(entry ? countryName(entry, init.locale) : "");
    if (entry && !countryCodeDirty) setCountryCodeState(entry.alpha3);
    if (entry && !codeDirty && name.trim() !== "") {
      setCodeState(suggestRepositoryCode(name, entry) ?? "");
    }
  };

  const setCountryCode = (value: string) => {
    setCountryCodeState(value);
    setCountryCodeDirty(value !== "");
  };

  return {
    name,
    code,
    codeDirty,
    countryKey,
    countryText,
    countryCode,
    countryCodeDirty,
    storedCountry,
    locale: init.locale,
    suggestion,
    setName,
    setCode,
    applySuggestion,
    selectCountry,
    setCountryCode,
  };
}

const INPUT_CLASS =
  "w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo";

function FieldShell({
  name,
  label,
  required,
  error,
  children,
}: {
  name: string;
  label: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-xs font-medium text-indigo">
        {label}
        {required && <span className="text-madder"> *</span>}
      </label>
      {children}
      {error && (
        <p id={`${name}-error`} className="mt-1 text-xs text-madder">
          {error}
        </p>
      )}
    </div>
  );
}

export function RepoNameInput({
  identity,
  label,
  required,
  error,
}: {
  identity: RepositoryIdentity;
  label: string;
  required?: boolean;
  error?: string;
}) {
  return (
    <FieldShell name="name" label={label} required={required} error={error}>
      <input
        type="text"
        id="name"
        name="name"
        value={identity.name}
        onChange={(e) => identity.setName(e.target.value)}
        aria-required={required ? "true" : undefined}
        aria-describedby={error ? "name-error" : undefined}
        className={INPUT_CLASS}
      />
    </FieldShell>
  );
}

export function RepoCodeInput({
  identity,
  label,
  required,
  error,
  help,
  suggestionLabel,
  useSuggestionLabel,
}: {
  identity: RepositoryIdentity;
  label: string;
  required?: boolean;
  error?: string;
  /** One-clause teaching help: what the code is for + the convention. */
  help: string;
  /** e.g. "Suggested: {{code}}", already interpolated by the caller. */
  suggestionLabel: string | null;
  useSuggestionLabel: string;
}) {
  const showAffordance =
    identity.codeDirty && identity.suggestion !== null && identity.suggestion !== identity.code;
  return (
    <FieldShell name="code" label={label} required={required} error={error}>
      <p id="code-help" className="mb-1 text-xs text-stone-400">
        {help}
      </p>
      <input
        type="text"
        id="code"
        name="code"
        value={identity.code}
        onChange={(e) => identity.setCode(e.target.value)}
        aria-required={required ? "true" : undefined}
        aria-describedby={error ? "code-error" : "code-help"}
        className={INPUT_CLASS}
      />
      {showAffordance && suggestionLabel && (
        <p className="mt-1 flex items-center gap-2 text-xs text-stone-500" role="status">
          <span className="font-mono">{suggestionLabel}</span>
          <button
            type="button"
            onClick={identity.applySuggestion}
            className="font-semibold text-indigo underline"
          >
            {useSuggestionLabel}
          </button>
        </p>
      )}
    </FieldShell>
  );
}

export function RepoCountrySelect({
  identity,
  label,
  chooseLabel,
  error,
}: {
  identity: RepositoryIdentity;
  label: string;
  chooseLabel: string;
  error?: string;
}) {
  const options = countriesSortedFor(identity.locale);
  const showStoredFallback =
    identity.storedCountry !== "" &&
    !options.some(
      (c) => c.nameEn === identity.storedCountry || c.nameEs === identity.storedCountry,
    );
  return (
    <FieldShell name="country" label={label} error={error}>
      {/* The submitted free-text country rides in the hidden input; the
          select is chrome over the ISO dataset. */}
      <input type="hidden" name="country" value={identity.countryText} />
      <select
        id="country"
        value={identity.countryKey}
        onChange={(e) => identity.selectCountry(e.target.value)}
        aria-describedby={error ? "country-error" : undefined}
        className={INPUT_CLASS}
      >
        <option value="">{chooseLabel}</option>
        {showStoredFallback && (
          <option value={STORED_VALUE}>{identity.storedCountry}</option>
        )}
        {options.map((c) => (
          <option key={c.alpha2} value={c.alpha2}>
            {countryName(c, identity.locale)}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export function RepoCountryCodeInput({
  identity,
  label,
  required,
  error,
  help,
}: {
  identity: RepositoryIdentity;
  label: string;
  required?: boolean;
  error?: string;
  help: string;
}) {
  return (
    <FieldShell name="countryCode" label={label} required={required} error={error}>
      <p id="countryCode-help" className="mb-1 text-xs text-stone-400">
        {help}
      </p>
      <input
        type="text"
        id="countryCode"
        name="countryCode"
        value={identity.countryCode}
        onChange={(e) => identity.setCountryCode(e.target.value)}
        aria-required={required ? "true" : undefined}
        aria-describedby={error ? "countryCode-error" : "countryCode-help"}
        className={INPUT_CLASS}
      />
    </FieldShell>
  );
}

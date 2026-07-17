/**
 * Tests — repository code suggestion + ISO 3166-1 dataset sanity
 *
 * The suggestion derivation is pinned against the production convention's
 * own examples (real repository names from production rows — reference
 * fixtures, not invented records): "pe-bn", "co-ahrb", and the SBMAL case
 * "us-sbmal". The CIHJML row is asserted at what the derivation actually
 * yields ("co-cihjmal"): production's "co-cihjml" hand-shortened one
 * initial, which is exactly what the dirty-flag editing path is for — the
 * suggestion proposes, the operator disposes.
 *
 * The dataset test pins uniqueness and format of every alpha-2/alpha-3
 * pair, non-empty names in both languages, and spot-checks known entries.
 *
 * @version v0.6.0
 */
import { describe, it, expect } from "vitest";
import {
  COUNTRIES,
  countryByAlpha2,
  countryByAlpha3,
  countriesSortedFor,
  countryName,
} from "../../app/lib/countries";
import {
  foldForCode,
  significantWords,
  suggestRepositoryCode,
  suggestFromTypedCode,
} from "../../app/lib/repository-code";

const CO = countryByAlpha2("CO")!;
const PE = countryByAlpha2("PE")!;
const US = countryByAlpha2("US")!;

describe("suggestRepositoryCode — the house convention", () => {
  it("derives pe-bn: the country's own name is dropped (the prefix carries it)", () => {
    expect(suggestRepositoryCode("Biblioteca Nacional del Perú", PE)).toBe("pe-bn");
  });

  it("derives co-ahrb: stopwords skipped, initials of the rest", () => {
    expect(suggestRepositoryCode("Archivo Histórico Regional de Boyacá", CO)).toBe("co-ahrb");
  });

  it("derives us-sbmal: diacritics stripped, hyphenated words count as two", () => {
    expect(suggestRepositoryCode("Santa Bárbara Mission Archive-Library", US)).toBe("us-sbmal");
  });

  it("derives co-cihjmal for the CIHJML row (production hand-shortened one initial)", () => {
    expect(
      suggestRepositoryCode("Centro de Investigaciones Históricas José María Arboleda Llorente", CO),
    ).toBe("co-cihjmal");
  });

  it("returns null for a blank or stopword-only name", () => {
    expect(suggestRepositoryCode("", CO)).toBeNull();
    expect(suggestRepositoryCode("   ", CO)).toBeNull();
    expect(suggestRepositoryCode("de la y", CO)).toBeNull();
  });
});

describe("suggestFromTypedCode — a hand-typed code gets the prefix, never re-derivation", () => {
  it("prefixes a bare typed word", () => {
    expect(suggestFromTypedCode("test", US)).toBe("us-test");
  });

  it("suggests nothing when the value already carries the country prefix", () => {
    expect(suggestFromTypedCode("us-test", US)).toBeNull();
    expect(suggestFromTypedCode("US-Test", US)).toBeNull();
  });

  it("normalises the typed value like the derivation normalises words", () => {
    expect(suggestFromTypedCode("Bárbara Test", US)).toBe("us-barbaratest");
  });

  it("suggests nothing for an empty or unusable value", () => {
    expect(suggestFromTypedCode("", US)).toBeNull();
    expect(suggestFromTypedCode("   ", US)).toBeNull();
    expect(suggestFromTypedCode("---", US)).toBeNull();
  });

  it("leaves the untouched path deriving initials from the Name", () => {
    // The Name-derived suggestion is a separate function and unchanged.
    expect(suggestRepositoryCode("Santa Bárbara Mission Archive-Library", US)).toBe("us-sbmal");
  });
});

describe("significantWords / foldForCode — the derivation pieces", () => {
  it("strips diacritics only for the code", () => {
    expect(foldForCode("Bárbara")).toBe("barbara");
    expect(foldForCode("Índico")).toBe("indico");
  });

  it("skips stopwords across the four languages", () => {
    expect(significantWords("Archives of the Nation")).toEqual(["archives", "nation"]);
    expect(significantWords("Arquivo do Estado da Bahia")).toEqual([
      "arquivo",
      "estado",
      "bahia",
    ]);
    expect(significantWords("Bibliothèque du Roi")).toEqual(["bibliotheque", "roi"]);
  });

  it("splits hyphenated words into their parts", () => {
    expect(significantWords("Archive-Library")).toEqual(["archive", "library"]);
  });

  it("excludes the country's own names, diacritic-insensitively", () => {
    expect(significantWords("Biblioteca Nacional del Perú", ["Peru", "Perú"])).toEqual([
      "biblioteca",
      "nacional",
    ]);
  });
});

describe("COUNTRIES — ISO 3166-1 dataset sanity", () => {
  it("has unique, well-formed alpha-2 and alpha-3 codes and non-empty names", () => {
    const alpha2 = new Set<string>();
    const alpha3 = new Set<string>();
    for (const c of COUNTRIES) {
      expect(c.alpha2).toMatch(/^[A-Z]{2}$/);
      expect(c.alpha3).toMatch(/^[A-Z]{3}$/);
      expect(alpha2.has(c.alpha2)).toBe(false);
      expect(alpha3.has(c.alpha3)).toBe(false);
      alpha2.add(c.alpha2);
      alpha3.add(c.alpha3);
      expect(c.nameEn.length).toBeGreaterThan(0);
      expect(c.nameEs.length).toBeGreaterThan(0);
    }
    // The officially assigned ISO 3166-1 set.
    expect(COUNTRIES.length).toBeGreaterThanOrEqual(240);
  });

  it("spot-checks known entries", () => {
    expect(countryByAlpha3("COL")).toMatchObject({ alpha2: "CO", nameEn: "Colombia", nameEs: "Colombia" });
    expect(countryByAlpha3("PER")).toMatchObject({ alpha2: "PE", nameEs: "Perú" });
    expect(countryByAlpha3("USA")).toMatchObject({ alpha2: "US", nameEs: "Estados Unidos" });
    expect(countryByAlpha3("MEX")).toMatchObject({ alpha2: "MX", nameEs: "México" });
    expect(countryByAlpha3("ESP")).toMatchObject({ alpha2: "ES", nameEs: "España" });
  });

  it("fills alpha-3 from an alpha-2 pick (the countryCode auto-fill seam)", () => {
    expect(countryByAlpha2("co")!.alpha3).toBe("COL");
    expect(countryByAlpha2("PE")!.alpha3).toBe("PER");
    expect(countryByAlpha2("us")!.alpha3).toBe("USA");
    expect(countryByAlpha2("zz")).toBeNull();
  });

  it("sorts by the active locale's names", () => {
    const es = countriesSortedFor("es");
    const names = es.map((c) => countryName(c, "es"));
    const collator = new Intl.Collator("es");
    const sorted = [...names].sort((a, b) => collator.compare(a, b));
    expect(names).toEqual(sorted);
    // España sorts under E in Spanish, Spain under S in English.
    expect(countryName(es.find((c) => c.alpha2 === "ES")!, "es")).toBe("España");
  });
});

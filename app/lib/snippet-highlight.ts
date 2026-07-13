/**
 * Client-side accent-/case-insensitive match finding for the worklist
 * unfold panel's snippet highlighting and multi-match steppers.
 *
 * The server ships raw snippet text plus the anchor name(s) (spec §5,
 * "the client derives them by re-running the accent-insensitive match on
 * the delivered text"): the displayed text changes as the reader expands
 * from the window to a wide capped view to the full transcript, and
 * re-matching whatever is on screen keeps the occurrence count honest for
 * exactly that text, without the server bookkeeping match offsets across
 * three different string variants.
 *
 * `normaliseForMatch` mirrors the server's `normaliseWithMap`
 * (NFD accent-strip, lowercase, non-alphanumerics folded to a single
 * space) so the client's match count agrees with the server's snippet
 * placement, while keeping a per-character map back to the ORIGINAL string
 * for highlighting the source spelling.
 *
 * @version v0.4.3
 */

const COMBINING = /[̀-ͯ]/g;
const ALNUM = /[\p{L}\p{N}]/u;

/** Normalise `s` and record, for every emitted character, the original
 * index it came from. */
export function normaliseForMatch(s: string): { norm: string; map: number[] } {
  const norm: string[] = [];
  const map: number[] = [];
  let sepPending = false;
  let sepSrc = -1;
  for (let i = 0; i < s.length; i++) {
    const dec = s[i].normalize("NFD").replace(COMBINING, "").toLowerCase();
    if (dec.length === 0) continue; // pure combining mark — never a separator
    for (const c of dec) {
      if (ALNUM.test(c)) {
        if (sepPending && norm.length > 0) {
          norm.push(" ");
          map.push(sepSrc);
        }
        sepPending = false;
        sepSrc = -1;
        norm.push(c);
        map.push(i);
      } else if (!sepPending) {
        sepPending = true;
        sepSrc = i;
      }
    }
  }
  return { norm: norm.join(""), map };
}

export interface MatchRange {
  start: number;
  end: number;
}

/**
 * Every non-overlapping range in `text` (original-string offsets) where
 * one of `anchors` matches accent-/case-insensitively, left to right. A
 * one-character anchor is ignored (too noisy to highlight).
 */
export function findMatchRanges(text: string, anchors: string[]): MatchRange[] {
  if (!text) return [];
  const { norm, map } = normaliseForMatch(text);
  const ranges: MatchRange[] = [];
  for (const anchor of anchors) {
    const an = normaliseForMatch(anchor).norm;
    if (an.length < 2) continue;
    let i = 0;
    while ((i = norm.indexOf(an, i)) >= 0) {
      ranges.push({ start: map[i], end: map[i + an.length - 1] + 1 });
      i += 1;
    }
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  // Drop overlaps (keep the earliest of any overlapping pair) so the
  // stepper count is the number of distinct highlighted spans.
  const merged: MatchRange[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start < last.end) continue;
    merged.push(r);
  }
  return merged;
}

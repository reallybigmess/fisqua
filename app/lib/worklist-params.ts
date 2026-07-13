/**
 * Admin — linked-descriptions worklist URL state (pure helpers)
 *
 * The authority detail pages' worklist drives its search (`dq`), role
 * filter (`role`), sort (`sort`), page size (`size`), and page number
 * (`dpage`) through URL params so worklist views are shareable. These
 * helpers hold the parse/validation rules (off-menu sizes clamp to the
 * default, unknown sorts to date, page floors at 1) and the update rule
 * that changing any filter resets pagination to page one.
 *
 * @version v0.4.3
 */

export const WORKLIST_SIZES = [25, 50, 100] as const;
export const WORKLIST_DEFAULT_SIZE = 25;

export const WORKLIST_SORTS = ["date", "title", "code"] as const;
export type WorklistSort = (typeof WORKLIST_SORTS)[number];

export interface WorklistParams {
  dq: string;
  /** Raw role value — the loader validates it against the record
   * type's role enum (an off-vocabulary role is ignored, not an
   * empty result). */
  role: string | null;
  /** Raw repository id — the loader validates it against the record's
   * OWN repository ids (a foreign/absent id is ignored, not an empty
   * result), keyed by id rather than label. */
  repo: string | null;
  sort: WorklistSort;
  size: number;
  page: number;
}

export function parseWorklistParams(sp: URLSearchParams): WorklistParams {
  const dq = sp.get("dq")?.trim() || "";
  const role = sp.get("role")?.trim() || null;
  const repo = sp.get("repo")?.trim() || null;
  const rawSort = sp.get("sort");
  const sort: WorklistSort = (WORKLIST_SORTS as readonly string[]).includes(
    rawSort ?? "",
  )
    ? (rawSort as WorklistSort)
    : "date";
  const rawSize = Number(sp.get("size"));
  const size = (WORKLIST_SIZES as readonly number[]).includes(rawSize)
    ? rawSize
    : WORKLIST_DEFAULT_SIZE;
  const rawPage = Number(sp.get("dpage"));
  const page =
    Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1;
  return { dq, role, repo, sort, size, page };
}

/**
 * Return a NEW params object with one worklist control changed. Every
 * change except paging itself resets `dpage` (filters restart the
 * worklist at page one); a null/empty value removes the param.
 */
export function setWorklistParam(
  sp: URLSearchParams,
  name: "dq" | "role" | "repo" | "sort" | "size" | "dpage",
  value: string | null,
): URLSearchParams {
  const params = new URLSearchParams(sp);
  if (value) params.set(name, value);
  else params.delete(name);
  if (name !== "dpage") params.delete("dpage");
  return params;
}

/**
 * Autosave Bounded-Retry Helper
 *
 * This helper deals with running a save function under a bounded
 * number of retries with exponential backoff. It is pure and
 * framework-agnostic, and replaces two divergent failure-handling
 * patterns that previously existed in the editor codepaths:
 *
 *   - `app/lib/use-autosave.ts` (segmentation viewer): on `/api/entries/save`
 *     error, the hook used to `console.error` and dispatch
 *     `MARK_DIRTY` after 3 s, which re-triggered the same save —
 *     producing an unbounded retry loop with no UI surface.
 *   - `app/routes/_auth.description.$projectId.$entryId.tsx`
 *     (description editor): on `/api/description/save` error, the
 *     bespoke autosave used `.catch(() => setSaveStatus("unsaved"))`,
 *     which swallowed the failure into the "you have unsaved changes"
 *     pill — indistinguishable from a save that simply hadn't been
 *     attempted yet.
 *
 * Both call sites now compose the same helper. `withBoundedRetry` makes
 * at most `maxAttempts` (default 3) attempts, sleeping
 * `baseMs * 2^(attempt-1)` between them (default backoffs: 1 s, 2 s,
 * 4 s — but only the first two ever wait, because there is no backoff
 * AFTER the final failure). The result is a discriminated union:
 * `{ ok: true }` on success, `{ ok: false; error; attempts }` on
 * exhaustion. The helper deliberately does NOT throw on save failure
 * — callers can `const r = await withBoundedRetry(...)` and
 * discriminate on `r.ok` without a try/catch around the await,
 * matching the way the two autosave reducers (and the description
 * editor's `setSaveStatus`) consume the result.
 *
 * AbortSignal handling: if the signal aborts (mid-backoff or before
 * the first attempt fires) the helper resolves with
 * `{ ok: false, error: "aborted", attempts: <so-far> }` — also not a
 * throw. This keeps cleanup-on-unmount paths from generating
 * unhandled-rejection warnings in production. The decision to resolve
 * rather than reject keeps cleanup paths free of try/catch boilerplate.
 *
 * Pattern reference for fake-timer unit tests:
 * `tests/lib/format-date.test.ts` (pure-helper precedent).
 *
 * @version v0.4.1
 */

export type SaveResult =
  | { ok: true }
  | { ok: false; error: string; attempts: number };

export interface BoundedRetryOptions {
  /** Maximum number of save attempts. Defaults to 3. */
  maxAttempts?: number;
  /**
   * Base backoff in milliseconds. The wait between attempt N and N+1
   * is `baseMs * 2^(N-1)` (so with the default 1000ms and 3 attempts
   * the waits are 1000ms, 2000ms). Defaults to 1000.
   */
  baseMs?: number;
  /**
   * Optional abort signal. Aborting during a backoff (or before the
   * first attempt) settles the result as `{ ok: false, error:
   * "aborted", attempts: <so-far> }`. The helper never throws on
   * abort — callers don't need a try/catch.
   */
  signal?: AbortSignal;
}

/**
 * Run `saveFn` with bounded retry + exponential backoff. See the file
 * header for the full contract.
 */
export async function withBoundedRetry(
  saveFn: () => Promise<{ ok: boolean; error?: string }>,
  opts: BoundedRetryOptions = {},
): Promise<SaveResult> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseMs = opts.baseMs ?? 1000;
  const signal = opts.signal;

  // Short-circuit when the signal is already aborted — never call
  // saveFn in that case.
  if (signal?.aborted) {
    return { ok: false, error: "aborted", attempts: 0 };
  }

  let lastError = "unknown";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await saveFn();
      if (result.ok) return { ok: true };
      lastError = result.error ?? "unknown";
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    // After the final failure we just resolve — no backoff afterwards.
    if (attempt >= maxAttempts) break;

    const backoff = baseMs * Math.pow(2, attempt - 1);
    const aborted = await waitOrAbort(backoff, signal);
    if (aborted) {
      return { ok: false, error: "aborted", attempts: attempt };
    }
  }

  return { ok: false, error: lastError, attempts: maxAttempts };
}

/**
 * Wait `ms` milliseconds, or resolve early with `true` if the signal
 * aborts during the wait. Resolves with `false` when the timeout
 * fires normally. Never rejects — abort is in the return value.
 */
function waitOrAbort(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (signal?.aborted) {
      resolve(true);
      return;
    }

    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      resolve(true);
    }

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/* @version v0.4.1 */

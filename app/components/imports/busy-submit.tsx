/**
 * Imports — busy state for long-running submits
 *
 * The journey's slow actions (dry run, commit, the landing's file upload)
 * must show that the click DID something: while the document navigation is
 * pending, the submit button disables, swaps its label to a busy phrase,
 * and shows a small spinner.
 *
 * `isPendingIntent` is the seam: several forms post to the SAME route
 * (accept / undo / run / commit), so a button is busy only while the
 * in-flight submission carries ITS intent — matching React Router's
 * `useNavigation()` (`state` + `formData`). Any non-idle state with the
 * intent counts: `submitting` covers the action, `loading` covers the
 * redirect that follows, so the button stays busy until the next page
 * renders.
 *
 * The spinner is decorative (`aria-hidden`; the label swap is the
 * announcement) and honours `prefers-reduced-motion`: under reduced
 * motion it does not render at all — the busy label alone carries the
 * state. Disabling while pending is UI courtesy only; the server-side
 * mutexes (upload flip, run mint) remain the real double-submit guards.
 *
 * @version v0.6.0
 */

/** Whether the in-flight navigation is THIS intent's submission. */
export function isPendingIntent(
  state: string,
  formData: FormData | undefined,
  intent: string,
): boolean {
  return state !== "idle" && formData?.get("intent") === intent;
}

/** A small inline spinner; hidden entirely under reduced motion. */
export function BusySpinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3.5 w-3.5 rounded-full border-2 border-parchment/40 border-t-parchment align-[-2px] motion-safe:animate-spin motion-reduce:hidden"
    />
  );
}

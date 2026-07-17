/**
 * Imports — the four-step chain rail
 *
 * The Option C side rail (readiness-check design §2, §8a) shared by BOTH
 * pipeline surfaces: the journey page (`uploads.$uploadId`) and the imports
 * landing, whose Upload step IS the pipeline's step 1. One component, never
 * forked — the two pages must read as one visual system, so any change to
 * the step treatment lands on both at once.
 *
 * Step states: done (verdigris check), current (saffron), locked (dashed
 * grey, its sub-line naming the unlock condition). A step with an `href`
 * renders as a link (the journey's viewable steps); without one it is a
 * static row (locked steps, and every step on the landing). On narrow
 * viewports the CALLER's grid collapses the rail above the pane — the rail
 * itself is layout-agnostic.
 *
 * `MiniRail` is the landing's per-row miniature: four dots carrying the
 * same done/current/locked encoding, `aria-hidden` because the row's state
 * line says the same thing in words.
 *
 * Both components are i18n-agnostic: callers pass resolved strings.
 *
 * @version v0.6.0
 */

import { Link } from "react-router";

export type RailStepState = "done" | "current" | "locked";

export interface RailStep {
  id: string;
  /** 1-based step number, shown while the step is not done. */
  number: number;
  state: RailStepState;
  name: string;
  sub: string;
  /** Link target when the step is navigable; static row otherwise. */
  href?: string;
  /** Marks the step the pane currently shows (aria-current + underline). */
  active?: boolean;
}

const NUM: Record<RailStepState, string> = {
  done: "bg-verdigris text-parchment",
  current: "bg-saffron text-parchment",
  locked: "border border-dashed border-stone-300 text-stone-400",
};

export function StepRail({ label, steps }: { label: string; steps: RailStep[] }) {
  return (
    <nav aria-label={label} className="flex flex-col gap-0">
      {steps.map((step) => {
        const inner = (
          <div className="flex gap-3 pb-6">
            <span
              className={`flex h-6 w-6 flex-none items-center justify-center rounded-full font-mono text-xs ${NUM[step.state]}`}
              aria-hidden="true"
            >
              {step.state === "done" ? "✓" : step.number}
            </span>
            <div className="min-w-0">
              <div
                className={`text-sm font-semibold ${
                  step.state === "locked" ? "text-stone-400" : "text-stone-700"
                } ${step.active ? "underline decoration-saffron decoration-2 underline-offset-4" : ""}`}
              >
                {step.name}
              </div>
              <div className="text-xs text-stone-500">{step.sub}</div>
            </div>
          </div>
        );
        return step.href ? (
          <Link
            key={step.id}
            to={step.href}
            aria-current={step.active ? "step" : undefined}
            className="block rounded hover:bg-stone-50"
          >
            {inner}
          </Link>
        ) : (
          <div
            key={step.id}
            aria-current={step.active ? "step" : undefined}
            aria-disabled={step.state === "locked" ? "true" : undefined}
          >
            {inner}
          </div>
        );
      })}
    </nav>
  );
}

const DOT: Record<RailStepState, string> = {
  done: "bg-verdigris",
  current: "bg-saffron",
  locked: "bg-stone-200",
};

/** The landing rows' miniature rail: four state dots, decorative only. */
export function MiniRail({ states }: { states: RailStepState[] }) {
  return (
    <span className="flex items-center gap-1" aria-hidden="true">
      {states.map((state, i) => (
        <i key={i} className={`h-2 w-2 rounded-full ${DOT[state]}`} />
      ))}
    </span>
  );
}

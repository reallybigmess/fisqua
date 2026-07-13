/**
 * App Footer
 *
 * This component is the floating attribution at the bottom of the
 * authenticated shell. The version link sits at the bottom-left, the
 * partner logos at the bottom-right, both pinned to the content slot's
 * corners so page content scrolls underneath without a footer bar
 * reserving its own row of vertical space. The pointer-events-none wrapper
 * keeps the gap between the two clusters click-through so users can still
 * interact with anything below.
 *
 * @version v0.5.0
 */

const VERSION = "0.5.0";

export function Footer() {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between px-4 py-3">
      <p className="pointer-events-auto text-xs text-stone-400">
        <a
          href={`https://github.com/UCSB-AMPLab/fisqua/releases/tag/v${VERSION}`}
          className="text-stone-400 hover:text-stone-600"
        >
          Fisqua v{VERSION}
        </a>
      </p>
      <div className="pointer-events-auto flex items-center gap-3">
        <img
          src="/brand/neogranadina-logo.svg"
          alt="Neogranadina"
          className="h-auto w-10 opacity-40"
        />
        <img
          src="/ampl-cropped-1.png"
          alt="AMP Lab, UC Santa Barbara"
          className="h-auto w-10 opacity-40"
        />
      </div>
    </div>
  );
}

/**
 * Landing brand mark + parchment plate
 *
 * This module deals with two presentational helpers used only by the apex
 * landing (`app/routes/_index.tsx`):
 *
 *   - `FisquaMark` renders the pomegranate-tree mark from
 *     `/brand/fisqua-mark.svg` as a CSS mask so it can be tinted to
 *     any colour token. The SVG ships with a `fill="#000000"` mark
 *     on transparency — masking it lets us recolour it to
 *     `--verdigris-deep` (default) or any other brand colour without
 *     shipping multiple SVG copies.
 *   - `ParchmentPlate` is the right-hand 4:5 aspect parchment card
 *     that anchors the desktop hero. It carries a quietly oversized
 *     mark centred on a parchment surface bordered with
 *     `--parchment-deep`. Hidden on narrow viewports — the mobile
 *     composition omits the plate so the picker dominates.
 *
 * @version v0.4.0
 */

type FisquaMarkProps = {
  /** CSS length, e.g. "32px", "78%". Sets both width and height. */
  size: string;
  /** CSS color token, defaults to verdigris-deep. */
  color?: string;
  className?: string;
};

export function FisquaMark({
  size,
  color = "var(--verdigris-deep)",
  className,
}: FisquaMarkProps) {
  return (
    <span
      aria-hidden="true"
      className={className}
      style={{
        display: "inline-block",
        width: size,
        height: size,
        backgroundColor: color,
        WebkitMaskImage: "url('/brand/fisqua-mark.svg')",
        maskImage: "url('/brand/fisqua-mark.svg')",
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskSize: "contain",
        maskSize: "contain",
        WebkitMaskPosition: "center",
        maskPosition: "center",
      }}
    />
  );
}

export function ParchmentPlate() {
  return (
    <aside
      aria-hidden="true"
      className="hidden md:flex items-center justify-center bg-parchment border border-parchment-deep rounded-lg overflow-hidden p-6"
      style={{ aspectRatio: "4 / 5" }}
    >
      <FisquaMark size="78%" color="var(--verdigris-deep)" />
    </aside>
  );
}

// @version v0.4.0

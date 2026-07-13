/**
 * Viewer Drag Overlay
 *
 * This component is the ghost overlay shown while the cataloguer drags an
 * entry boundary to a new page. Rendered in a React portal so its geometry
 * is independent of the scrolling viewer below.
 *
 * @version v0.4.2
 */
type DragOverlayProps = {
  visible: boolean;
  top: number;
  width: number;
  isInvalid: boolean;
};

/**
 * Ghost line shown during boundary drag operations.
 * Semi-transparent teal marker at the target position (50% opacity).
 * Turns red when hovering over an invalid drop position.
 */
export function DragOverlay({ visible, top, width, isInvalid }: DragOverlayProps) {
  if (!visible) return null;

  return (
 <div
 style={{
 position: "absolute",
 top: top - 2,
 left: 0,
 width,
 height: 20,
 zIndex: 25,
 pointerEvents: "none",
 opacity: 0.5,
 }}
 >
 {/* Ghost sequence badge */}
 <div
 className={`absolute left-2 top-1/2 z-30 flex -translate-y-1/2 items-center justify-center rounded-full px-2 py-0.5 text-10 font-semibold text-white shadow-sm ${
 isInvalid ? "bg-madder" : "bg-teal-600"
 }`}
 >
 &bull;
 </div>

 {/* Ghost horizontal line */}
 <div
 className={`absolute left-16 right-0 top-1/2 -translate-y-1/2 border-t-[3px] ${
 isInvalid ? "border-madder" : "border-teal-500"
 }`}
 />
 </div>
  );
}

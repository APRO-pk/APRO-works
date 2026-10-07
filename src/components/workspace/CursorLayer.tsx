/**
 * Other people's pointers.
 *
 * Rendering them is the part of collaboration that has to feel right, so this
 * component does something unusual for this codebase: it never re-renders for a
 * cursor. React draws one absolutely-positioned element per remote peer and then
 * gets out of the way. A single `requestAnimationFrame` loop reads target
 * positions straight out of the presence client's map and writes `transform` on
 * the DOM nodes directly.
 *
 * The alternative — position in state — would re-render the workspace panel on
 * every frame of someone else's mouse, and the re-render would be the visible
 * lag, not the network. Nothing here is clever: it is the ordinary technique for
 * animation, applied to something that is not normally animated.
 *
 * The loop never stops while the layer is mounted. A frame that does nothing
 * costs a fraction of a millisecond, and starting and stopping the loop on every
 * cursor arrival would reintroduce exactly the latency this avoids.
 *
 * Pointing at a pointer reveals whose it is, and that is a CSS hover on these
 * same nodes rather than React state — identifying somebody is precisely the kind
 * of interaction that would otherwise undo the above.
 */

import { useEffect, useRef } from "react";

import { CURSOR_EPSILON, CURSOR_TAU_MS, type CursorTarget } from "../../lib/presence";
import { cursorColor, type Peer } from "../../lib/workspace-protocol";

export type CursorLayerProps = {
  /** Remote peers. The caller is never in this list. */
  peers: Peer[];
  /** Live targets, read on every frame. Mutated in place by the presence client. */
  targets: ReadonlyMap<string, CursorTarget>;
  /**
   * Whether pointers should be drawn at all — false while the window is
   * unfocused, or while presence is not live. A stale pointer from a background
   * window claims someone is somewhere they are not.
   */
  active: boolean;
};

/** A frame longer than this is treated as this long, so a stall cannot teleport. */
const MAX_FRAME_MS = 64;

export function CursorLayer({ peers, targets, active }: CursorLayerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  /** Peer id → its element. Populated by the ref callbacks in the JSX below. */
  const nodes = useRef(new Map<string, HTMLDivElement>());
  /** Peer id → where that cursor is currently drawn. */
  const drawn = useRef(new Map<string, CursorTarget>());
  /** The layer's own size, the pixel space the normalised coordinates map onto. */
  const size = useRef({ width: 0, height: 0 });

  // Measuring on every frame would force a layout each time. The layer only
  // changes size when the window does, so watch for that instead.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const measure = () => {
      const rect = host.getBoundingClientRect();
      size.current = { width: rect.width, height: rect.height };
    };

    measure();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // Honour the system preference, the same way `index.css` does for CSS
    // animation. Someone who asked for less movement should get pointers that
    // land where they are, not pointers that glide.
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let frame = 0;
    let last = performance.now();

    const step = (now: number) => {
      frame = requestAnimationFrame(step);

      const delta = Math.min(MAX_FRAME_MS, Math.max(0, now - last));
      last = now;

      // Exponential smoothing, so the result does not depend on frame rate:
      // 1 - exp(-dt/tau) is the exact fraction of the remaining distance that
      // one frame of constant-dt smoothing would cover. At 60 Hz with tau = 70 ms
      // this is ~0.21 per frame.
      const k = reduceMotion ? 1 : 1 - Math.exp(-delta / CURSOR_TAU_MS);

      // Forget cursors for peers who are no longer drawn, so the map does not
      // grow across a long session and a rejoin starts from a clean position.
      if (drawn.current.size > nodes.current.size) {
        for (const id of Array.from(drawn.current.keys())) {
          if (!nodes.current.has(id)) drawn.current.delete(id);
        }
      }

      for (const [id, node] of nodes.current) {
        const target = targets.get(id);

        if (!target || !active) {
          // Not "hide forever": a peer who has not moved yet simply has no known
          // position, and appearing at the origin would be a lie. So they stay
          // invisible until they tell us where they are.
          node.style.opacity = "0";
          continue;
        }

        const current = drawn.current.get(id);

        if (!current) {
          // First sighting: appear where they actually are rather than sliding
          // in from wherever the previous occupant of this slot happened to be.
          drawn.current.set(id, { x: target.x, y: target.y });
        } else {
          current.x += (target.x - current.x) * k;
          current.y += (target.y - current.y) * k;

          // Snap the last fraction of a pixel. Without this the loop never
          // settles and keeps writing a transform that changes in the third
          // decimal place.
          if (
            Math.abs(target.x - current.x) < CURSOR_EPSILON &&
            Math.abs(target.y - current.y) < CURSOR_EPSILON
          ) {
            current.x = target.x;
            current.y = target.y;
          }
        }

        const position = drawn.current.get(id)!;
        node.style.opacity = "1";
        node.style.transform = `translate3d(${position.x * size.current.width}px, ${
          position.y * size.current.height
        }px, 0)`;
      }
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [targets, active]);

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      className="cursor-layer pointer-events-none absolute inset-0 z-20 overflow-hidden"
    >
      {peers.map((peer) => {
        const tint = cursorColor(peer.color);
        // The roster is the authority on names. This is the same value the room
        // relayed, falling back to the address when nobody ever set one.
        const label = peer.full_name || peer.email;
        return (
          <div
            key={peer.id}
            ref={(node) => {
              if (node) nodes.current.set(peer.id, node);
              else nodes.current.delete(peer.id);
            }}
            className="cursor-mark"
            style={{ color: tint }}
          >
            <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true">
              <path
                d="M1.5 1.2 L1.5 15.1 L5.3 11.4 L8 16.9 L10.4 15.8 L7.7 10.4 L12.8 10.4 Z"
                fill="currentColor"
                stroke="var(--color-canvas)"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
            </svg>
            {/* Painted inline rather than tinted with `currentColor`, which would
                resolve against this element's own text colour. */}
            <span className="cursor-chip" style={{ background: tint }}>
              {label}
            </span>
            {/* Always present, faded in by CSS on hover — identifying somebody
                must not cost a render, and the layer never re-renders for a
                cursor. Redundant with the roster beside the workspace, so it is
                inside the `aria-hidden` layer along with the rest of the paint. */}
            <span className="cursor-detail">
              <span className="text-[11px] font-semibold text-ink">{label}</span>
              <span className="text-[10px] text-ink-dim">
                {peer.full_name && peer.email ? `${peer.role} · ${peer.email}` : peer.role}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

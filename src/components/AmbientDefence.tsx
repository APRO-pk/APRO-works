/**
 * Ambient launch drill for the sign-in screen.
 *
 * An automated little scene that runs behind the sign-in card: two to four intruders
 * cross the screen, entering from either edge at whatever speed they were given, a hatch
 * at the bottom of the window slides open, a missile rises out of it after a random wait,
 * hunts one intruder down, detonates against its hull, and the launcher arms another for
 * whatever is still out there. It repeats on a random interval.
 *
 * Ground rules, because this is decoration on a screen somebody is trying to use:
 *
 *  * `prefers-reduced-motion` removes it entirely rather than shortening it. The
 *    setting means "stop", not "go faster".
 *  * It stops when the document is hidden, so a minimised window costs nothing.
 *  * It draws in tokens read from the stylesheet, so it follows the accent.
 *  * Particles are capped, so the work per frame is bounded no matter what happens.
 *  * `aria-hidden` and `pointer-events: none`, so it can neither intercept a click nor
 *    reach a screen reader.
 *
 * Colours are accent and ink only. Variety comes from motion, size, direction and alpha
 * rather than from more hues — the rest of the application reserves colour for meaning,
 * and a background decoration is not a good place to break that.
 */

import { useEffect, useRef } from "react";

type Vec = { x: number; y: number };

type Palette = {
  accent: string;
  ink: string;
  inkDim: string;
  inkFaint: string;
};

/** Read a design token. Custom properties come back as written, not as a canvas colour. */
function readToken(name: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.length > 0 ? value : "transparent";
}

function readPalette(): Palette {
  return {
    accent: readToken("--color-accent"),
    ink: readToken("--color-ink"),
    inkDim: readToken("--color-ink-dim"),
    inkFaint: readToken("--color-ink-faint"),
  };
}

type Intruder = {
  pos: Vec;
  vel: Vec;
  size: number;
  wobbleAmp: number;
  wobbleHz: number;
  phase: number;
  spin: number;
  spinRate: number;
  alive: boolean;
  /** Seconds since death; the wreck spins and fades out over this. */
  sinceDeath: number;
};

type Particle = {
  pos: Vec;
  vel: Vec;
  life: number;
  max: number;
  size: number;
  drag: number;
  /** `ring` expands instead of moving; `spark` shrinks; `smoke` drifts and grows. */
  kind: "spark" | "smoke" | "ring";
  alpha: number;
};

/**
 * A single-use munition. It has no gun: the warhead is the weapon, so a missile is
 * spent the moment it touches a hull.
 */
type Missile = {
  pos: Vec;
  vel: Vec;
  angle: number;
  /** Seconds in the air; a missile that cannot find anything is a dud. */
  life: number;
  /**
   * The intruder this missile has decided to kill.
   *
   * A reference, not an index: wrecks and escapees are culled from the array, and an
   * index would quietly start pointing at a different intruder the moment anything
   * ahead of it was removed.
   */
  target: Intruder | null;
};

type Phase = "idle" | "open" | "hunt" | "close";

const MAX_PARTICLES = 340;

/** How many missiles may be in the air at once, so a wave is not one long queue. */
const MAX_MISSILES = 2;
/** The wait between launches. This is the randomness the drill is built on. */
const MISSILE_INTERVAL_MIN = 0.35;
const MISSILE_INTERVAL_MAX = 1.5;
/** How close a missile has to come to a hull before the warhead goes off. */
const MISSILE_RADIUS = 7;
const MISSILE_MAX_SPEED = 400;
const MISSILE_THRUST = 900;
/** A missile that has been in the air this long is a dud and goes off where it is. */
const MISSILE_LIFETIME = 8;

const TAU = Math.PI * 2;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

/** Shortest signed angle from `a` to `b`. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/**
 * Shortest distance from `p` to the segment `a`→`b`.
 *
 * A missile covers up to ~20px between frames while the smallest hull is 11px across,
 * so testing only where the missile ended up lets it pass clean through a target it
 * plainly hit. Sweeping the frame's travel catches that.
 */
function distToSegment(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-6) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * `roundRect` is Chromium 99+. WebView2 is evergreen so it will be there, but an
 * absent method would throw on every frame and take the whole scene down, which is a
 * bad trade for a slightly softer corner on a decorative lid.
 */
function roundedRect(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  if (typeof c.roundRect === "function") c.roundRect(x, y, w, h, r);
  else c.rect(x, y, w, h);
}

export function AmbientDefence({ className = "" }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Decoration only: if motion is unwelcome, do not render a frame of it.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let palette = readPalette();
    let width = 0;
    let height = 0;

    let phase: Phase = "idle";
    // The first drill comes quickly so the screen is not dead on arrival; later ones
    // honour the long random gap.
    let waitFor = rand(2.5, 4.5);
    let timer = 0;
    let lid = 0;
    let shake = 0;
    let huntClock = 0;
    /** Counts down to the next launch; only the launcher cares about it. */
    let launchTimer = 0;

    const intruders: Intruder[] = [];
    const missiles: Missile[] = [];
    const particles: Particle[] = [];

    function resize() {
      const rect = canvas!.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas!.width = Math.max(1, Math.round(rect.width * dpr));
      canvas!.height = Math.max(1, Math.round(rect.height * dpr));
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      width = rect.width;
      height = rect.height;
    }

    const hatchX = () => width / 2;
    const hatchY = () => height - 26;

    function addParticle(p: Particle) {
      if (particles.length >= MAX_PARTICLES) particles.shift();
      particles.push(p);
    }

    function burst(at: Vec, strength: number) {
      const sparks = Math.round(14 + strength * 10);
      for (let i = 0; i < sparks; i += 1) {
        const a = rand(0, TAU);
        const speed = rand(40, 210) * strength;
        addParticle({
          pos: { x: at.x, y: at.y },
          vel: { x: Math.cos(a) * speed, y: Math.sin(a) * speed },
          life: rand(0.3, 0.85),
          max: 0.85,
          size: rand(0.9, 2.4),
          drag: 2.4,
          kind: "spark",
          alpha: 1,
        });
      }
      for (let i = 0; i < 7; i += 1) {
        const a = rand(0, TAU);
        addParticle({
          pos: { x: at.x, y: at.y },
          vel: { x: Math.cos(a) * rand(8, 46), y: Math.sin(a) * rand(8, 46) },
          life: rand(0.6, 1.4),
          max: 1.4,
          size: rand(5, 13),
          drag: 1.1,
          kind: "smoke",
          alpha: 0.4,
        });
      }
      addParticle({
        pos: { x: at.x, y: at.y },
        vel: { x: 0, y: 0 },
        life: 0.42,
        max: 0.42,
        size: 6,
        drag: 0,
        kind: "ring",
        alpha: 0.85,
      });
      shake = Math.min(1, shake + 0.55 * strength);
    }

    /** Kill a hull, leaving a wreck for the culler to retire. */
    function wreck(n: Intruder) {
      n.alive = false;
      n.sinceDeath = 0;
      n.vel.x *= 0.3;
      n.vel.y *= 0.3;
      n.spinRate = rand(-9, 9);
    }

    function spawnWave() {
      // Several at once, so the screen reads as a raid rather than a duel.
      const count = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < count; i += 1) {
        // Half come in from the left. The hatch does not care which side it fires at,
        // and a scene where everything arrives from one edge looks staged.
        const fromLeft = Math.random() < 0.5;
        const speed = rand(22, 76);
        intruders.push({
          pos: {
            x: fromLeft ? -40 - i * rand(70, 150) : width + 40 + i * rand(70, 150),
            y: rand(height * 0.08, height * 0.36),
          },
          vel: { x: fromLeft ? speed : -speed, y: rand(-5, 7) },
          size: rand(11, 19),
          wobbleAmp: rand(8, 30),
          wobbleHz: rand(0.25, 0.6),
          phase: rand(0, TAU),
          spin: rand(0, TAU),
          spinRate: rand(-0.5, 0.5),
          alive: true,
          sinceDeath: 0,
        });
      }
    }

    function launchMissile(target: Intruder) {
      missiles.push({
        // Nudged up out of the bay, so a launch reads as leaving the hatch rather than
        // appearing beside it.
        pos: { x: hatchX(), y: hatchY() + 2 },
        vel: { x: 0, y: -150 },
        angle: -Math.PI / 2,
        life: 0,
        target,
      });
    }

    // ---------------------------------------------------------------- update

    function update(dt: number) {
      // Lid travel.
      if (phase === "open") lid = Math.min(1, lid + dt / 0.55);
      if (phase === "close") lid = Math.max(0, lid - dt / 0.5);

      if (phase === "idle") {
        timer += dt;
        if (timer >= waitFor) {
          timer = 0;
          spawnWave();
          phase = "open";
          palette = readPalette();
        }
      }

      if (phase === "open" && lid >= 1) {
        phase = "hunt";
        huntClock = 0;
        // The first missile goes almost at once, so the drill answers the raid rather
        // than waiting on the cadence before doing anything.
        launchTimer = rand(0.15, 0.5);
      }

      // Intruders drift, wobble, and tumble once dead.
      for (const n of intruders) {
        if (n.alive) {
          n.phase += dt * n.wobbleHz * TAU;
          n.pos.x += n.vel.x * dt;
          n.pos.y += n.vel.y * dt + Math.cos(n.phase) * n.wobbleAmp * dt;
          n.spin += n.spinRate * dt;
        } else {
          n.sinceDeath += dt;
          n.pos.x += n.vel.x * dt * 0.4;
          n.pos.y += n.vel.y * dt * 0.4 + 26 * dt;
          n.spin += n.spinRate * dt * 3.5;
        }
      }

      if (phase === "hunt") {
        huntClock += dt;
        const live = intruders.filter((n) => n.alive);

        if (live.length === 0 && missiles.length === 0 && huntClock > 0.5) {
          phase = "close";
        } else if (huntClock > 30) {
          // Safety valve. Missiles are quick and single-use, so a raid should always
          // resolve, but a stuck scene must not leave the lid open forever.
          phase = "close";
        } else {
          launchTimer -= dt;
          if (launchTimer <= 0 && live.length > 0 && missiles.length < MAX_MISSILES) {
            // "Randomly tracks": a missile commits to one intruder until it is gone,
            // rather than every launch taking the nearest.
            launchMissile(live[Math.floor(Math.random() * live.length)]);
            launchTimer = rand(MISSILE_INTERVAL_MIN, MISSILE_INTERVAL_MAX);
          }
        }
      }

      // Missiles.
      for (let i = missiles.length - 1; i >= 0; i -= 1) {
        const m = missiles[i];
        m.life += dt;

        // A target can be taken by the other missile, so re-acquire rather than chase a
        // wreck.
        if (m.target === null || !m.target.alive) {
          const live = intruders.filter((n) => n.alive);
          m.target = live.length > 0 ? live[Math.floor(Math.random() * live.length)] : null;
        }

        const target = m.target;
        if (!target || m.life > MISSILE_LIFETIME) {
          // Nothing left to kill, or a dud. A single-use munition goes off where it is;
          // there is no flight home to draw.
          burst({ x: m.pos.x, y: m.pos.y }, 0.45);
          missiles.splice(i, 1);
          continue;
        }

        const dx = target.pos.x - m.pos.x;
        const dy = target.pos.y - m.pos.y;
        const desired = Math.atan2(dy, dx);

        // Turn rate is limited, so the missile arcs instead of snapping, but it is
        // tighter than a piloted craft because it has no hovering to do.
        m.angle += clamp(angleDelta(m.angle, desired), -6 * dt, 6 * dt);
        m.vel.x += Math.cos(m.angle) * MISSILE_THRUST * dt;
        m.vel.y += Math.sin(m.angle) * MISSILE_THRUST * dt;

        const speed = Math.hypot(m.vel.x, m.vel.y);
        if (speed > MISSILE_MAX_SPEED) {
          m.vel.x = (m.vel.x / speed) * MISSILE_MAX_SPEED;
          m.vel.y = (m.vel.y / speed) * MISSILE_MAX_SPEED;
        }

        const from: Vec = { x: m.pos.x, y: m.pos.y };
        m.pos.x += m.vel.x * dt;
        m.pos.y += m.vel.y * dt;

        if (distToSegment(target.pos, from, m.pos) < target.size + MISSILE_RADIUS) {
          wreck(target);
          burst({ x: m.pos.x, y: m.pos.y }, 1.15);
          missiles.splice(i, 1);
          continue;
        }

        // Exhaust trail, heavier under thrust.
        if (Math.random() < 0.9) {
          const back = m.angle + Math.PI + rand(-0.28, 0.28);
          addParticle({
            pos: {
              x: m.pos.x + Math.cos(back) * 8,
              y: m.pos.y + Math.sin(back) * 8,
            },
            vel: {
              x: Math.cos(back) * rand(16, 54) - m.vel.x * 0.12,
              y: Math.sin(back) * rand(16, 54) - m.vel.y * 0.12,
            },
            life: rand(0.2, 0.5),
            max: 0.5,
            size: rand(1.2, 3),
            drag: 2.6,
            kind: "spark",
            alpha: 0.8,
          });
        }
      }

      if (phase === "close" && lid <= 0) {
        phase = "idle";
        timer = 0;
        waitFor = rand(20, 40);
        intruders.length = 0;
        missiles.length = 0;
      }

      // Cull: wrecks that have finished fading, and intruders that crossed the screen
      // and got away. Both edges, because they come from both.
      for (let i = intruders.length - 1; i >= 0; i -= 1) {
        const n = intruders[i];
        const gone = n.alive
          ? n.pos.x < -70 || n.pos.x > width + 70
          : n.sinceDeath > 0.9;
        if (!gone) continue;
        for (const m of missiles) if (m.target === n) m.target = null;
        intruders.splice(i, 1);
      }

      // Particles.
      for (let i = particles.length - 1; i >= 0; i -= 1) {
        const p = particles[i];
        p.life -= dt;
        if (p.life <= 0) {
          particles.splice(i, 1);
          continue;
        }
        if (p.kind === "ring") continue;
        const damp = Math.max(0, 1 - p.drag * dt);
        p.vel.x *= damp;
        p.vel.y *= damp;
        if (p.kind === "smoke") p.vel.y -= 8 * dt;
        p.pos.x += p.vel.x * dt;
        p.pos.y += p.vel.y * dt;
      }

      shake = Math.max(0, shake - dt * 5.5);
    }

    // ---------------------------------------------------------------- draw

    function drawIntruder(n: Intruder, t: number) {
      const fade = n.alive ? 1 : Math.max(0, 1 - n.sinceDeath / 0.7);
      if (fade <= 0) return;

      ctx!.save();
      ctx!.translate(n.pos.x, n.pos.y);
      ctx!.rotate(n.spin);
      // Face the way it is travelling. The shape's nose points along +x, so a hull
      // entering from the right would otherwise read as being dragged backwards.
      if (n.vel.x < 0) ctx!.scale(-1, 1);
      ctx!.globalAlpha = (n.alive ? 0.5 : 0.35) * fade;

      ctx!.beginPath();
      ctx!.moveTo(n.size, 0);
      ctx!.lineTo(-n.size * 0.72, n.size * 0.78);
      ctx!.lineTo(-n.size * 0.36, 0);
      ctx!.lineTo(-n.size * 0.72, -n.size * 0.78);
      ctx!.closePath();
      ctx!.strokeStyle = palette.inkFaint;
      ctx!.lineWidth = 1.2;
      ctx!.stroke();
      ctx!.fillStyle = palette.inkFaint;
      ctx!.globalAlpha = (n.alive ? 0.13 : 0.07) * fade;
      ctx!.fill();

      // A dim core that pulses, so a live intruder reads as active.
      if (n.alive) {
        ctx!.globalAlpha = 0.32 + 0.24 * Math.sin(t * 4 + n.phase);
        ctx!.beginPath();
        ctx!.arc(0, 0, n.size * 0.2, 0, TAU);
        ctx!.fillStyle = palette.ink;
        ctx!.fill();
      }
      ctx!.restore();
    }

    function drawParticle(p: Particle) {
      const k = p.life / p.max;
      ctx!.save();
      if (p.kind === "ring") {
        ctx!.globalAlpha = k * p.alpha;
        ctx!.strokeStyle = palette.ink;
        ctx!.lineWidth = 1.6 * k;
        ctx!.beginPath();
        ctx!.arc(p.pos.x, p.pos.y, p.size + (1 - k) * 34, 0, TAU);
        ctx!.stroke();
      } else if (p.kind === "smoke") {
        ctx!.globalAlpha = k * p.alpha;
        ctx!.fillStyle = palette.inkFaint;
        ctx!.beginPath();
        ctx!.arc(p.pos.x, p.pos.y, p.size * (1.5 - k * 0.5), 0, TAU);
        ctx!.fill();
      } else {
        ctx!.globalAlpha = k * p.alpha;
        ctx!.fillStyle = palette.accent;
        ctx!.beginPath();
        ctx!.arc(p.pos.x, p.pos.y, p.size * k, 0, TAU);
        ctx!.fill();
      }
      ctx!.restore();
    }

    /** The missile: a slim tube with a pointed nose and tail fins, nose-first. */
    function drawMissile(m: Missile) {
      ctx!.save();
      ctx!.translate(m.pos.x, m.pos.y);
      ctx!.rotate(m.angle);

      const L = 18;
      const W = 7;

      // Flame first, so it burns behind the body rather than over it.
      const speed = Math.hypot(m.vel.x, m.vel.y);
      const burn = clamp(speed / MISSILE_MAX_SPEED, 0.3, 1);
      ctx!.fillStyle = palette.accent;
      for (let i = 0; i < 2; i += 1) {
        const len = (12 + i * 8) * burn * rand(0.75, 1.15);
        const half = W * 0.38 * (1 - i * 0.4);
        ctx!.beginPath();
        ctx!.moveTo(-L * 0.5, -half);
        ctx!.lineTo(-L * 0.5 - len, 0);
        ctx!.lineTo(-L * 0.5, half);
        ctx!.closePath();
        ctx!.globalAlpha = i === 0 ? 0.85 : 0.4;
        ctx!.fill();
      }

      ctx!.globalAlpha = 0.95;
      ctx!.fillStyle = palette.accent;

      // Body.
      ctx!.beginPath();
      ctx!.rect(-L * 0.5, -W / 2, L * 0.72, W);
      ctx!.fill();

      // Nose.
      ctx!.beginPath();
      ctx!.moveTo(L * 0.22, -W / 2);
      ctx!.lineTo(L * 0.55, 0);
      ctx!.lineTo(L * 0.22, W / 2);
      ctx!.closePath();
      ctx!.fill();

      // Tail fins, which is what separates the silhouette from the old rocket.
      ctx!.beginPath();
      ctx!.moveTo(-L * 0.5, -W / 2);
      ctx!.lineTo(-L * 0.62, -W * 1.05);
      ctx!.lineTo(-L * 0.28, -W / 2);
      ctx!.closePath();
      ctx!.moveTo(-L * 0.5, W / 2);
      ctx!.lineTo(-L * 0.62, W * 1.05);
      ctx!.lineTo(-L * 0.28, W / 2);
      ctx!.closePath();
      ctx!.fill();

      // A bright spine so the silhouette reads against the background.
      ctx!.globalAlpha = 0.5;
      ctx!.strokeStyle = palette.ink;
      ctx!.lineWidth = 0.9;
      ctx!.beginPath();
      ctx!.moveTo(-L * 0.44, 0);
      ctx!.lineTo(L * 0.36, 0);
      ctx!.stroke();

      ctx!.restore();
    }

    function drawHatch(t: number) {
      const cx = hatchX();
      const cy = hatchY();
      const w = 104;
      const h = 7;

      ctx!.save();

      // The bay. Warmer and brighter as the lid opens.
      ctx!.globalAlpha = 0.16 + lid * 0.3;
      ctx!.fillStyle = palette.accent;
      ctx!.beginPath();
      roundedRect(ctx!, cx - w / 2 - 4, cy - h / 2 - 2, w + 8, h + 4, 4);
      ctx!.fill();

      ctx!.globalAlpha = 0.5 + 0.2 * Math.sin(t * 1.6);
      ctx!.strokeStyle = palette.inkFaint;
      ctx!.lineWidth = 1;
      ctx!.beginPath();
      ctx!.moveTo(cx - w / 2 - 12, cy + h / 2 + 3);
      ctx!.lineTo(cx + w / 2 + 12, cy + h / 2 + 3);
      ctx!.stroke();

      // The lid, sliding clear like a bay door.
      const slide = lid * (w + 6);
      ctx!.globalAlpha = 0.9;
      ctx!.fillStyle = palette.inkDim;
      ctx!.beginPath();
      roundedRect(ctx!, cx - w / 2 + slide, cy - h / 2, w, h, 3);
      ctx!.fill();

      ctx!.globalAlpha = 0.5;
      ctx!.fillStyle = palette.ink;
      ctx!.beginPath();
      roundedRect(ctx!, cx - w / 2 + slide, cy - h / 2, w, 1.4, 1);
      ctx!.fill();

      ctx!.restore();
    }

    // ---------------------------------------------------------------- loop

    let raf = 0;
    let last = 0;

    function frame(now: number) {
      raf = window.requestAnimationFrame(frame);

      if (width < 2 || height < 2) {
        resize();
        return;
      }

      const dt = Math.min(0.05, last === 0 ? 0.016 : (now - last) / 1000);
      last = now;
      const t = now / 1000;

      update(dt);

      ctx!.clearRect(0, 0, width, height);
      ctx!.save();
      if (shake > 0.01) {
        // A short, small recoil. Enough to feel the hit, not enough to be a problem.
        const s = shake * shake * 3.2;
        ctx!.translate(rand(-s, s), rand(-s, s));
      }

      for (const n of intruders) drawIntruder(n, t);
      for (const m of missiles) drawMissile(m);
      for (const p of particles) drawParticle(p);
      drawHatch(t);

      ctx!.restore();
    }

    let paused = false;
    function onVisibility() {
      if (document.hidden) {
        paused = true;
        window.cancelAnimationFrame(raf);
      } else if (paused) {
        paused = false;
        last = 0;
        raf = window.requestAnimationFrame(frame);
      }
    }

    const observer = new ResizeObserver(() => resize());
    observer.observe(canvas);
    resize();
    raf = window.requestAnimationFrame(frame);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.cancelAnimationFrame(raf);
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={`pointer-events-none ${className}`}
    />
  );
}

/**
 * Ambient launch drill for the sign-in screen.
 *
 * An automated little scene that runs behind the sign-in card: an intruder drifts in
 * from the right, a hatch at the bottom of the window slides open, a rocket rises out
 * of it, hunts the intruder down, and goes home. It repeats on a random interval.
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
 * Colours are accent and ink only. Variety comes from motion, size and alpha rather
 * than from more hues — the rest of the application reserves colour for meaning, and
 * a background decoration is not a good place to break that.
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

type Bullet = { pos: Vec; vel: Vec; life: number };

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

type Rocket = {
  pos: Vec;
  vel: Vec;
  angle: number;
  cooldown: number;
  /**
   * The intruder this rocket has decided to kill.
   *
   * A reference, not an index: wrecks and escapees are culled from the array, and an
   * index would quietly start pointing at a different intruder the moment anything
   * ahead of it was removed.
   */
  target: Intruder | null;
};

type Phase = "idle" | "open" | "hunt" | "return" | "close";

const MAX_PARTICLES = 340;

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

    const intruders: Intruder[] = [];
    const bullets: Bullet[] = [];
    const particles: Particle[] = [];
    let rocket: Rocket | null = null;

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

    function spawnWave() {
      const count = Math.random() < 0.34 ? 2 : 1;
      for (let i = 0; i < count; i += 1) {
        const size = rand(11, 19);
        intruders.push({
          pos: { x: width + 40 + i * rand(70, 150), y: rand(height * 0.08, height * 0.36) },
          vel: { x: -rand(20, 38), y: rand(-5, 7) },
          size,
          wobbleAmp: rand(8, 30),
          wobbleHz: rand(0.25, 0.6),
          phase: rand(0, TAU),
          spin: rand(0, TAU),
          spinRate: rand(-0.5, 0.5),
          alive: true,
          sinceDeath: 0,
        });
      }
      if (rocket) rocket.target = null;
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
        rocket = {
          pos: { x: hatchX(), y: hatchY() + 4 },
          vel: { x: 0, y: -60 },
          angle: -Math.PI / 2,
          cooldown: 0.2,
          target: null,
        };
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

      // Rocket.
      if (rocket) {
        const alive = intruders.filter((n) => n.alive);

        if (phase === "hunt") {
          huntClock += dt;

          if (alive.length === 0 && huntClock > 0.35) {
            phase = "return";
          } else if (huntClock > 22) {
            // Safety valve. The steering is damped so a chase should always resolve,
            // but a stuck rocket must not leave the lid open forever.
            phase = "return";
          } else {
            // "Randomly tracks": commit to one target until it is gone, then pick
            // another at random rather than always taking the nearest.
            if (rocket.target === null || !rocket.target.alive) {
              rocket.target = alive.length > 0 ? alive[Math.floor(Math.random() * alive.length)] : null;
            }

            const target = rocket.target;
            if (target) {
              const dx = target.pos.x - rocket.pos.x;
              const dy = target.pos.y - rocket.pos.y;
              const dist = Math.hypot(dx, dy) || 1;
              const desired = Math.atan2(dy, dx);

              // Turn rate is limited, so the rocket arcs instead of snapping.
              const turn = clamp(angleDelta(rocket.angle, desired), -4.2 * dt, 4.2 * dt);
              rocket.angle += turn;

              // Thrust eases off on approach, which stops it orbiting the target.
              const thrust = dist > 150 ? 430 : 250;
              rocket.vel.x += Math.cos(rocket.angle) * thrust * dt;
              rocket.vel.y += Math.sin(rocket.angle) * thrust * dt;

              // Fire when roughly lined up and in range.
              rocket.cooldown -= dt;
              const aimed = Math.abs(angleDelta(rocket.angle, desired)) < 0.3;
              if (aimed && dist < 300 && rocket.cooldown <= 0) {
                rocket.cooldown = rand(0.22, 0.34);
                const spread = rand(-0.05, 0.05);
                bullets.push({
                  pos: {
                    x: rocket.pos.x + Math.cos(rocket.angle) * 13,
                    y: rocket.pos.y + Math.sin(rocket.angle) * 13,
                  },
                  vel: {
                    x: Math.cos(rocket.angle + spread) * 620,
                    y: Math.sin(rocket.angle + spread) * 620,
                  },
                  life: 1.1,
                });
              }
            }
          }
        } else if (phase === "return") {
          const dx = hatchX() - rocket.pos.x;
          const dy = hatchY() - rocket.pos.y;
          const dist = Math.hypot(dx, dy) || 1;
          const desired = Math.atan2(dy, dx);
          rocket.angle += clamp(angleDelta(rocket.angle, desired), -5 * dt, 5 * dt);
          rocket.vel.x += Math.cos(rocket.angle) * 420 * dt;
          rocket.vel.y += Math.sin(rocket.angle) * 420 * dt;
          if (dist < 16) {
            rocket = null;
            phase = "close";
          }
        }

        if (rocket) {
          const speed = Math.hypot(rocket.vel.x, rocket.vel.y);
          const maxSpeed = phase === "return" ? 300 : 340;
          if (speed > maxSpeed) {
            rocket.vel.x = (rocket.vel.x / speed) * maxSpeed;
            rocket.vel.y = (rocket.vel.y / speed) * maxSpeed;
          }
          rocket.pos.x += rocket.vel.x * dt;
          rocket.pos.y += rocket.vel.y * dt;

          // Engine wash, heavier under thrust.
          if (Math.random() < 0.85) {
            const back = rocket.angle + Math.PI + rand(-0.3, 0.3);
            addParticle({
              pos: {
                x: rocket.pos.x + Math.cos(back) * 9,
                y: rocket.pos.y + Math.sin(back) * 9,
              },
              vel: {
                x: Math.cos(back) * rand(18, 60) - rocket.vel.x * 0.12,
                y: Math.sin(back) * rand(18, 60) - rocket.vel.y * 0.12,
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
      }

      if (phase === "close" && lid <= 0) {
        phase = "idle";
        timer = 0;
        waitFor = rand(20, 40);
        intruders.length = 0;
      }

      // Cull: wrecks that have finished fading, and intruders that slipped past the
      // left edge. Without the second case a survivor the rocket never caught would
      // stay "alive" forever and the drill could never end.
      for (let i = intruders.length - 1; i >= 0; i -= 1) {
        const n = intruders[i];
        const gone = n.alive ? n.pos.x < -70 : n.sinceDeath > 0.9;
        if (!gone) continue;
        if (rocket && rocket.target === n) rocket.target = null;
        intruders.splice(i, 1);
      }

      // Bullets and hits.
      for (let i = bullets.length - 1; i >= 0; i -= 1) {
        const b = bullets[i];
        b.life -= dt;
        b.pos.x += b.vel.x * dt;
        b.pos.y += b.vel.y * dt;

        let hit = false;
        for (const n of intruders) {
          if (!n.alive) continue;
          if (Math.hypot(n.pos.x - b.pos.x, n.pos.y - b.pos.y) < n.size * 0.95) {
            n.alive = false;
            n.sinceDeath = 0;
            n.vel.x *= 0.3;
            n.vel.y *= 0.3;
            n.spinRate = rand(-9, 9);
            burst({ x: n.pos.x, y: n.pos.y }, 1);
            hit = true;
            break;
          }
        }

        if (hit || b.life <= 0 || b.pos.x < -30 || b.pos.x > width + 30) {
          bullets.splice(i, 1);
        }
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

    function drawBullet(b: Bullet) {
      ctx!.save();
      ctx!.globalAlpha = Math.min(1, b.life * 3);
      const tailX = b.pos.x - b.vel.x * 0.022;
      const tailY = b.pos.y - b.vel.y * 0.022;
      const grad = ctx!.createLinearGradient(tailX, tailY, b.pos.x, b.pos.y);
      grad.addColorStop(0, "transparent");
      grad.addColorStop(1, palette.ink);
      ctx!.strokeStyle = grad;
      ctx!.lineWidth = 1.7;
      ctx!.lineCap = "round";
      ctx!.beginPath();
      ctx!.moveTo(tailX, tailY);
      ctx!.lineTo(b.pos.x, b.pos.y);
      ctx!.stroke();
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

    /** The rocket, drawn as a rectangle body with a triangular nose. */
    function drawRocket(r: Rocket) {
      ctx!.save();
      ctx!.translate(r.pos.x, r.pos.y);
      ctx!.rotate(r.angle);

      const L = 22;
      const W = 9;

      // Flame: two flickering triangles, sized by how hard it is thrusting.
      const speed = Math.hypot(r.vel.x, r.vel.y);
      const burn = clamp(speed / 340, 0.25, 1);
      ctx!.globalAlpha = 0.75;
      ctx!.fillStyle = palette.accent;
      for (let i = 0; i < 2; i += 1) {
        const len = (13 + i * 9) * burn * rand(0.75, 1.15);
        const half = (W * 0.34) * (1 - i * 0.4);
        ctx!.beginPath();
        ctx!.moveTo(-L * 0.55, -half);
        ctx!.lineTo(-L * 0.55 - len, 0);
        ctx!.lineTo(-L * 0.55, half);
        ctx!.closePath();
        ctx!.globalAlpha = i === 0 ? 0.85 : 0.4;
        ctx!.fill();
      }

      // Body.
      ctx!.globalAlpha = 0.95;
      ctx!.beginPath();
      ctx!.rect(-L * 0.55, -W / 2, L * 0.7, W);
      ctx!.fillStyle = palette.accent;
      ctx!.fill();

      // Nose.
      ctx!.beginPath();
      ctx!.moveTo(L * 0.15, -W / 2);
      ctx!.lineTo(L * 0.5, 0);
      ctx!.lineTo(L * 0.15, W / 2);
      ctx!.closePath();
      ctx!.fillStyle = palette.accent;
      ctx!.fill();

      // A bright spine so the silhouette reads against the background.
      ctx!.globalAlpha = 0.55;
      ctx!.strokeStyle = palette.ink;
      ctx!.lineWidth = 0.9;
      ctx!.beginPath();
      ctx!.moveTo(-L * 0.5, 0);
      ctx!.lineTo(L * 0.4, 0);
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
      if (rocket) drawRocket(rocket);
      for (const b of bullets) drawBullet(b);
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

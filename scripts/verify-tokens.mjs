#!/usr/bin/env node
/**
 * Token conformance check.
 *
 * The design system lives in `src/index.css` and nowhere else. This script fails the
 * build when a component reaches around it, because a colour literal buried in a
 * component is invisible until someone tries to change the theme — at which point it is
 * a find-and-replace across the whole application instead of one edit.
 *
 * It also catches the specific mistakes this re-skin was meant to end:
 *
 *   * classes from the previous theme that no longer exist, which render as *nothing*
 *     and are therefore silent rather than loud
 *   * type below the 10px floor, which the old theme used freely
 *   * `white` / `black` utilities, which bypass the ink and surface scales
 *
 * Run: npm run verify:tokens
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const TOKEN_FILE = join(SRC, "index.css");

/** Classes the previous theme defined. `index.css` no longer defines them. */
const DEAD_CLASSES = [
  "panel-shell",
  "panel-topbar",
  "panel-menubar",
  "panel-soft",
  "panel-raised",
  "panel-inset",
  "panel-board",
  "panel-stage",
  "panel-catalog",
  "panel-card",
  "panel-chip",
  "panel-icon",
  "panel-tray",
  "panel-search",
  "panel-grain",
  "surface-grid",
  "nav-idle",
  "nav-active",
  "pill-installed",
  "pill-available",
  "pill-update",
  "control-primary",
  "control-secondary",
  "control-glass",
  "control-clear",
  "custom-scrollbar",
];

const RULES = [
  {
    id: "hex-literal",
    // #rgb through #rrggbbaa. The token file is the only place these may appear.
    pattern: /#[0-9a-fA-F]{3,8}\b/g,
    message: "raw hex colour — use a token from index.css",
  },
  {
    id: "rgb-literal",
    pattern: /\brgba?\s*\(/g,
    message: "raw rgb()/rgba() colour — use a token from index.css",
  },
  {
    id: "dead-class",
    pattern: new RegExp(`\\b(${DEAD_CLASSES.join("|")})\\b`, "g"),
    message: "class from the previous theme; it no longer exists and styles nothing",
  },
  {
    id: "white-black-utility",
    // `text-white/60`, `bg-black/40`, `border-white` … all bypass the ink/surface scales.
    pattern: /\b(?:bg|text|border|from|to|via|ring|shadow|fill|stroke|decoration|outline|divide|accent|caret|placeholder)-(?:white|black)\b/g,
    message: "white/black utility — use ink, surface or scrim tokens",
  },
  {
    id: "sub-10px-type",
    // text-[9px], text-[0.5rem], text-[8.5px] … 10px is the documented floor.
    pattern: /text-\[(\d+(?:\.\d+)?)px\]/g,
    message: "type below the 10px floor",
    filter: (match, value) => Number(value) < 10,
  },
  {
    id: "sub-10px-rem-type",
    pattern: /text-\[(\d+(?:\.\d+)?)rem\]/g,
    message: "type below the 10px floor (0.625rem = 10px)",
    filter: (match, value) => Number(value) < 0.625,
  },
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strip comments so prose about a hex value does not trip the check.
 *
 * Block comments are blanked character-by-character with newlines preserved, so the
 * reported line numbers still match the real file.
 */
function stripComments(text) {
  const withoutBlocks = text.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, " "),
  );
  return withoutBlocks.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Relative luminance of an sRGB colour, per WCAG 2.1. */
function luminance(hex) {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value.slice(0, 6);
  const channels = [0, 2, 4].map((offset) => {
    const c = parseInt(full.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** WCAG contrast ratio between two hex colours. */
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Contrast is the one visual property that can be checked without seeing the screen, so
 * it is checked. Text below AA on its own background is a regression that review never
 * catches and users notice immediately.
 */
function checkContrast(css) {
  const read = (name) => {
    const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`));
    return match ? match[1] : null;
  };

  const surfaces = ["canvas", "surface", "raised"].map((name) => ({
    name,
    hex: read(`color-${name}`),
  }));
  const inks = ["ink", "ink-dim", "ink-faint"].map((name) => ({
    name,
    hex: read(`color-${name}`),
  }));

  const failures = [];
  for (const surface of surfaces) {
    if (!surface.hex) {
      failures.push({ text: `--color-${surface.name} not found in index.css` });
      continue;
    }
    for (const ink of inks) {
      if (!ink.hex) {
        failures.push({ text: `--color-${ink.name} not found in index.css` });
        continue;
      }
      const ratio = contrast(ink.hex, surface.hex);
      if (ratio < 4.5) {
        failures.push({
          surface: surface.name,
          text: `${ink.name} on ${surface.name}: ${ratio.toFixed(2)}:1 (needs 4.5:1)`,
        });
      }
    }
  }
  return failures;
}

const files = walk(SRC).filter((file) => file !== TOKEN_FILE);
const problems = [];

for (const file of files) {
  const raw = readFileSync(file, "utf8");
  const scannable = stripComments(raw);
  const lines = raw.split(/\r?\n/);
  const scanLines = scannable.split(/\r?\n/);

  for (const rule of RULES) {
    for (let index = 0; index < scanLines.length; index += 1) {
      const line = scanLines[index];
      rule.pattern.lastIndex = 0;

      let match;
      while ((match = rule.pattern.exec(line)) !== null) {
        if (rule.filter && !rule.filter(match[0], match[1])) continue;
        problems.push({
          file: relative(ROOT, file),
          line: index + 1,
          rule: rule.id,
          message: rule.message,
          text: match[0],
          excerpt: (lines[index] ?? "").trim().slice(0, 140),
        });
      }
    }
  }
}

const contrastFailures = checkContrast(readFileSync(TOKEN_FILE, "utf8"));

if (problems.length === 0 && contrastFailures.length === 0) {
  console.log(`token conformance: ${files.length} files clean`);
  console.log("  no raw colours, no dead classes, no sub-10px type, no white/black utilities");
  console.log("  ink levels clear WCAG AA (4.5:1) on canvas, surface and raised");
  process.exit(0);
}

if (problems.length > 0) {
  console.error(`token conformance: ${problems.length} problem(s) in ${files.length} files\n`);
  for (const problem of problems) {
    console.error(`  ${problem.file}:${problem.line}  [${problem.rule}] ${problem.message}`);
    console.error(`      ${problem.excerpt}`);
  }
  console.error(
    "\nEvery value here belongs in src/index.css. Add or adjust a token there and reference it.",
  );
}

if (contrastFailures.length > 0) {
  console.error(`\ncontrast: ${contrastFailures.length} problem(s)\n`);
  for (const failure of contrastFailures) {
    console.error(`  ${failure.text}`);
  }
  console.error("\nAdjust the ink or surface tokens in src/index.css until these clear 4.5:1.");
}

process.exit(1);

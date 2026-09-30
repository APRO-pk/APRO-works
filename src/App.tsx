import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  PhysicalPosition,
  PhysicalSize,
  currentMonitor,
  cursorPosition,
  getCurrentWindow,
} from "@tauri-apps/api/window";
import { supabase } from "./lib/supabase";
import { WorkflowsPanel } from "./sections/WorkflowsPanel";
import {
  ACCENTS,
  accentSwatch,
  applyAccent,
  loadAccentId,
  saveAccentId,
  type AccentId,
} from "./lib/theme";
import logo from "../src-tauri/icons/icon.png";
import geometryIcon from "./assets/icons/GeometryModeler.png";
import hexadofIcon from "./assets/icons/HexadofForLight.png";
import propulsorIcon from "./assets/icons/PropulsorForLight.png";

type SectionId = "installed-apps" | "all-apps" | "workflows" | "downloads" | "settings";
type DownloadStage =
  | "idle"
  | "checking"
  | "downloading"
  | "installing"
  | "ready"
  | "launching"
  | "uninstalling"
  | "error";

type NavItem = {
  id: SectionId;
  label: string;
  icon: ReactNode;
  /** Which rail heading this item sits under. */
  group: (typeof NAV_GROUPS)[number];
};

type ProductDefinition = {
  slug: string;
  name: string;
  description: string;
  archiveUrl: string;
  executablePath: string;
  /**
   * Optional icon. Without it the card falls back to a monogram, which is honest:
   * a placeholder image would misrepresent the product.
   *
   * The full-bleed background renders this list used to carry were dropped with the
   * card redesign — the catalogue is text-first now, matching the rest of the shell.
   * The artwork is still in `src/assets/` if a product header wants it later.
   */
  iconImage?: string;
  /** Short category shown under the product name. */
  eyebrow: string;
};

type ProductStatus = {
  installed: boolean;
  update_available: boolean;
  install_dir: string;
  executable_path: string;
};

type ProductProgressPayload = {
  slug: string;
  phase: DownloadStage | string;
  progress: number;
  message: string;
};

type DownloadHistoryItem = {
  id: string;
  title: string;
  detail: string;
  tone?: "success" | "error";
};

type SnackbarState = {
  visible: boolean;
  title: string;
  detail: string;
};

type MemberRecord = {
  id: string;
  auth_user_id: string;
  account_status: string;
  email: string | null;
  full_name: string | null;
  member_type?: string | null;
};

const RESTORED_WINDOW_WIDTH = 1440;
const RESTORED_WINDOW_HEIGHT = 900;

const products: ProductDefinition[] = [
  {
    slug: "apro-cad",
    name: "APRO CAD",
    description:
      "Text-first parametric CAD for rocket hardware. Describe geometry in RON and evaluate it to 3D meshes.",
    // A GitHub Release asset. `/releases/latest/download/<name>` is stable because the
    // asset name is version-free, so the ETag changing is what signals an update.
    archiveUrl:
      "https://github.com/APRO-pk/aproCAD/releases/latest/download/apro-cad-win64.zip",
    executablePath: "apro-cad.exe",
    eyebrow: "Parametric CAD",
    // No iconImage: the repo ships only the stock Tauri placeholder icons (one is a
    // blank white square). Real artwork is a follow-up; the monogram is honest until then.
  },
  {
    slug: "burn-geometry-modeler",
    name: "Burn & Geometry Modeler",
    description: "Grain geometry, burn progression, and design iteration in one desktop workspace.",
    archiveUrl:
      "https://zljhwosvsdqvgcgusqct.supabase.co/storage/v1/object/public/apro-products/Burn%20&%20Geometry%20Modeler-win64.zip",
    executablePath: "burn-geometry-modeler.exe",
    iconImage: geometryIcon,
    eyebrow: "Geometry + Burn",
  },
  {
    slug: "Propulsor - Liquid Engine Design Studio",
    name: "Propulsor",
    description: "Liquid engine design, cycle exploration, and propulsion analysis for iterative development.",
    archiveUrl:
      "https://zljhwosvsdqvgcgusqct.supabase.co/storage/v1/object/public/apro-products/Propulsor%20-%20Liquid%20Engine%20Design%20Studio-win64.zip",
    executablePath: "propulsor-liquid-engine-design-studio.exe",
    iconImage: propulsorIcon,
    eyebrow: "Liquid Engines",
  },
  {
    slug: "hexadof",
    name: "HexaDOF",
    description: "Flight dynamics, telemetry, and six-degree-of-freedom analysis in a live mission workspace.",
    archiveUrl:
      "https://github.com/APRO-pk/hexadof2/releases/latest/download/hexadof-win64.zip",
    executablePath: "hexadof-desktop.exe",
    iconImage: hexadofIcon,
    eyebrow: "Flight Dynamics",
  },
];

const navItems: NavItem[] = [
  {
    id: "installed-apps",
    label: "Installed",
    group: "General",
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7">
        <rect x="3" y="3" width="8" height="8" rx="2" />
        <rect x="13" y="3" width="8" height="5" rx="2" />
        <rect x="13" y="10" width="8" height="11" rx="2" />
        <rect x="3" y="13" width="8" height="8" rx="2" />
      </svg>
    ),
  },
  {
    id: "all-apps",
    label: "All Apps",
    group: "General",
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7">
        <path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z" />
        <path d="M4 7.5 12 12l8-4.5M12 12v9" />
      </svg>
    ),
  },
  {
    id: "workflows",
    label: "Workflows",
    group: "Orchestration",
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7">
        <rect x="3" y="3.5" width="7" height="5" rx="1.6" />
        <rect x="14" y="15.5" width="7" height="5" rx="1.6" />
        <path d="M10 6h3.5a3 3 0 0 1 3 3v6.5" />
        <circle cx="10" cy="6" r="1.1" />
        <circle cx="16.5" cy="15.5" r="1.1" />
      </svg>
    ),
  },
  {
    id: "downloads",
    label: "Downloads",
    group: "Activity",
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7">
        <path d="M12 4v10m0 0 4-4m-4 4-4-4M5 18h14" />
      </svg>
    ),
  },
];

/** Section headings in the rail, in order. */
const NAV_GROUPS = ["General", "Orchestration", "Activity"] as const;

const stageLabels: Record<DownloadStage, string> = {
  idle: "Idle",
  checking: "Checking state",
  downloading: "Downloading",
  installing: "Installing",
  ready: "Ready",
  launching: "Launching",
  uninstalling: "Removing",
  error: "Error",
};

const sectionCopy: Record<SectionId, { title: string; subtitle: string }> = {
  "all-apps": {
    title: "All Apps",
    subtitle: "Everything APRO publishes, grouped by what you can do with it.",
  },
  "installed-apps": {
    title: "Installed",
    subtitle: "What is on this machine right now. Launches are handed the store connection automatically.",
  },
  workflows: {
    title: "Workflows",
    subtitle: "Wire one app's published output into another's input. A wire is a dependency the platform tracks.",
  },
  downloads: {
    title: "Downloads",
    subtitle: "Install and update progress, and what the last few transfers did.",
  },
  settings: {
    title: "Settings",
    subtitle: "Your APRO Works account session.",
  },
};

function initialsFromName(name: string) {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);

  if (parts.length === 0) {
    return "AP";
  }

  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("");
}

function LoginScreen({
  email,
  password,
  onEmailChange,
  onPasswordChange,
  onSubmit,
  loading,
  error,
}: {
  email: string;
  password: string;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: () => void;
  loading: boolean;
  error: string;
}) {
  return (
    <div className="app-canvas flex h-screen items-center justify-center overflow-hidden px-6 text-ink">
      <div className="w-full max-w-[380px]">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md border border-line bg-raised">
            <img src={logo} alt="" className="h-5 w-auto object-contain" />
          </div>
          <div>
            <p className="text-[13px] font-semibold leading-none text-ink">APRO Works</p>
            <p className="mt-1 text-[11px] leading-none text-ink-faint">Engineering platform</p>
          </div>
        </div>

        <div className="card p-5">
          <h1 className="text-[19px] font-semibold tracking-tight text-ink">Sign in</h1>
          <p className="mt-1 text-[12px] leading-5 text-ink-dim">
            Access is limited to approved members.
          </p>

          <form
            className="mt-5 space-y-3.5"
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit();
            }}
          >
            <label className="block">
              <span className="label mb-1.5 block">Email</span>
              <input
                type="email"
                value={email}
                onChange={(event) => onEmailChange(event.target.value)}
                placeholder="you@example.com"
                className="field w-full px-3 py-2.5 text-[13px] outline-none placeholder:text-ink-faint"
                required
              />
            </label>

            <label className="block">
              <span className="label mb-1.5 block">Password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => onPasswordChange(event.target.value)}
                placeholder="••••••••"
                className="field w-full px-3 py-2.5 text-[13px] outline-none placeholder:text-ink-faint"
                required
              />
            </label>

            {error ? (
              <div className="rounded-md border border-bad/30 bg-bad/10 px-3 py-2.5 text-[12px] leading-5 text-ink">
                {error}
              </div>
            ) : null}

            <button type="submit" disabled={loading} className="btn btn-primary w-full py-2.5">
              {loading ? "Signing in…" : "Sign In"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function AproLogo() {
  return (
    <div className="flex items-center gap-2.5 px-1.5">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-line bg-raised">
        <img src={logo} alt="" className="h-4 w-auto object-contain" />
      </div>
      <span className="text-[13px] font-semibold tracking-tight text-ink">APRO Works</span>
    </div>
  );
}

function WindowControls() {
  const appWindow = useMemo(() => getCurrentWindow(), []);
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);

  async function applyRestoredWindowBounds() {
    const monitor = await currentMonitor();
    const workArea = monitor?.workArea;
    const restoredWidth = Math.min(RESTORED_WINDOW_WIDTH, workArea?.size.width ?? RESTORED_WINDOW_WIDTH);
    const restoredHeight = Math.min(RESTORED_WINDOW_HEIGHT, workArea?.size.height ?? RESTORED_WINDOW_HEIGHT);

    await appWindow.setResizable(true);
    await appWindow.setMinSize(null);
    await appWindow.setMaxSize(null);
    await appWindow.setSize(new PhysicalSize(restoredWidth, restoredHeight));

    if (workArea) {
      const x = workArea.position.x + Math.floor((workArea.size.width - restoredWidth) / 2);
      const y = workArea.position.y + Math.floor((workArea.size.height - restoredHeight) / 2);
      await appWindow.setPosition(new PhysicalPosition(x, y));
    }

    await appWindow.setResizable(false);
  }

  async function applyMaximizedWindowBounds() {
    await appWindow.setResizable(true);
    await appWindow.setMinSize(null);
    await appWindow.setMaxSize(null);
    await appWindow.maximize();
  }

  useEffect(() => {
    let disposed = false;
    let unlistenResized: (() => void) | undefined;
    let unlistenMoved: (() => void) | undefined;

    void (async () => {
      try {
        await applyRestoredWindowBounds();
        setIsWindowMaximized(await appWindow.isMaximized());
        await appWindow.show();
      } catch {
        // Browser preview.
      }
    })();

    void appWindow
      .onResized(async () => {
        if (disposed) {
          return;
        }
        setIsWindowMaximized(await appWindow.isMaximized());
      })
      .then((unlisten) => {
        unlistenResized = unlisten;
      });

    void appWindow
      .onMoved(async () => {
        if (disposed) {
          return;
        }
        setIsWindowMaximized(await appWindow.isMaximized());
      })
      .then((unlisten) => {
        unlistenMoved = unlisten;
      });

    return () => {
      disposed = true;
      unlistenResized?.();
      unlistenMoved?.();
    };
  }, [appWindow]);

  async function handleMinimize() {
    try {
      await appWindow.minimize();
    } catch {
      // Browser preview.
    }
  }

  async function handleToggleMaximize() {
    try {
      if (isWindowMaximized) {
        await appWindow.unmaximize();
        await applyRestoredWindowBounds();
        setIsWindowMaximized(false);
      } else {
        await applyMaximizedWindowBounds();
        setIsWindowMaximized(true);
      }
    } catch {
      // Browser preview.
    }
  }

  async function handleClose() {
    try {
      await appWindow.destroy();
    } catch {
      // Browser preview.
    }
  }

  const chromeButtonClass = "icon-btn";

  return (
    <div className="flex items-center gap-0.5">
      <button type="button" aria-label="Minimize window" onClick={handleMinimize} onMouseDown={(event) => event.stopPropagation()} className={chromeButtonClass}>
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M6 12h12" />
        </svg>
      </button>
      <button
        type="button"
        aria-label={isWindowMaximized ? "Restore window" : "Maximize window"}
        onClick={handleToggleMaximize}
        onMouseDown={(event) => event.stopPropagation()}
        className={chromeButtonClass}
      >
        {isWindowMaximized ? (
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M8 8h9v9H8z" />
            <path d="M6 16V6h10" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />
          </svg>
        )}
      </button>
      <button
        type="button"
        aria-label="Close window"
        onClick={handleClose}
        onMouseDown={(event) => event.stopPropagation()}
        className="icon-btn icon-btn-danger"
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="m7 7 10 10M17 7 7 17" />
        </svg>
      </button>
    </div>
  );
}

function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="field flex h-8 items-center gap-2 px-2.5">
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-ink-faint" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="11" cy="11" r="6.5" />
        <path d="m16 16 4 4" />
      </svg>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full min-w-0 bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-faint"
      />
    </label>
  );
}

/**
 * One figure.
 *
 * `tone` is deliberately not a free choice. `good`/`bad`/`warn` assert that a
 * direction is better or worse, and most counts in this application are neutral —
 * more artifacts is neither. Callers that cannot justify a direction omit `tone`
 * and get the default ink.
 */
function Metric({
  label,
  value,
  hint,
  tone,
  className,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "good" | "bad" | "warn";
  className?: string;
}) {
  const valueTone =
    tone === "good"
      ? "text-good"
      : tone === "bad"
        ? "text-bad"
        : tone === "warn"
          ? "text-warn"
          : "text-ink";

  return (
    <div className={`card p-3.5 ${className ?? ""}`}>
      <div className="label">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className={`metric ${valueTone}`}>{value}</span>
        {hint ? <span className="text-[11px] text-ink-faint">{hint}</span> : null}
      </div>
    </div>
  );
}

/** The headline panel: the number that matters, with its parts underneath. */
function HeroMetric({
  label,
  value,
  parts,
  className,
}: {
  label: string;
  value: string | number;
  parts: Array<{ label: string; value: string | number }>;
  className?: string;
}) {
  return (
    <div className={`card flex flex-col justify-between p-3.5 ${className ?? ""}`}>
      <div className="label">{label}</div>
      <div className="metric metric-lg mt-1.5">{value}</div>
      {parts.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
          {parts.map((part) => (
            <span key={part.label} className="text-[11px] text-ink-dim">
              <span className="text-ink-faint">{part.label}</span>{" "}
              <span className="mono text-ink">{part.value}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SectionHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  /** Section-specific controls, aligned to the title's baseline. */
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[19px] font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle ? (
          <p className="mt-1 max-w-[46rem] text-[12px] leading-5 text-ink-dim">{subtitle}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

function ProductCard({
  product,
  installed,
  updateAvailable,
  busy,
  onPrimaryAction,
  onSecondaryAction,
  index,
}: {
  product: ProductDefinition;
  installed: boolean;
  updateAvailable: boolean;
  busy: boolean;
  onPrimaryAction: () => void;
  onSecondaryAction?: () => void;
  /** Position in its grid, used only to stagger the entrance. */
  index?: number;
}) {
  // Only "an update is waiting" is actionable, so it is the only state that gets the
  // accent. Installed and available are just facts about this machine.
  const statusTone = updateAvailable ? "pill-accent" : "";

  return (
    <article
      className="card card-interactive glow-swipe rise flex flex-col p-4"
      style={{ animationDelay: `${(index ?? 0) * 45}ms` }}
    >
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-line bg-raised">
          {product.iconImage ? (
            <img src={product.iconImage} alt="" className="h-7 w-7 object-contain" />
          ) : (
            <span className="text-[13px] font-semibold tracking-wide text-ink-dim">
              {initialsFromName(product.name)}
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="truncate text-[14px] font-semibold leading-tight tracking-tight text-ink">
              {product.name}
            </h3>
            <span className={`pill shrink-0 ${statusTone}`}>
              {updateAvailable ? "Update" : installed ? "Installed" : "Available"}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-ink-faint">{product.eyebrow}</p>
        </div>
      </div>

      <p className="mt-3 flex-1 text-[12px] leading-5 text-ink-dim">{product.description}</p>

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={onPrimaryAction}
          disabled={busy}
          className={`btn glow-swipe flex-1 ${installed && !updateAvailable ? "btn-primary" : "btn-quiet"}`}
        >
          {busy ? "Working…" : updateAvailable ? "Update" : installed ? "Launch" : "Install"}
        </button>
        {installed && onSecondaryAction ? (
          <button type="button" onClick={onSecondaryAction} disabled={busy} className="btn btn-ghost">
            Remove
          </button>
        ) : null}
      </div>
    </article>
  );
}

/** A labelled heading inside a page, so one screen can hold several groups. */
function SubSection({
  title,
  count,
  detail,
  actions,
}: {
  title: string;
  count?: number;
  detail?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <div className="flex items-baseline gap-2.5">
        <h2 className="text-[13px] font-semibold tracking-tight text-ink">{title}</h2>
        {count !== undefined ? (
          <span className="pill">{count}</span>
        ) : null}
        {detail ? <span className="text-[11px] text-ink-faint">{detail}</span> : null}
      </div>
      {actions}
    </div>
  );
}

/**
 * One installed workspace.
 *
 * Deliberately not a `ProductCard`. The installed screen answers one question —
 * "what can I run right now?" — so it is a list of launch affordances rather than a
 * catalogue. Removing an app is a catalogue action and lives in All Apps, which keeps
 * a destructive control off the screen a user opens to start working.
 */
function InstalledRow({
  product,
  updateAvailable,
  busy,
  onLaunch,
  onUpdate,
  index,
}: {
  product: ProductDefinition;
  updateAvailable: boolean;
  busy: boolean;
  onLaunch: () => void;
  onUpdate: () => void;
  index: number;
}) {
  return (
    <li
      className="card rise flex items-center gap-3.5 px-4 py-3"
      style={{ animationDelay: `${index * 45}ms` }}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-line bg-raised">
        {product.iconImage ? (
          <img src={product.iconImage} alt="" className="h-6 w-6 object-contain" />
        ) : (
          <span className="text-[12px] font-semibold text-ink-dim">
            {initialsFromName(product.name)}
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-ink">{product.name}</span>
          {updateAvailable ? <span className="pill pill-accent">Update ready</span> : null}
        </div>
        <p className="truncate text-[11px] text-ink-faint">{product.eyebrow}</p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {updateAvailable ? (
          <button type="button" onClick={onUpdate} disabled={busy} className="btn btn-quiet">
            {busy ? "Updating…" : "Update"}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onLaunch}
          disabled={busy}
          className="btn btn-primary glow-swipe min-w-[92px]"
        >
          {busy ? "Starting…" : "Launch"}
        </button>
      </div>
    </li>
  );
}

/**
 * The external-apps placeholder.
 *
 * There are no external apps yet, so this states that rather than inventing
 * plausible-looking ones to fill the grid. A card full of fictional products would
 * be the single most misleading thing on the screen.
 */
function ExternalAppsCard() {
  return (
    <div className="card-dashed rise flex flex-col items-start gap-3 p-5 sm:col-span-2 lg:col-span-3">
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-md border border-line-strong text-ink-faint">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path d="M12 3v10m0 0 3.5-3.5M12 13 8.5 9.5" />
            <path d="M4.5 16.5v2A2.5 2.5 0 0 0 7 21h10a2.5 2.5 0 0 0 2.5-2.5v-2" />
          </svg>
        </span>
        <span className="pill pill-accent">Coming soon</span>
      </div>
      <div>
        <h3 className="text-[13px] font-semibold tracking-tight text-ink">External apps</h3>
        <p className="mt-1 max-w-[54ch] text-[12px] leading-5 text-ink-dim">
          Third-party tools will be able to publish and consume through the same store, so
          anything outside the APRO suite can take part in a workflow. Nothing is
          available to install yet.
        </p>
      </div>
    </div>
  );
}

function LaunchOverlay({
  productName,
}: {
  productName: string;
}) {
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-scrim">
      <div className="card w-full max-w-[340px] p-6 text-center">
        <div className="mx-auto flex h-10 w-10 items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
        </div>
        <p className="label mt-4">Launching</p>
        <h3 className="mt-1.5 text-[15px] font-semibold tracking-tight text-ink">{productName}</h3>
        <p className="mt-2 text-[12px] leading-5 text-ink-dim">
          Preparing the workspace window and handing control to the product.
        </p>
      </div>
    </div>
  );
}

function EmptyState({
  title,
  detail,
}: {
  title: string;
  detail: string;
}) {
  return (
    <div className="card-dashed flex min-h-[180px] items-center justify-center px-6 py-8 text-center">
      <div className="max-w-[26rem]">
        <p className="text-[14px] font-semibold tracking-tight text-ink">{title}</p>
        <p className="mt-2 text-[12px] leading-5 text-ink-dim">{detail}</p>
      </div>
    </div>
  );
}

function DownloadHistoryCard({
  item,
  onDismiss,
}: {
  item: DownloadHistoryItem;
  onDismiss: () => void;
}) {
  // A failed install is genuinely worse than a successful one, so this is one of the
  // few places a status colour is justified.
  const failed = item.tone === "error";

  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-line px-3.5 py-3">
      <div className="min-w-0">
        <p className="text-[12px] font-semibold text-ink">{item.title}</p>
        <p className="mt-0.5 text-[12px] leading-5 text-ink-dim">{item.detail}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className={`pill ${failed ? "pill-failed" : "pill-fresh"}`}>
          {failed ? "Failed" : "Done"}
        </span>
        <button type="button" aria-label="Dismiss notification" onClick={onDismiss} className="icon-btn">
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.9">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function DownloadsPanel({
  showActiveDownload,
  activeProductName,
  downloadStage,
  downloadProgress,
  statusMessage,
  errorMessage,
  history,
  onDismissHistory,
}: {
  showActiveDownload: boolean;
  activeProductName: string;
  downloadStage: DownloadStage;
  downloadProgress: number;
  statusMessage: string;
  errorMessage: string;
  history: DownloadHistoryItem[];
  onDismissHistory: (id: string) => void;
}) {
  if (showActiveDownload) {
    return (
      <section className="card p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="label">Active transfer</p>
            <h3 className="mt-1.5 text-[15px] font-semibold tracking-tight text-ink">{activeProductName}</h3>
          </div>
          <span className="pill shrink-0">{stageLabels[downloadStage]}</span>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <div className="progress-track h-1.5 flex-1">
            <div className="progress-fill h-full" style={{ width: `${downloadProgress}%` }} />
          </div>
          <span className="mono shrink-0 text-[11px] text-ink-dim">{downloadProgress}%</span>
        </div>

        <p className="mt-3 text-[12px] leading-5 text-ink-dim">{statusMessage}</p>
        {errorMessage ? <p className="mt-2 text-[12px] text-bad">{errorMessage}</p> : null}
      </section>
    );
  }

  return (
    <section className="card p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[14px] font-semibold tracking-tight text-ink">No downloads</h3>
        <span className="text-[11px] text-ink-faint">
          {history.length > 0 ? `${history.length} recent` : "Nothing queued"}
        </span>
      </div>
      <p className="mt-1.5 text-[12px] leading-5 text-ink-dim">
        Completed installs stay here until you leave this tab or dismiss them.
      </p>
      {history.length > 0 ? (
        <div className="mt-4 space-y-2">
          {history.map((item) => (
            <DownloadHistoryCard key={item.id} item={item} onDismiss={() => onDismissHistory(item.id)} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function SettingsPanel({
  member,
  accentId,
  onAccentChange,
  onSignOut,
  signingOut,
}: {
  member: MemberRecord;
  accentId: AccentId;
  onAccentChange: (id: AccentId) => void;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  return (
    <section className="grid gap-3 xl:grid-cols-[1.3fr_0.7fr]">
      <div className="flex flex-col gap-3">
        <div className="card p-4">
          <p className="label">Accent</p>
          <p className="mt-1.5 max-w-[52ch] text-[12px] leading-5 text-ink-dim">
            Applied immediately and remembered on this machine. Primary buttons, focus
            rings, the ambient glow and the workflow wires all derive from this one value,
            so nothing else needs setting.
          </p>

          <div className="mt-3.5 flex flex-wrap gap-2" role="radiogroup" aria-label="Accent colour">
            {ACCENTS.map((accent) => {
              const active = accent.id === accentId;
              return (
                <button
                  key={accent.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => onAccentChange(accent.id)}
                  className={`flex items-center gap-2 rounded-pill border px-2.5 py-1.5 text-[11px] font-medium transition ${
                    active
                      ? "border-line-strong bg-raised text-ink"
                      : "border-line text-ink-dim hover:bg-raised hover:text-ink"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className="h-3 w-3 rounded-full"
                    style={{ background: accentSwatch(accent.id) }}
                  />
                  {accent.name}
                </button>
              );
            })}
          </div>
        </div>

        <div className="card p-4">
          <p className="label">Account</p>
          <h3 className="mt-1.5 text-[15px] font-semibold tracking-tight text-ink">
            {member.full_name ?? member.email ?? "APRO member"}
          </h3>
          <p className="mt-2 text-[12px] leading-5 text-ink-dim">
            Manage your APRO Works account session.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="pill">{member.account_status}</span>
            <span className="text-[11px] text-ink-faint">{member.email ?? "No email available"}</span>
          </div>
          <button type="button" onClick={onSignOut} disabled={signingOut} className="btn btn-ghost mt-5">
            {signingOut ? "Signing out…" : "Sign Out"}
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className="card p-3.5">
          <p className="label">Session</p>
          <p className="mt-1.5 text-[12px] leading-5 text-ink-dim">
            Your sign-in session is restored automatically when APRO Works starts.
          </p>
        </div>
        <div className="card p-3.5">
          <p className="label">Access</p>
          <p className="mt-1.5 text-[12px] leading-5 text-ink-dim">
            Only approved members can open APRO Works.
          </p>
        </div>
      </div>
    </section>
  );
}

function App() {
  const appWindow = useMemo(() => getCurrentWindow(), []);
  const [authReady, setAuthReady] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authSession, setAuthSession] = useState<Session | null>(null);
  const [member, setMember] = useState<MemberRecord | null>(null);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const [accentId, setAccentId] = useState<AccentId>(() => loadAccentId());
  const [activeSection, setActiveSection] = useState<SectionId>("all-apps");
  const [searchQuery, setSearchQuery] = useState("");
  const [productStatuses, setProductStatuses] = useState<Record<string, ProductStatus>>({});
  const [activeProductSlug, setActiveProductSlug] = useState<string | null>(null);
  const [downloadStage, setDownloadStage] = useState<DownloadStage>("checking");
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Checking local install state...");
  const [errorMessage, setErrorMessage] = useState("");
  const [downloadHistory, setDownloadHistory] = useState<DownloadHistoryItem[]>([]);
  const [launchOverlayProduct, setLaunchOverlayProduct] = useState<string | null>(null);
  // The Workflows tab's buttons live in the section header, so their state lives here.
  const [workflowSync, setWorkflowSync] = useState(0);
  const [workflowReset, setWorkflowReset] = useState(0);
  const [workflowConsole, setWorkflowConsole] = useState(false);
  const [snackbar, setSnackbar] = useState<SnackbarState>({
    visible: false,
    title: "",
    detail: "",
  });

  const activeProduct = products.find((product) => product.slug === activeProductSlug) ?? null;
  const profileName = member?.full_name?.trim() || authSession?.user?.email || "APRO member";
  const profileSubtitle = member?.member_type ? `${member.member_type} member` : "Approved member";

  async function validateApprovedMember(session: Session) {
    const { data: memberRow, error } = await supabase
      .from("members")
      .select("id, auth_user_id, account_status, email, full_name, member_type")
      .eq("auth_user_id", session.user.id)
      .single();

    if (error || !memberRow) {
      await supabase.auth.signOut();
      throw new Error("No member account was found for this user.");
    }

    if (memberRow.account_status === "PENDING") {
      await supabase.auth.signOut();
      throw new Error("Your application is still under review.");
    }

    if (memberRow.account_status === "REJECTED") {
      await supabase.auth.signOut();
      throw new Error("Your application has been rejected. Please contact APRO if you think this is a mistake.");
    }

    if (memberRow.account_status !== "APPROVED") {
      await supabase.auth.signOut();
      throw new Error("Your account is not allowed to access APRO Works.");
    }

    return memberRow as MemberRecord;
  }

  async function refreshProductStatuses() {
    setDownloadStage("checking");
    setStatusMessage("Checking local install state...");

    try {
      const statuses = await Promise.all(
        products.map(async (product) => {
          const status = await invoke<ProductStatus>("get_product_status", {
            slug: product.slug,
            url: product.archiveUrl,
            exePath: product.executablePath,
          });
          return [product.slug, status] as const;
        }),
      );

      setProductStatuses(Object.fromEntries(statuses));
      setDownloadStage("idle");
      setDownloadProgress(0);
      setStatusMessage("Products are available to install or launch.");
      setErrorMessage("");
    } catch (error) {
      setDownloadStage("error");
      setErrorMessage(String(error));
      setStatusMessage("Unable to determine product state.");
    }
  }

  useEffect(() => {
    let mounted = true;

    async function initializeAuth() {
      try {
        const { data } = await supabase.auth.getSession();
        if (!mounted) {
          return;
        }

        if (!data.session) {
          setAuthSession(null);
          setMember(null);
          setAuthReady(true);
          return;
        }

        const approvedMember = await validateApprovedMember(data.session);
        if (!mounted) {
          return;
        }

        setAuthSession(data.session);
        setMember(approvedMember);
        setAuthError("");
        setAuthReady(true);
      } catch (error) {
        if (!mounted) {
          return;
        }

        setAuthSession(null);
        setMember(null);
        setAuthError(error instanceof Error ? error.message : "Unable to restore your session.");
        setAuthReady(true);
      }
    }

    void initializeAuth();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        setAuthSession(null);
        setMember(null);
        setAuthReady(true);
        return;
      }

      void (async () => {
        try {
          const approvedMember = await validateApprovedMember(session);
          if (!mounted) {
            return;
          }

          setAuthSession(session);
          setMember(approvedMember);
          setAuthError("");
          setAuthReady(true);
        } catch (error) {
          if (!mounted) {
            return;
          }

          setAuthSession(null);
          setMember(null);
          setAuthError(error instanceof Error ? error.message : "Unable to validate your account.");
          setAuthReady(true);
        }
      })();
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!member) {
      return;
    }

    void refreshProductStatuses();
  }, [member]);

  // The accent is a single custom property; everything else derives from it in CSS.
  useEffect(() => {
    applyAccent(accentId);
  }, [accentId]);

  function handleAccentChange(id: AccentId) {
    setAccentId(id);
    saveAccentId(id);
  }

  useEffect(() => {
    if (activeSection !== "downloads") {
      setDownloadHistory([]);
      if (!busy) {
        setErrorMessage("");
        setDownloadProgress(0);
        setDownloadStage("idle");
        setStatusMessage("Products are available to install or launch.");
      }
    }
  }, [activeSection, busy]);

  useEffect(() => {
    if (!snackbar.visible) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setSnackbar((current) => ({ ...current, visible: false }));
    }, 3200);

    return () => window.clearTimeout(timeout);
  }, [snackbar.visible, snackbar.title, snackbar.detail]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    void getCurrentWindow()
      .listen<ProductProgressPayload>("product-progress", (event) => {
        setActiveProductSlug(event.payload.slug);
        const nextPhase = event.payload.phase as DownloadStage;
        setDownloadStage(nextPhase);
        setDownloadProgress(event.payload.progress);
        setStatusMessage(event.payload.message);
        if (nextPhase !== "error") {
          setErrorMessage("");
        }
      })
      .then((dispose) => {
        unlisten = dispose;
      });

    return () => {
      unlisten?.();
    };
  }, []);

  async function handleLogin() {
    setAuthLoading(true);
    setAuthError("");

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: loginEmail,
        password: loginPassword,
      });

      if (error) {
        setAuthError(error.message);
        return;
      }

      if (!data.session) {
        setAuthError("Login failed.");
        return;
      }

      const approvedMember = await validateApprovedMember(data.session);
      setAuthSession(data.session);
      setMember(approvedMember);
      setLoginPassword("");
      setAuthError("");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Something went wrong. Please try again.");
    } finally {
      setAuthLoading(false);
      setAuthReady(true);
    }
  }

  async function handleSignOut() {
    setSigningOut(true);

    try {
      await supabase.auth.signOut();
      setAuthSession(null);
      setMember(null);
      setProductStatuses({});
      setSearchQuery("");
      setActiveSection("all-apps");
      setLoginPassword("");
    } finally {
      setSigningOut(false);
    }
  }

  async function handleTitlebarMouseDown(event: MouseEvent<HTMLElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("button, input, a")) {
      return;
    }

    try {
      const isMaximized = await appWindow.isMaximized();
      if (isMaximized) {
        const mousePosition = await cursorPosition();
        const monitor = await currentMonitor();
        const workArea = monitor?.workArea;
        const restoredWidth = Math.min(RESTORED_WINDOW_WIDTH, workArea?.size.width ?? RESTORED_WINDOW_WIDTH);
        const restoredHeight = Math.min(RESTORED_WINDOW_HEIGHT, workArea?.size.height ?? RESTORED_WINDOW_HEIGHT);
        const relativeX = workArea ? (mousePosition.x - workArea.position.x) / workArea.size.width : 0.5;
        const unclampedX = Math.round(mousePosition.x - restoredWidth * relativeX);
        const unclampedY = Math.round(mousePosition.y - 18);
        const minX = workArea?.position.x ?? unclampedX;
        const minY = workArea?.position.y ?? unclampedY;
        const maxX = workArea ? workArea.position.x + workArea.size.width - restoredWidth : unclampedX;
        const maxY = workArea ? workArea.position.y + workArea.size.height - restoredHeight : unclampedY;
        const nextX = Math.min(Math.max(unclampedX, minX), maxX);
        const nextY = Math.min(Math.max(unclampedY, minY), maxY);

        await appWindow.unmaximize();
        await appWindow.setResizable(true);
        await appWindow.setMinSize(null);
        await appWindow.setMaxSize(null);
        await appWindow.setSize(new PhysicalSize(restoredWidth, restoredHeight));
        await appWindow.setPosition(new PhysicalPosition(nextX, nextY));
        await appWindow.setResizable(false);
      }

      await appWindow.startDragging();
    } catch {
      // Browser preview.
    }
  }

  async function handleProductAction(product: ProductDefinition) {
    const currentStatus = productStatuses[product.slug];
    setBusy(true);
    setErrorMessage("");
    setActiveProductSlug(product.slug);

    try {
      if (currentStatus?.installed && !currentStatus.update_available) {
        setDownloadStage("launching");
        setDownloadProgress(100);
        setStatusMessage(`Launching ${product.name}...`);
        setLaunchOverlayProduct(product.name);
        await invoke("launch_product", {
          slug: product.slug,
          exePath: product.executablePath,
        });
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        setDownloadStage("ready");
        setStatusMessage("Launch command sent successfully.");
      } else {
        setDownloadStage("downloading");
        setDownloadProgress(0);
        setStatusMessage(
          currentStatus?.update_available ? `Updating ${product.name}...` : `Downloading ${product.name}...`,
        );
        setActiveSection("downloads");

        const status = await invoke<ProductStatus>("install_product", {
          slug: product.slug,
          url: product.archiveUrl,
          exePath: product.executablePath,
        });

        setProductStatuses((current) => ({
          ...current,
          [product.slug]: status,
        }));
        setDownloadStage("ready");
        setDownloadProgress(100);
        setStatusMessage(
          currentStatus?.update_available
            ? `Update completed. ${product.name} is ready.`
            : `Install completed. ${product.name} is ready.`,
        );
        setDownloadHistory((current) => [
          {
            id: `${product.slug}-${Date.now()}`,
            title: currentStatus?.update_available ? "Update completed" : "Install completed",
            detail: `${product.name} is ready to launch.`,
            tone: "success",
          },
          ...current,
        ]);
      }
    } catch (error) {
      const detail = String(error);
      setActiveSection("downloads");
      setDownloadStage("error");
      setErrorMessage(detail);
      setStatusMessage(currentStatus?.update_available ? `Unable to update ${product.name}.` : `Unable to install ${product.name}.`);
      setDownloadHistory((current) => [
        {
          id: `${product.slug}-error-${Date.now()}`,
          title: currentStatus?.update_available ? "Update failed" : "Download failed",
          detail: `${product.name}: ${detail}`,
          tone: "error",
        },
        ...current,
      ]);
    } finally {
      setLaunchOverlayProduct(null);
      setBusy(false);
    }
  }

  async function handleUninstallProduct(product: ProductDefinition) {
    setBusy(true);
    setErrorMessage("");
    setActiveProductSlug(product.slug);

    try {
      const status = await invoke<ProductStatus>("uninstall_product", {
        slug: product.slug,
        exePath: product.executablePath,
      });
      setProductStatuses((current) => ({
        ...current,
        [product.slug]: status,
      }));
      setDownloadStage("idle");
      setDownloadProgress(0);
      setStatusMessage("Product is available to install.");
      setSnackbar({
        visible: true,
        title: "App uninstalled",
        detail: `${product.name} was removed from this device.`,
      });
    } catch (error) {
      setSnackbar({
        visible: true,
        title: "Uninstall failed",
        detail: String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const matchesSearch = (product: ProductDefinition) =>
    normalizedSearchQuery.length === 0 ||
    `${product.name} ${product.description} ${product.eyebrow}`.toLowerCase().includes(normalizedSearchQuery);

  const installedProducts = products.filter((product) => productStatuses[product.slug]?.installed);
  const installableProducts = products.filter(
    (product) => !productStatuses[product.slug]?.installed,
  );
  const filteredInstalledProducts = installedProducts.filter(matchesSearch);
  const filteredInstallableProducts = installableProducts.filter(matchesSearch);
  const availableProductsCount = products.length;
  const installedProductsCount = installedProducts.length;
  const showActiveDownload =
    activeSection === "downloads" &&
    (busy || downloadStage === "downloading" || downloadStage === "installing" || downloadStage === "uninstalling");

  const updatesWaiting = products.filter(
    (product) => productStatuses[product.slug]?.update_available,
  ).length;

  /**
   * The dashboard figures, on the catalogue page only.
   *
   * Only `updatesWaiting` carries a tone, and only when it is non-zero: a pending
   * update is something the user has to act on, which amber honestly means. Installed
   * and available are plain facts and stay neutral — colouring them would imply that
   * more or fewer apps is better, which is not true.
   *
   * The Installed screen deliberately has no metric row. It is a launch list, and
   * repeating the catalogue's summary at the top of it would make the two screens look
   * like the same screen.
   */
  const showMetrics = activeSection === "all-apps";

  const activeCopy = sectionCopy[activeSection];

  if (!authReady) {
    return (
      <div className="app-canvas flex h-screen items-center justify-center text-ink">
        <div className="text-center">
          <div className="mx-auto h-5 w-5 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
          <p className="mt-4 text-[12px] text-ink-dim">Restoring session…</p>
        </div>
      </div>
    );
  }

  if (!authSession || !member) {
    return (
      <LoginScreen
        email={loginEmail}
        password={loginPassword}
        onEmailChange={setLoginEmail}
        onPasswordChange={setLoginPassword}
        onSubmit={() => void handleLogin()}
        loading={authLoading}
        error={authError}
      />
    );
  }

  return (
    <div className="app-canvas relative flex h-screen overflow-hidden text-ink">
      <div className="ambient-bloom" aria-hidden="true" />

      {/* ---- rail: full height, glass so the bloom reads through it -------- */}
      <aside className="rail relative z-10 flex w-[198px] shrink-0 flex-col">
        <div className="flex h-12 shrink-0 items-center px-3">
          <AproLogo />
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto scroll px-2 py-1">
          {NAV_GROUPS.map((group) => {
            const items = navItems.filter((item) => item.group === group);
            if (items.length === 0) return null;
            return (
              <div key={group} className="mb-1">
                <p className="label px-2.5 pb-1 pt-3">{group}</p>
                <div className="grid gap-0.5">
                  {items.map((item) => {
                    const isActive = item.id === activeSection;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setActiveSection(item.id)}
                        className={`nav-item ${isActive ? "nav-item-active" : ""}`}
                      >
                        <span className="nav-glyph">{item.icon}</span>
                        <span className="truncate">{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>

        <div className="shrink-0 px-2 pb-2">
          <div className="divider mb-2" />
          <button
            type="button"
            onClick={() => setActiveSection("settings")}
            className={`nav-item ${activeSection === "settings" ? "nav-item-active" : ""}`}
          >
            <span className="nav-glyph">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7">
                <path d="M10.5 3h3l.7 2.2a7.7 7.7 0 0 1 1.8.8l2.1-1.1 2.1 2.1-1.1 2.1c.3.6.6 1.2.8 1.8L21 12v3l-2.2.7c-.2.6-.5 1.2-.8 1.8l1.1 2.1-2.1 2.1-2.1-1.1c-.6.3-1.2.6-1.8.8L13.5 21h-3l-.7-2.2a7.7 7.7 0 0 1-1.8-.8l-2.1 1.1-2.1-2.1 1.1-2.1a7.7 7.7 0 0 1-.8-1.8L3 15v-3l2.2-.7c.2-.6.5-1.2.8-1.8L4.9 7.4 7 5.3l2.1 1.1c.6-.3 1.2-.6 1.8-.8L10.5 3Z" />
                <circle cx="12" cy="12" r="3.2" />
              </svg>
            </span>
            <span className="truncate">Settings</span>
          </button>

          <div className="mt-1 flex items-center gap-2.5 rounded-md px-2.5 py-2">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-raised text-[10px] font-semibold text-ink-dim">
              {initialsFromName(profileName)}
            </div>
            <div className="min-w-0">
              <p className="truncate text-[12px] font-medium leading-tight text-ink">{profileName}</p>
              <p className="truncate text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                {profileSubtitle}
              </p>
            </div>
          </div>
        </div>
      </aside>

      {/* ---- content column ------------------------------------------------ */}
      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        <header
          onMouseDown={handleTitlebarMouseDown}
          className="glass flex h-12 shrink-0 items-center gap-3 border-x-0 border-t-0 px-4"
        >
          <p className="shrink-0 text-[12px] text-ink-faint">
            <span className="text-ink-dim">APRO Works</span>
            <span className="mx-1.5 text-ink-faint/60">/</span>
            <span className="text-ink">{activeCopy.title}</span>
          </p>

          <div className="ml-auto flex min-w-0 items-center gap-2">
            {activeSection === "all-apps" || activeSection === "installed-apps" ? (
              <div className="hidden w-[240px] sm:block">
                <SearchField
                  value={searchQuery}
                  onChange={setSearchQuery}
                  placeholder={
                    activeSection === "all-apps" ? "Search workspaces…" : "Search installed…"
                  }
                />
              </div>
            ) : null}
            <WindowControls />
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto scroll">
          <div className="flex w-full flex-col gap-5 px-6 py-5">
            <SectionHeader
              title={activeCopy.title}
              subtitle={activeCopy.subtitle}
              actions={
                activeSection === "workflows" ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setWorkflowSync((token) => token + 1)}
                      title="Re-read the orchestration store"
                      className="btn btn-ghost"
                    >
                      Sync
                    </button>
                    <button
                      type="button"
                      onClick={() => setWorkflowReset((token) => token + 1)}
                      title="Reset the canvas to the default template"
                      className="btn btn-ghost"
                    >
                      Reset
                    </button>
                    <button
                      type="button"
                      onClick={() => setWorkflowConsole(true)}
                      className="btn btn-quiet"
                    >
                      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                        <rect x="3" y="4" width="18" height="16" rx="2.5" />
                        <path d="M7 9l3 3-3 3M12.5 15H17" />
                      </svg>
                      Console
                    </button>
                  </>
                ) : undefined
              }
            />

            {showMetrics ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <HeroMetric
                  className="rise lg:col-span-2"
                  label="Workspaces available"
                  value={availableProductsCount}
                  parts={[
                    { label: "Installed", value: installedProductsCount },
                    { label: "Updates", value: updatesWaiting },
                  ]}
                />
                <Metric className="rise" label="Installed on this machine" value={installedProductsCount} />
                <Metric
                  className="rise"
                  label="Updates waiting"
                  value={updatesWaiting}
                  hint={updatesWaiting > 0 ? "action needed" : "up to date"}
                  tone={updatesWaiting > 0 ? "warn" : undefined}
                />
              </div>
            ) : null}

            {activeSection === "all-apps" && (
              <>
                {/* ---- Manage: what is already on this machine ------------ */}
                <SubSection
                  title="Manage apps"
                  count={filteredInstalledProducts.length}
                  detail="installed on this machine"
                />
                {filteredInstalledProducts.length > 0 ? (
                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
                    {filteredInstalledProducts.map((product, index) => (
                      <ProductCard
                        key={product.slug}
                        index={index}
                        product={product}
                        installed
                        updateAvailable={Boolean(productStatuses[product.slug]?.update_available)}
                        busy={busy && activeProductSlug === product.slug}
                        onPrimaryAction={() => void handleProductAction(product)}
                        onSecondaryAction={() => void handleUninstallProduct(product)}
                      />
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title={
                      installedProducts.length > 0 ? "No match" : "Nothing installed yet"
                    }
                    detail={
                      installedProducts.length > 0
                        ? "The current filter does not match any installed workspace."
                        : "Install one from Installable apps below and it will appear here, with a Remove control."
                    }
                  />
                )}

                {/* ---- Installable: what could be added ------------------- */}
                <SubSection
                  title="Installable apps"
                  count={filteredInstallableProducts.length}
                  detail="published by APRO"
                />
                {filteredInstallableProducts.length > 0 ? (
                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
                    {filteredInstallableProducts.map((product, index) => (
                      <ProductCard
                        key={product.slug}
                        index={index}
                        product={product}
                        installed={false}
                        updateAvailable={false}
                        busy={busy && activeProductSlug === product.slug}
                        onPrimaryAction={() => void handleProductAction(product)}
                      />
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title={installedProducts.length > 0 ? "Everything is installed" : "No match"}
                    detail={
                      installedProducts.length > 0
                        ? "Every published workspace is already on this machine."
                        : "Try a different search term or clear the current filter."
                    }
                  />
                )}

                {/* ---- External: not available yet ----------------------- */}
                <SubSection title="External apps" detail="third-party, not yet available" />
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
                  <ExternalAppsCard />
                </div>
              </>
            )}

            {activeSection === "installed-apps" && (
              <>
                {filteredInstalledProducts.length > 0 ? (
                  <>
                    <SubSection
                      title="Ready to launch"
                      count={filteredInstalledProducts.length}
                      detail={
                        updatesWaiting > 0
                          ? `${updatesWaiting} update${updatesWaiting === 1 ? "" : "s"} available`
                          : "all up to date"
                      }
                    />
                    <ul className="flex flex-col gap-2">
                      {filteredInstalledProducts.map((product, index) => (
                        <InstalledRow
                          key={product.slug}
                          index={index}
                          product={product}
                          updateAvailable={Boolean(productStatuses[product.slug]?.update_available)}
                          busy={busy && activeProductSlug === product.slug}
                          onLaunch={() => void handleProductAction(product)}
                          onUpdate={() => void handleProductAction(product)}
                        />
                      ))}
                    </ul>
                  </>
                ) : installedProducts.length > 0 ? (
                  <EmptyState
                    title="No products found"
                    detail="The current filter does not match any installed workspace."
                  />
                ) : (
                  <EmptyState
                    title="Nothing installed yet"
                    detail="Open All Apps, install a workspace, and it will appear here ready to launch."
                  />
                )}
              </>
            )}

            {activeSection === "workflows" && (
              <WorkflowsPanel
                apps={products.map((product) => ({
                  slug: product.slug,
                  name: product.name,
                  installed: Boolean(productStatuses[product.slug]?.installed),
                  icon: product.iconImage,
                }))}
                syncToken={workflowSync}
                resetToken={workflowReset}
                consoleOpen={workflowConsole}
                onConsoleClose={() => setWorkflowConsole(false)}
                className="h-[calc(100vh-260px)] min-h-[440px]"
              />
            )}

            {activeSection === "downloads" && (
              <DownloadsPanel
                showActiveDownload={showActiveDownload}
                activeProductName={activeProduct?.name ?? "Product"}
                downloadStage={downloadStage}
                downloadProgress={downloadProgress}
                statusMessage={statusMessage}
                errorMessage={errorMessage}
                history={downloadHistory}
                onDismissHistory={(id) =>
                  setDownloadHistory((current) => current.filter((entry) => entry.id !== id))
                }
              />
            )}

            {activeSection === "settings" && (
              <SettingsPanel
                member={member}
                accentId={accentId}
                onAccentChange={handleAccentChange}
                onSignOut={() => void handleSignOut()}
                signingOut={signingOut}
              />
            )}
          </div>
        </main>
      </div>

      {launchOverlayProduct ? <LaunchOverlay productName={launchOverlayProduct} /> : null}

      {snackbar.visible ? (
        <div className="pointer-events-none fixed bottom-5 left-1/2 z-50 w-full max-w-[420px] -translate-x-1/2 px-4">
          <div className="card px-4 py-3">
            <p className="text-[12px] font-semibold text-ink">{snackbar.title}</p>
            <p className="mt-0.5 text-[12px] text-ink-dim">{snackbar.detail}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;

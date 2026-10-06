import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  PhysicalPosition,
  PhysicalSize,
  currentMonitor,
  getCurrentWindow,
} from "@tauri-apps/api/window";
import { supabase, supabaseConfigError } from "./lib/supabase";
import { WorkflowsPanel } from "./sections/WorkflowsPanel";
import { WorkspacesPanel } from "./sections/WorkspacesPanel";
import { AmbientDefence } from "./components/AmbientDefence";
import { useWorkspaceDirectory } from "./lib/use-workspaces";
import {
  ACCENTS,
  accentSwatch,
  applyAccent,
  loadAccentId,
  saveAccentId,
  type AccentId,
} from "./lib/theme";
import {
  cacheIsFresh,
  fetchUpdateStatus,
  formatCheckedAt,
  installUpdate,
  loadCachedUpdate,
  openReleasePage,
  saveCachedUpdate,
  type InstallProgress,
  type UpdateStatus,
} from "./lib/updates";
import logo from "../src-tauri/icons/icon.png";
import burnBackground from "./assets/burnAndGeometry.png";
import hexadofBackground from "./assets/hexadof.png";
import propulsorBackground from "./assets/propulsor.png";
import geometryIcon from "./assets/icons/GeometryModeler.png";
import hexadofIcon from "./assets/icons/HexadofForLight.png";
import propulsorIcon from "./assets/icons/PropulsorForLight.png";

type SectionId =
  | "installed-apps"
  | "all-apps"
  | "workflows"
  | "workspaces"
  | "downloads"
  | "settings";
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
   */
  iconImage?: string;
  /**
   * Optional artwork, used by the launch cards as a blurred backdrop.
   *
   * Products without it get the accent gradient instead — a card is better off
   * looking plainly unbranded than wearing a stock picture of something else.
   */
  backgroundImage?: string;
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
    backgroundImage: burnBackground,
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
    backgroundImage: propulsorBackground,
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
    backgroundImage: hexadofBackground,
    eyebrow: "Flight Dynamics",
  },
];

/** The display name for a slug, for progress events that arrive before any list does. */
function productNameFor(slug: string): string {
  return products.find((product) => product.slug === slug)?.name ?? slug;
}

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
    id: "workspaces",
    label: "Workspaces",
    group: "Orchestration",
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7">
        <path d="M3 8.5 12 4l9 4.5-9 4.5-9-4.5Z" />
        <path d="M6.5 11v4.6c0 1.4 2.5 2.4 5.5 2.4s5.5-1 5.5-2.4V11" />
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

/**
 * How many workspaces the rail lists before it stops and offers "More".
 *
 * A rail is a signpost, not a directory: past a handful of names it stops being
 * scannable and starts pushing the sections below it off screen. The homescreen
 * is where the full list belongs, and "More" goes there.
 */
const WORKSPACE_RAIL_LIMIT = 5;

/** The bullet in front of a workspace name in the rail. */
function RailBullet() {
  return (
    <span className="nav-glyph">
      <svg viewBox="0 0 8 8" className="h-1.5 w-1.5" aria-hidden="true">
        <circle cx="4" cy="4" r="3" fill="currentColor" />
      </svg>
    </span>
  );
}

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

/**
 * Page titles.
 *
 * Titles only. Every screen here used to carry a second line restating what the
 * screen obviously was — "apps present on this machine" under a heading called
 * Installed. That is text the user has already read by the time they arrive.
 */
const sectionCopy: Record<SectionId, { title: string }> = {
  "all-apps": { title: "All Apps" },
  "installed-apps": { title: "Installed" },
  workflows: { title: "Workflows" },
  workspaces: { title: "Workspaces" },
  downloads: { title: "Downloads" },
  settings: { title: "Settings" },
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

/**
 * Shown when the build carries no Supabase credentials.
 *
 * The interface is the only thing that can report this. The window is created hidden, so
 * a failure that stops React from mounting is a failure nobody can see; reading the
 * configuration as data instead of throwing during import is what makes this screen
 * reachable at all.
 *
 * The values cannot be supplied at runtime — Vite inlines them into the bundle at build
 * time — so the only remedy is a rebuild.
 */
function ConfigErrorScreen({ detail }: { detail: string }) {
  return (
    <div
      data-tauri-drag-region="deep"
      className="app-canvas relative flex h-screen items-center justify-center overflow-hidden px-6 text-ink"
    >
      <div className="ambient-bloom" aria-hidden="true" />

      <div className="absolute right-3 top-3 z-20">
        <WindowControls />
      </div>

      <div className="relative z-10 w-full max-w-[520px]">
        <div className="card p-5">
          <h1 className="text-[17px] font-semibold tracking-tight text-ink">Not configured</h1>
          <p className="mt-3 text-[12.5px] leading-5 text-ink-dim">{detail}</p>
          <p className="mt-3 text-[12px] leading-5 text-ink-faint">
            Copy <span className="mono text-ink-dim">.env.example</span> to{" "}
            <span className="mono text-ink-dim">.env</span> and fill it in, then rebuild.
          </p>
        </div>
      </div>
    </div>
  );
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
  /**
   * Local to the form, and deliberately so: it is view state that should reset every
   * time the screen is reached, not something the rest of the app has an opinion about.
   */
  const [showPassword, setShowPassword] = useState(false);

  return (
    /* The window has no decorations, so the sign-in screen needs its own drag region
       or the window cannot be moved at all before signing in. */
    <div
      data-tauri-drag-region="deep"
      className="app-canvas relative flex h-screen items-center justify-center overflow-hidden px-6 text-ink"
    >
      <div className="ambient-bloom" aria-hidden="true" />
      <AmbientDefence className="absolute inset-0 h-full w-full" />

      {/* The window has no decorations, so the chrome has to be supplied here as well.
          Without it the sign-in screen — the first thing anyone sees — cannot be closed
          or minimised, leaving Alt+F4 as the only way out. */}
      <div className="absolute right-3 top-3 z-20">
        <WindowControls />
      </div>

      <div className="relative z-10 w-full max-w-[380px]">
        <div className="mb-7 flex flex-col items-center">
          <img
            src={logo}
            alt=""
            className="h-24 w-24 object-contain drop-shadow-[0_10px_30px_var(--color-accent-glow)]"
          />
          {/* Tracking adds a trailing space after the last letter, which pushes centred
              text off-axis; the matching left margin puts it back. */}
          <p className="ml-[0.34em] mt-4 text-[13px] font-semibold uppercase tracking-[0.34em] text-ink">
            APRO Works
          </p>
        </div>

        <div className="card p-5">
          <h1 className="text-[19px] font-semibold tracking-tight text-ink">Sign in</h1>

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
              {/* The focus ring lives on the wrapper so it encloses the toggle too. */}
              <div className="field flex items-center gap-1 pr-1">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => onPasswordChange(event.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  className="w-full min-w-0 bg-transparent px-3 py-2.5 text-[13px] text-ink outline-none placeholder:text-ink-faint"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((shown) => !shown)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                  title={showPassword ? "Hide password" : "Show password"}
                  className="icon-btn shrink-0 text-ink-dim hover:text-ink"
                >
                  <svg
                    viewBox="0 0 24 24"
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    {showPassword ? (
                      <>
                        <path d="M3 3 21 21" />
                        <path d="M10.6 6.1A10 10 0 0 1 12 6c6 0 9.5 6 9.5 6a17.6 17.6 0 0 1-3.4 4" />
                        <path d="M6.4 7A17.4 17.4 0 0 0 2.5 12s3.5 6 9.5 6a9.9 9.9 0 0 0 3.6-.6" />
                        <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
                      </>
                    ) : (
                      <>
                        <path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
                        <circle cx="12" cy="12" r="3.2" />
                      </>
                    )}
                  </svg>
                </button>
              </div>
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
 * A hover popup.
 *
 * Not the `title` attribute: that is slow to appear, unstyled, and unreadable in a
 * screenshot. This is focusable too, so the explanation is reachable by keyboard.
 */
function Tip({ text, children }: { text: string; children: ReactNode }) {
  return (
    <span className="tip">
      {children}
      <span role="tooltip" className="tip-bubble">
        {text}
      </span>
    </span>
  );
}

/**
 * The catalogue counts, as one compact bar of icon + number.
 *
 * Colour is still reserved for the one figure that is genuinely actionable: a waiting
 * update. A count of artifacts or apps is not good or bad, so it stays ink.
 */
function MetricBar({
  available,
  installed,
  updates,
}: {
  available: number;
  installed: number;
  updates: number;
}) {
  const items = [
    {
      key: "available",
      value: available,
      tone: "text-ink-dim",
      explain: "Apps APRO publishes and this hub knows how to install.",
      icon: (
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z" />
          <path d="M4 7.5 12 12l8-4.5M12 12v9" />
        </svg>
      ),
    },
    {
      key: "installed",
      value: installed,
      tone: "text-ink-dim",
      explain: "Apps already present on this machine, ready to launch.",
      icon: (
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M5 12.5 9.5 17 19 7" />
        </svg>
      ),
    },
    {
      key: "updates",
      value: updates,
      tone: updates > 0 ? "text-warn" : "text-ink-dim",
      explain:
        updates > 0
          ? "Updates have been published since this machine last installed. Installing will fetch the newer build."
          : "Everything installed matches the latest published build.",
      icon: (
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M20 11a8 8 0 1 0-2.3 5.7" />
          <path d="M20 5v6h-6" />
        </svg>
      ),
    },
  ];

  return (
    <div className="glass flex shrink-0 items-center gap-0.5 rounded-pill p-1">
      {items.map((item) => (
        <Tip key={item.key} text={item.explain}>
          <span className="flex cursor-default items-center gap-1.5 rounded-pill px-2.5 py-1 transition hover:bg-raised">
            <span className={item.tone}>{item.icon}</span>
            <span className={`mono text-[12px] font-semibold ${item.tone}`}>{item.value}</span>
          </span>
        </Tip>
      ))}
    </div>
  );
}

function SectionHeader({
  title,
  actions,
}: {
  title: string;
  /** Section-specific controls, aligned to the title's baseline. */
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-[19px] font-semibold tracking-tight text-ink">{title}</h1>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/**
 * An app that is not installed yet.
 *
 * No status pill: this list only ever contains installable apps, so a pill reading
 * "Available" on every one of them is a word the user has already inferred from the
 * heading above it.
 */
function InstallableCard({
  product,
  busy,
  onInstall,
  index,
}: {
  product: ProductDefinition;
  busy: boolean;
  onInstall: () => void;
  /** Position in its grid, used only to stagger the entrance. */
  index?: number;
}) {
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
          <h3 className="truncate text-[14px] font-semibold leading-tight tracking-tight text-ink">
            {product.name}
          </h3>
          <p className="mt-0.5 text-[11px] text-ink-faint">{product.eyebrow}</p>
        </div>
      </div>

      <p className="mt-3 flex-1 text-[12px] leading-5 text-ink-dim">{product.description}</p>

      <button
        type="button"
        onClick={onInstall}
        disabled={busy}
        className="btn btn-quiet glow-swipe mt-4 w-full"
      >
        {busy ? "Installing…" : "Install"}
      </button>
    </article>
  );
}

/** A labelled heading inside a page, so one screen can hold several groups. */
function SubSection({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-baseline gap-2.5">
      <h2 className="text-[13px] font-semibold tracking-tight text-ink">{title}</h2>
      {count !== undefined ? <span className="pill">{count}</span> : null}
    </div>
  );
}

/**
 * One workspace, as a row.
 *
 * Shared by Manage apps and Installed so the two lists read identically; only the
 * trailing controls differ, and those are passed in. Removing an app is a catalogue
 * action, so it appears in Manage and never on the launch list.
 */
function AppRow({
  product,
  index,
  status,
  trailing,
}: {
  product: ProductDefinition;
  index: number;
  status?: ReactNode;
  trailing: ReactNode;
}) {
  return (
    <li
      className="card rise flex items-center gap-3.5 px-4 py-3"
      style={{ animationDelay: `${index * 40}ms` }}
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
          {status}
        </div>
        <p className="truncate text-[11px] text-ink-faint">{product.eyebrow}</p>
      </div>

      <div className="flex shrink-0 items-center gap-2">{trailing}</div>
    </li>
  );
}

/**
 * A launch card: the product's own artwork, blurred, behind accent-tinted glass.
 *
 * This is the one screen that earns a large card. It is the moment before starting
 * work, so the cards are allowed to be identifiable at a glance rather than
 * uniform — the same reasoning the catalogue uses for rows.
 *
 * The icon is centred rather than inline with the name: at this size it is the thing
 * the eye lands on, and centring it gives every card the same anchor whatever length
 * the product's name happens to be.
 */
function LaunchCard({
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
    <article
      className="card-art card-art rise flex min-h-[244px] flex-col p-4"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      {product.backgroundImage ? (
        <div
          className="card-art-image"
          style={{ backgroundImage: `url(${product.backgroundImage})` }}
        />
      ) : null}
      <div className="card-art-wash" />
      <div className="card-art-scrim" />

      <div className="relative flex flex-1 flex-col items-center justify-center gap-4 px-2">
        <div className="flex h-24 w-24 items-center justify-center">
          {product.iconImage ? (
            <img
              src={product.iconImage}
              alt=""
              className="h-full w-full object-contain drop-shadow-lg"
            />
          ) : (
            <span className="text-[40px] font-semibold tracking-tight text-ink-dim drop-shadow-lg">
              {initialsFromName(product.name)}
            </span>
          )}
        </div>

        <div className="text-center">
          <h3 className="truncate text-[15px] font-semibold tracking-tight text-ink drop-shadow-sm">
            {product.name}
          </h3>
          <p className="mt-1 truncate text-[11px] text-ink-dim">{product.eyebrow}</p>
        </div>
      </div>

      <div className="relative flex items-center justify-end gap-2">
        {updateAvailable ? (
          <button type="button" onClick={onUpdate} disabled={busy} className="btn btn-quiet">
            {busy ? "Updating…" : "Update"}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onLaunch}
          disabled={busy}
          aria-label={`Launch ${product.name}`}
          title={`Launch ${product.name}`}
          className="btn-play glow-swipe"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-4 w-4 shrink-0 translate-x-[1px]"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M8 5.5v13l11-6.5-11-6.5Z" />
          </svg>
          <span className="btn-play-label">{busy ? "Starting…" : "Launch"}</span>
        </button>
      </div>
    </article>
  );
}

/**
 * The external-apps placeholder: a header and nothing else.
 *
 * There are no external apps, so this states that rather than filling the grid with
 * invented ones. A card full of fictional products would be the most misleading thing
 * on the screen.
 */
function ExternalAppsCard() {
  return (
    <div className="card-dashed rise flex min-h-[132px] items-center justify-center sm:col-span-2 lg:col-span-3">
      <span className="text-[13px] font-semibold tracking-tight text-ink-dim">Coming soon</span>
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
      </div>
    </div>
  );
}

function EmptyState({ title }: { title: string }) {
  return (
    <div className="card-dashed flex min-h-[140px] items-center justify-center px-6 py-8">
      <p className="text-[13px] font-semibold tracking-tight text-ink-dim">{title}</p>
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

/**
 * One product transfer in flight.
 *
 * Keyed by slug in the map below, because installs of different products run
 * concurrently and each needs its own progress. There used to be a single slot for
 * stage, progress and message, which meant two installs overwrote each other on every
 * event and the panel flickered between them.
 */
type Transfer = {
  slug: string;
  name: string;
  stage: DownloadStage;
  progress: number;
  message: string;
  error?: string;
};

/** Stages where work is still happening. Anything else is finished. */
const ACTIVE_STAGES: readonly DownloadStage[] = [
  "checking",
  "downloading",
  "installing",
  "launching",
  "uninstalling",
];

function isActiveTransfer(transfer: Transfer | undefined): boolean {
  return transfer !== undefined && ACTIVE_STAGES.includes(transfer.stage);
}

function DownloadsPanel({
  transfers,
  history,
  onDismissHistory,
}: {
  /** Everything currently in flight, in whatever order it started. */
  transfers: Transfer[];
  history: DownloadHistoryItem[];
  onDismissHistory: (id: string) => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      {transfers.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {transfers.map((transfer, index) => (
            <li
              key={transfer.slug}
              className="card rise p-4"
              style={{ animationDelay: `${index * 40}ms` }}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="label">{stageLabels[transfer.stage]}</p>
                  <h3 className="mt-1.5 truncate text-[15px] font-semibold tracking-tight text-ink">
                    {transfer.name}
                  </h3>
                </div>
                <span className="mono shrink-0 text-[12px] text-ink-dim">{transfer.progress}%</span>
              </div>

              <div className="progress-track mt-3 h-1.5">
                <div className="progress-fill h-full" style={{ width: `${transfer.progress}%` }} />
              </div>

              <p className="mt-2 text-[12px] leading-5 text-ink-dim">{transfer.message}</p>
              {transfer.error ? <p className="mt-1 text-[12px] text-bad">{transfer.error}</p> : null}
            </li>
          ))}
        </ul>
      ) : (
        <div className="card p-4">
          <h3 className="text-[14px] font-semibold tracking-tight text-ink">No downloads</h3>
        </div>
      )}

      {history.length > 0 ? (
        <div className="card p-4">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-[14px] font-semibold tracking-tight text-ink">Recent</h3>
            <span className="pill">{history.length}</span>
          </div>
          <div className="mt-3 space-y-2">
            {history.map((item) => (
              <DownloadHistoryCard
                key={item.id}
                item={item}
                onDismiss={() => onDismissHistory(item.id)}
              />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Update status and the manual check.
 *
 * The automatic check is silent by design, so this is where a user can see when it
 * last ran and force one. It is also the only place a failure is reported: the user
 * asked, so silence would be wrong here.
 */
function UpdateSettings({
  status,
  checkedAt,
  checking,
  error,
  onCheck,
  onOpenRelease,
  onInstall,
  installing,
  progress,
  installError,
}: {
  status: UpdateStatus | null;
  checkedAt: number | null;
  checking: boolean;
  error: string | null;
  onCheck: () => void;
  onOpenRelease: () => void;
  onInstall: () => void;
  installing: boolean;
  progress: InstallProgress | null;
  installError: string | null;
}) {
  const available = status?.available === true;
  const percent =
    progress && progress.total
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="label">Updates</p>
        {available ? (
          <span className="pill pill-accent">Update available</span>
        ) : status ? (
          <span className="pill pill-fresh">Up to date</span>
        ) : null}
      </div>

      <h3 className="mt-2 flex items-baseline gap-2 text-[15px] font-semibold tracking-tight text-ink">
        APRO Works
        <span className="mono text-[13px] font-normal text-ink-dim">
          {status?.current ?? "…"}
        </span>
      </h3>

      <p className="mt-2 max-w-[60ch] text-[12px] leading-5 text-ink-dim">
        {error ?? status?.detail ?? "Checking for a newer release…"}
      </p>

      {available && status?.notes ? (
        <pre className="well mt-3 max-h-[168px] overflow-y-auto scroll whitespace-pre-wrap px-3 py-2.5 font-sans text-[11.5px] leading-5 text-ink-dim">
          {status.notes}
        </pre>
      ) : null}

      {installing ? (
        <div className="mt-4">
          <div className="progress-track h-1.5">
            <div className="progress-fill h-full" style={{ width: `${percent ?? 12}%` }} />
          </div>
          <p className="mt-2 text-[11.5px] leading-5 text-ink-dim">
            {percent === null
              ? "Downloading the update…"
              : `${percent}% downloaded. APRO Works closes and restarts to finish.`}
          </p>
        </div>
      ) : null}

      {installError ? (
        <div className="mt-3 rounded-md border border-bad/30 bg-bad/10 px-3 py-2.5 text-[12px] leading-5 text-ink">
          {installError}
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onCheck}
          disabled={checking || installing}
          className="btn btn-quiet glow-swipe"
        >
          {checking ? "Checking…" : "Check now"}
        </button>
        {available ? (
          <button
            type="button"
            onClick={onInstall}
            disabled={installing}
            className="btn btn-primary glow-swipe"
          >
            {installing ? "Installing…" : `Install ${status?.latest ?? "update"}`}
          </button>
        ) : null}
        <button type="button" onClick={onOpenRelease} className="btn btn-ghost">
          Release notes
        </button>
      </div>

      <p className="mt-3 text-[11px] text-ink-faint">{formatCheckedAt(checkedAt)}</p>
    </div>
  );
}

function SettingsPanel({
  member,
  accentId,
  onAccentChange,
  update,
  updateCheckedAt,
  updateChecking,
  updateError,
  onCheckForUpdate,
  onOpenRelease,
  onInstallUpdate,
  updateInstalling,
  updateProgress,
  updateInstallError,
  onSignOut,
  signingOut,
}: {
  member: MemberRecord;
  accentId: AccentId;
  onAccentChange: (id: AccentId) => void;
  update: UpdateStatus | null;
  updateCheckedAt: number | null;
  updateChecking: boolean;
  updateError: string | null;
  onCheckForUpdate: () => void;
  onOpenRelease: () => void;
  onInstallUpdate: () => void;
  updateInstalling: boolean;
  updateProgress: InstallProgress | null;
  updateInstallError: string | null;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  return (
    <section className="flex max-w-[720px] flex-col gap-3">
      <div className="card p-4">
        <p className="label">Accent</p>

        <div className="mt-3 flex flex-wrap gap-2" role="radiogroup" aria-label="Accent colour">
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
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="pill">{member.account_status}</span>
          <span className="text-[11px] text-ink-faint">{member.email ?? "No email available"}</span>
        </div>
        <button type="button" onClick={onSignOut} disabled={signingOut} className="btn btn-ghost mt-4">
          {signingOut ? "Signing out…" : "Sign Out"}
        </button>
      </div>

      <UpdateSettings
        status={update}
        checkedAt={updateCheckedAt}
        checking={updateChecking}
        error={updateError}
        onCheck={() => void onCheckForUpdate()}
        onOpenRelease={onOpenRelease}
        onInstall={onInstallUpdate}
        installing={updateInstalling}
        progress={updateProgress}
        installError={updateInstallError}
      />
    </section>
  );
}

function App() {
  const [authReady, setAuthReady] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authSession, setAuthSession] = useState<Session | null>(null);
  const [member, setMember] = useState<MemberRecord | null>(null);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const [accentId, setAccentId] = useState<AccentId>(() => loadAccentId());
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [updateCheckedAt, setUpdateCheckedAt] = useState<number | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  // Separate from the check above: installing is a different operation with a different
  // failure mode, and conflating them would let a failed download read as a failed check.
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<InstallProgress | null>(null);
  const [updateInstallError, setUpdateInstallError] = useState<string | null>(null);
  // Installed first: the common case is starting work, not shopping for software.
  const [activeSection, setActiveSection] = useState<SectionId>("installed-apps");
  const [searchQuery, setSearchQuery] = useState("");
  const [productStatuses, setProductStatuses] = useState<Record<string, ProductStatus>>({});
  /**
   * Transfers, keyed by product slug.
   *
   * A map rather than a single slot: installs of different products run at the same
   * time, and each one's progress has to survive the other's events. With one slot the
   * panel alternated between two downloads on every event.
   */
  const [transfers, setTransfers] = useState<Record<string, Transfer>>({});
  const [downloadHistory, setDownloadHistory] = useState<DownloadHistoryItem[]>([]);
  const [launchOverlayProduct, setLaunchOverlayProduct] = useState<string | null>(null);
  // The Workflows tab's buttons live in the section header, so their state lives here.
  const [workflowSync, setWorkflowSync] = useState(0);
  const [workflowReset, setWorkflowReset] = useState(0);
  const [workflowConsole, setWorkflowConsole] = useState(false);
  /**
   * Workspaces.
   *
   * The directory is loaded here rather than inside the panel because the rail
   * lists the workspaces too, and two loaders would let the sidebar disagree
   * with the cards beside it. `activeWorkspaceId` lives here for the same
   * reason: the rail's hierarchy navigates it.
   */
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const workspaceDirectory = useWorkspaceDirectory();
  const [snackbar, setSnackbar] = useState<SnackbarState>({
    visible: false,
    title: "",
    detail: "",
  });

  /**
   * Reveal the window once the interface is mounted.
   *
   * The window is created hidden (`tauri.conf.json` → `visible: false`) so the first
   * frame paints before it appears, rather than flashing white over the desktop.
   *
   * This deliberately does NOT live in `WindowControls`. That component only renders
   * inside the signed-in shell, so showing the window from there leaves a fresh profile
   * — empty session, therefore the login screen — with a window that is never revealed
   * at all. The user cannot see the login screen they would have to sign in from, and
   * nothing reports the failure, because every window call swallows its error.
   */
  useEffect(() => {
    void (async () => {
      try {
        await getCurrentWindow().show();
      } catch {
        // Browser preview: there is no Tauri window to reveal.
      }
    })();
  }, []);

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

  /**
   * Read what is installed.
   *
   * This used to drive the download panel's stage and message, which conflated "we are
   * looking at the disk" with "something is transferring". A failure is a snackbar,
   * because it is not a transfer and does not belong in the transfers list.
   */
  async function refreshProductStatuses() {
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
    } catch (error) {
      setSnackbar({
        visible: true,
        title: "Could not read install state",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  useEffect(() => {
    let mounted = true;

    async function initializeAuth() {
      // Nothing to restore and nobody to sign in as: this build shows the configuration
      // screen, so do not spend a request on the placeholder client.
      if (supabaseConfigError) {
        setAuthReady(true);
        return;
      }

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

  /**
   * Check for a newer release once per launch.
   *
   * A stored answer is shown straight away and the network is only consulted when that
   * answer is old, so the sidebar card is right immediately rather than appearing a
   * second after the window opens.
   *
   * A failed check is swallowed. Being offline is not something to interrupt anyone
   * about, and whatever was cached stays on screen; the manual check in Settings is
   * where a failure is actually reported, because there the user asked for it.
   */
  useEffect(() => {
    let cancelled = false;
    const cached = loadCachedUpdate();

    if (cached) {
      setUpdate(cached.status);
      setUpdateCheckedAt(cached.at);
    }
    if (cacheIsFresh(cached)) return;

    void (async () => {
      try {
        const fresh = await fetchUpdateStatus();
        if (cancelled) return;
        setUpdate(fresh);
        setUpdateCheckedAt(saveCachedUpdate(fresh).at);
      } catch {
        // Offline, rate-limited, or no releases yet. Nothing to say.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /** The explicit check, which always asks and always reports what happened. */
  async function handleCheckForUpdate() {
    setUpdateChecking(true);
    setUpdateError(null);
    try {
      const fresh = await fetchUpdateStatus();
      setUpdate(fresh);
      setUpdateCheckedAt(saveCachedUpdate(fresh).at);
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : String(error));
    } finally {
      setUpdateChecking(false);
    }
  }

  /**
   * Download and install the release that the check reported.
   *
   * The check above decides whether to *offer* an update; the updater plugin decides
   * whether one can be *installed*. They can disagree — the GitHub API knows a release
   * exists, only `latest.json` says it carries something installable — so this reports
   * what the install path actually said instead of trusting the earlier answer.
   */
  async function handleInstallUpdate() {
    setUpdateInstalling(true);
    setUpdateInstallError(null);
    setUpdateProgress(null);

    try {
      await installUpdate(setUpdateProgress);
      // Windows exits the process partway through the install, so arriving here means
      // this platform did not: the update is on disk and only a restart is left.
      setSnackbar({
        visible: true,
        title: "Update installed",
        detail: "Restart APRO Works to finish.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setUpdateInstallError(message);
      // The rail card is the likely entry point, and it is not the Settings panel, so
      // without this the failure would only be visible on a screen the user is not on.
      setSnackbar({ visible: true, title: "Update failed", detail: message });
    } finally {
      setUpdateInstalling(false);
    }
  }

  function handleAccentChange(id: AccentId) {
    setAccentId(id);
    saveAccentId(id);
  }

  // Leaving the panel clears the log and drops finished transfers, so coming back shows
  // only what is still running. In-flight ones are kept — they are still happening, and
  // discarding them would strand a running install with nowhere to report.
  useEffect(() => {
    if (activeSection === "downloads") return;
    setDownloadHistory([]);
    setTransfers((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([, transfer]) => isActiveTransfer(transfer)),
      ),
    );
  }, [activeSection]);

  useEffect(() => {
    if (!snackbar.visible) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setSnackbar((current) => ({ ...current, visible: false }));
    }, 3200);

    return () => window.clearTimeout(timeout);
  }, [snackbar.visible, snackbar.title, snackbar.detail]);

  /**
   * One event handler for every product. The payload carries the slug, so each
   * transfer is updated in its own slot.
   */
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    void getCurrentWindow()
      .listen<ProductProgressPayload>("product-progress", (event) => {
        const { slug, phase, progress, message } = event.payload;
        setTransfers((current) => ({
          ...current,
          [slug]: {
            slug,
            name: current[slug]?.name ?? productNameFor(slug),
            stage: phase as DownloadStage,
            progress,
            message,
            error: phase === "error" ? message : undefined,
          },
        }));
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
      setActiveSection("installed-apps");
      setLoginPassword("");
    } finally {
      setSigningOut(false);
    }
  }

  /**
   * Start a transfer for one product.
   *
   * Only this product's slot is touched, so a second install running alongside is
   * unaffected. There is no global "busy": a per-product flag derived from the
   * transfers map is what disables the right buttons, and it used to be a single
   * boolean that the first install to finish would clear for everyone.
   */
  function beginTransfer(product: ProductDefinition, stage: DownloadStage, message: string) {
    setTransfers((current) => ({
      ...current,
      [product.slug]: {
        slug: product.slug,
        name: product.name,
        stage,
        progress: 0,
        message,
      },
    }));
  }

  /**
   * Launch an installed app on behalf of a workspace.
   *
   * Deliberately not `handleProductAction`: that one routes through the
   * Downloads panel and may have to download first, and a click inside a
   * workspace that swapped the whole section out from under a collaborator
   * would be disorienting. A workspace only offers apps that are already
   * installed, so this is the launch half on its own.
   *
   * Failure is a snackbar rather than a thrown error: the presence announcement
   * has already been made by the caller, and the other person seeing "Prem is
   * using this application" while Prem's launch failed is a state worth
   * reporting, not one worth unwinding.
   */
  async function launchWorkspaceApp(slug: string) {
    const product = products.find((candidate) => candidate.slug === slug);
    if (!product) {
      setSnackbar({
        visible: true,
        title: "Unknown application",
        detail: "This workspace references an application this build does not know about.",
      });
      return;
    }

    try {
      setLaunchOverlayProduct(product.name);
      await invoke("launch_product", {
        slug: product.slug,
        exePath: product.executablePath,
      });
      await new Promise((resolve) => window.setTimeout(resolve, 900));
      setSnackbar({
        visible: true,
        title: `${product.name} launched`,
        detail: "Everyone else in the workspace can see that you are in it.",
      });
    } catch (failure) {
      setSnackbar({
        visible: true,
        title: `Could not launch ${product.name}`,
        detail: failure instanceof Error ? failure.message : String(failure),
      });
    } finally {
      setLaunchOverlayProduct(null);
    }
  }

  async function handleProductAction(product: ProductDefinition) {
    const currentStatus = productStatuses[product.slug];
    setActiveSection("downloads");

    try {
      if (currentStatus?.installed && !currentStatus.update_available) {
        beginTransfer(product, "launching", `Launching ${product.name}…`);
        setLaunchOverlayProduct(product.name);
        await invoke("launch_product", {
          slug: product.slug,
          exePath: product.executablePath,
        });
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        setTransfers((current) => ({
          ...current,
          [product.slug]: {
            ...current[product.slug],
            stage: "ready",
            progress: 100,
            message: "Launch command sent.",
          },
        }));
      } else {
        beginTransfer(
          product,
          "downloading",
          currentStatus?.update_available
            ? `Updating ${product.name}…`
            : `Downloading ${product.name}…`,
        );

        const status = await invoke<ProductStatus>("install_product", {
          slug: product.slug,
          url: product.archiveUrl,
          exePath: product.executablePath,
        });

        setProductStatuses((current) => ({
          ...current,
          [product.slug]: status,
        }));
        setTransfers((current) => ({
          ...current,
          [product.slug]: {
            ...current[product.slug],
            stage: "ready",
            progress: 100,
            message: currentStatus?.update_available
              ? "Update completed."
              : "Install completed.",
          },
        }));
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
      const detail = error instanceof Error ? error.message : String(error);
      setTransfers((current) => ({
        ...current,
        [product.slug]: {
          ...current[product.slug],
          slug: product.slug,
          name: product.name,
          stage: "error",
          progress: current[product.slug]?.progress ?? 0,
          message: currentStatus?.update_available
            ? `Unable to update ${product.name}.`
            : `Unable to install ${product.name}.`,
          error: detail,
        },
      }));
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
    }
  }

  async function handleUninstallProduct(product: ProductDefinition) {
    beginTransfer(product, "uninstalling", `Removing ${product.name}…`);

    try {
      const status = await invoke<ProductStatus>("uninstall_product", {
        slug: product.slug,
        exePath: product.executablePath,
      });
      setProductStatuses((current) => ({
        ...current,
        [product.slug]: status,
      }));
      setTransfers((current) => {
        const next = { ...current };
        delete next[product.slug];
        return next;
      });
      setSnackbar({
        visible: true,
        title: "App uninstalled",
        detail: `${product.name} was removed from this device.`,
      });
    } catch (error) {
      setTransfers((current) => ({
        ...current,
        [product.slug]: {
          ...current[product.slug],
          slug: product.slug,
          name: product.name,
          stage: "error",
          progress: 0,
          message: `Unable to remove ${product.name}.`,
          error: error instanceof Error ? error.message : String(error),
        },
      }));
      setSnackbar({
        visible: true,
        title: "Uninstall failed",
        detail: error instanceof Error ? error.message : String(error),
      });
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

  /**
   * Everything in flight, and the set of slugs that are busy.
   *
   * Derived from the transfers map rather than stored, so there is one source of truth:
   * a product is busy exactly when it has an active transfer. Previously a single
   * `busy` boolean was set by whichever install started last and cleared by whichever
   * finished first, which is why a second install freed the first one's button.
   */
  const activeTransfers = useMemo(
    () => Object.values(transfers).filter(isActiveTransfer),
    [transfers],
  );
  const busySlugs = useMemo(
    () => new Set(activeTransfers.map((transfer) => transfer.slug)),
    [activeTransfers],
  );

  const updatesWaiting = products.filter(
    (product) => productStatuses[product.slug]?.update_available,
  ).length;

  /**
   * Where the counts bar appears.
   *
   * Only on the two app screens. It is compact enough to sit alongside the title
   * without stealing attention, and on Installed the pending-update figure is the one
   * thing worth knowing before picking a card.
   *
   * Only `updates` carries a tone, and only when non-zero: a waiting update is
   * something the user has to act on. Available and installed are plain facts —
   * colouring them would imply more or fewer apps is better, which is not true.
   */
  const showMetrics = activeSection === "all-apps" || activeSection === "installed-apps";

  const activeCopy = sectionCopy[activeSection];

  if (supabaseConfigError) {
    return <ConfigErrorScreen detail={supabaseConfigError} />;
  }

  if (!authReady) {
    return (
      <div
        data-tauri-drag-region="deep"
        className="app-canvas relative flex h-screen items-center justify-center text-ink"
      >
        <div className="absolute right-3 top-3 z-20">
          <WindowControls />
        </div>
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
                    const railWorkspaces = workspaceDirectory.workspaces;

                    return (
                      <div key={item.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setActiveSection(item.id);
                            // The section itself is the homescreen; opening it
                            // should not leave a workspace from last time open.
                            if (item.id === "workspaces") setActiveWorkspaceId(null);
                          }}
                          className={`nav-item ${isActive ? "nav-item-active" : ""}`}
                        >
                          <span className="nav-glyph">{item.icon}</span>
                          <span className="truncate">{item.label}</span>
                        </button>

                        {/* The workspaces, as a hierarchy under their section. */}
                        {item.id === "workspaces" && railWorkspaces.length > 0 ? (
                          <div className="mt-0.5 grid gap-0.5 pl-3">
                            {railWorkspaces.slice(0, WORKSPACE_RAIL_LIMIT).map((workspace) => {
                              const isOpen =
                                isActive && activeWorkspaceId === workspace.id;
                              return (
                                <button
                                  key={workspace.id}
                                  type="button"
                                  title={workspace.name}
                                  onClick={() => {
                                    setActiveSection("workspaces");
                                    setActiveWorkspaceId(workspace.id);
                                  }}
                                  className={`nav-item py-1 text-[12px] ${
                                    isOpen ? "nav-item-active" : ""
                                  }`}
                                >
                                  <RailBullet />
                                  <span className="truncate">{workspace.name}</span>
                                </button>
                              );
                            })}

                            {railWorkspaces.length > WORKSPACE_RAIL_LIMIT ? (
                              <button
                                type="button"
                                title="See every workspace"
                                onClick={() => {
                                  setActiveSection("workspaces");
                                  setActiveWorkspaceId(null);
                                }}
                                className="nav-item py-1 text-[12px]"
                              >
                                <span className="nav-glyph">
                                  <svg
                                    viewBox="0 0 12 12"
                                    className="h-3 w-3"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.6"
                                    aria-hidden="true"
                                  >
                                    <path d="M3 5l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
                                  </svg>
                                </span>
                                <span className="truncate">
                                  More
                                  <span className="text-ink-faint">
                                    {" "}
                                    ({railWorkspaces.length - WORKSPACE_RAIL_LIMIT})
                                  </span>
                                </span>
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>

        <div className="shrink-0 px-2 pb-2">
          {/* An available release sits above everything else in the rail: it is the one
              item here that is time-sensitive, and it disappears once installed. */}
          {update?.available ? (
            <button
              type="button"
              onClick={() => void handleInstallUpdate()}
              disabled={updateInstalling}
              title={update.detail}
              className="card card-interactive glow-swipe mb-2 flex w-full flex-col items-start gap-1.5 border-accent/40 bg-accent-soft px-2.5 py-2.5 text-left"
            >
              <span className="pill pill-accent">
                <span className="pill-dot" />
                {updateInstalling ? "Installing" : "Update"}
              </span>
              <span className="text-[12px] font-semibold text-ink">
                APRO Works {update.latest}
              </span>
              <span className="text-[10px] text-ink-dim">
                {updateInstalling ? "Downloading…" : "Click to install"}
              </span>
            </button>
          ) : null}

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
          /*
           * Dragging and double-click-to-maximize are handled by Tauri itself. It
           * injects a listener that starts a caption drag on mousedown and calls
           * `internal_toggle_maximize` when the click count reaches two, and it
           * ignores clicks that land on buttons, inputs and labels — so the search
           * field and the window controls keep working.
           *
           * `deep` rather than a bare attribute: without it only direct hits on this
           * element drag, and the breadcrumb text inside would not.
           *
           * This replaced a hand-written mousedown handler. That handler awaited
           * `isMaximized()` before calling `startDragging()`, which broke the
           * synchronous caption handoff Windows needs — the drag started late, and the
           * double-click could never be recognised as a caption double-click.
           */
          data-tauri-drag-region="deep"
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
                    activeSection === "all-apps" ? "Search apps…" : "Search installed…"
                  }
                />
              </div>
            ) : null}
            <WindowControls />
          </div>
        </header>

        <main className="flex min-h-0 flex-1 flex-col">
          {/*
           * Two layouts, because the screens want different things. Most sections are
           * a stack of cards of their own height, so the container scrolls. Workflows
           * is a canvas that should fill whatever is left — pinning it to a
           * `calc(100vh - N)` guess left a strip of dead space at the bottom and
           * broke as soon as the header changed size. Workspaces fills too, because
           * the homescreen and the workspace scroll independently of each other and
           * the cursor layer has to be sized to the surface, not to the content.
           */}
          <div
            className={`flex min-h-0 flex-1 flex-col gap-5 px-6 py-5 ${
              activeSection === "workflows" || activeSection === "workspaces"
                ? ""
                : "scroll overflow-y-auto"
            }`}
          >
            <SectionHeader
              title={activeCopy.title}
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
                ) : activeSection === "workspaces" ? (
                  <button
                    type="button"
                    onClick={workspaceDirectory.reload}
                    disabled={workspaceDirectory.loading}
                    title="Re-read your workspaces and invitations"
                    className="btn btn-ghost"
                  >
                    Refresh
                  </button>
                ) : showMetrics ? (
                  <MetricBar
                    available={availableProductsCount}
                    installed={installedProductsCount}
                    updates={updatesWaiting}
                  />
                ) : undefined
              }
            />

            {activeSection === "all-apps" && (
              <>
                {/* ---- Manage: what is already on this machine ------------ */}
                <SubSection title="Manage apps" count={filteredInstalledProducts.length} />
                {filteredInstalledProducts.length > 0 ? (
                  <ul className="flex flex-col gap-2">
                    {filteredInstalledProducts.map((product, index) => {
                      const updateAvailable = Boolean(
                        productStatuses[product.slug]?.update_available,
                      );
                      return (
                        <AppRow
                          key={product.slug}
                          index={index}
                          product={product}
                          status={updateAvailable ? <span className="pill pill-accent">Update</span> : null}
                          trailing={
                            <>
                              {updateAvailable ? (
                                <button
                                  type="button"
                                  onClick={() => void handleProductAction(product)}
                                  disabled={busySlugs.has(product.slug)}
                                  className="btn btn-quiet"
                                >
                                  Update
                                </button>
                              ) : null}
                              <button
                                type="button"
                                onClick={() => void handleUninstallProduct(product)}
                                disabled={busySlugs.has(product.slug)}
                                className="btn btn-danger"
                              >
                                Remove
                              </button>
                            </>
                          }
                        />
                      );
                    })}
                  </ul>
                ) : (
                  <EmptyState
                    title={installedProducts.length > 0 ? "No match" : "Nothing installed"}
                  />
                )}

                {/* ---- Installable: what could be added ------------------- */}
                <SubSection title="Installable apps" count={filteredInstallableProducts.length} />
                {filteredInstallableProducts.length > 0 ? (
                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
                    {filteredInstallableProducts.map((product, index) => (
                      <InstallableCard
                        key={product.slug}
                        index={index}
                        product={product}
                        busy={busySlugs.has(product.slug)}
                        onInstall={() => void handleProductAction(product)}
                      />
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title={installedProducts.length > 0 ? "Everything is installed" : "No match"}
                  />
                )}

                {/* ---- External: not available yet ----------------------- */}
                <SubSection title="External apps" />
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
                  <ExternalAppsCard />
                </div>
              </>
            )}

            {activeSection === "installed-apps" && (
              <>
                {filteredInstalledProducts.length > 0 ? (
                  <>
                    <SubSection title="Ready to launch" count={filteredInstalledProducts.length} />
                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
                      {filteredInstalledProducts.map((product, index) => (
                        <LaunchCard
                          key={product.slug}
                          index={index}
                          product={product}
                          updateAvailable={Boolean(productStatuses[product.slug]?.update_available)}
                          busy={busySlugs.has(product.slug)}
                          onLaunch={() => void handleProductAction(product)}
                          onUpdate={() => void handleProductAction(product)}
                        />
                      ))}
                    </div>
                  </>
                ) : (
                  <EmptyState
                    title={installedProducts.length > 0 ? "No match" : "Nothing installed"}
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
                className="min-h-0 flex-1"
              />
            )}

            {activeSection === "workspaces" && (
              <WorkspacesPanel
                apps={products.map((product) => ({
                  slug: product.slug,
                  name: product.name,
                  installed: Boolean(productStatuses[product.slug]?.installed),
                  icon: product.iconImage,
                }))}
                workspaces={workspaceDirectory.workspaces}
                archived={workspaceDirectory.archived}
                invitations={workspaceDirectory.invitations}
                loading={workspaceDirectory.loading}
                error={workspaceDirectory.error}
                onReload={workspaceDirectory.reload}
                openWorkspaceId={activeWorkspaceId}
                onOpenWorkspace={setActiveWorkspaceId}
                onLaunchApp={(slug) => void launchWorkspaceApp(slug)}
                className="min-h-0 flex-1"
              />
            )}

            {activeSection === "downloads" && (
              <DownloadsPanel
                transfers={activeTransfers}
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
                update={update}
                updateCheckedAt={updateCheckedAt}
                updateChecking={updateChecking}
                updateError={updateError}
                onCheckForUpdate={handleCheckForUpdate}
                onOpenRelease={() => void openReleasePage(update)}
                onInstallUpdate={() => void handleInstallUpdate()}
                updateInstalling={updateInstalling}
                updateProgress={updateProgress}
                updateInstallError={updateInstallError}
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

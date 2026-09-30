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
import burnBackground from "./assets/burnAndGeometry.png";
import hexadofBackground from "./assets/hexadof.png";
import logo from "../src-tauri/icons/icon.png";
import propulsorBackground from "./assets/propulsor.png";
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
};

type ProductDefinition = {
  slug: string;
  name: string;
  titleLines?: string[];
  description: string;
  archiveUrl: string;
  executablePath: string;
  /**
   * Optional artwork. Without it the card falls back to a gradient and a monogram,
   * which is honest: a placeholder image would misrepresent the product.
   */
  backgroundImage?: string;
  iconImage?: string;
  eyebrow: string;
  backgroundPosition?: string;
  overlayClassName?: string;
  titleClassName?: string;
  iconClassName?: string;
  contentClassName?: string;
  descriptionClassName?: string;
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
    titleLines: ["APRO CAD"],
    description:
      "Text-first parametric CAD for rocket hardware. Describe geometry in RON and evaluate it to 3D meshes.",
    // A GitHub Release asset. `/releases/latest/download/<name>` is stable because the
    // asset name is version-free, so the ETag changing is what signals an update.
    archiveUrl:
      "https://github.com/APRO-pk/aproCAD/releases/latest/download/apro-cad-win64.zip",
    executablePath: "apro-cad.exe",
    eyebrow: "Parametric CAD",
    backgroundPosition: "center center",
    // No backgroundImage / iconImage: the repo ships only the stock Tauri placeholder
    // icons (one is a blank white square). Real artwork is a follow-up.
  },
  {
    slug: "burn-geometry-modeler",
    name: "Burn & Geometry Modeler",
    titleLines: ["Burn & Geometry", "Modeler"],
    description: "Grain geometry, burn progression, and design iteration in one desktop workspace.",
    archiveUrl:
      "https://zljhwosvsdqvgcgusqct.supabase.co/storage/v1/object/public/apro-products/Burn%20&%20Geometry%20Modeler-win64.zip",
    executablePath: "burn-geometry-modeler.exe",
    backgroundImage: burnBackground,
    iconImage: geometryIcon,
    eyebrow: "Geometry + Burn",
    backgroundPosition: "center 62%",
    overlayClassName:
      "bg-[linear-gradient(180deg,rgba(8,11,19,0.46),rgba(8,11,19,0.64)_34%,rgba(7,10,16,0.95)_100%)]",
    titleClassName: "max-w-none text-[1.62rem] leading-[0.94]",
    iconClassName: "h-16 w-16 rounded-[20px]",
    contentClassName: "pt-1",
    descriptionClassName: "max-w-[17rem]",
  },
  {
    slug: "Propulsor - Liquid Engine Design Studio",
    name: "Propulsor",
    description: "Liquid engine design, cycle exploration, and propulsion analysis for iterative development.",
    archiveUrl:
      "https://zljhwosvsdqvgcgusqct.supabase.co/storage/v1/object/public/apro-products/Propulsor%20-%20Liquid%20Engine%20Design%20Studio-win64.zip",
    executablePath: "propulsor-liquid-engine-design-studio.exe",
    backgroundImage: propulsorBackground,
    iconImage: propulsorIcon,
    eyebrow: "Liquid Engines",
    backgroundPosition: "center center",
    overlayClassName:
      "bg-[linear-gradient(180deg,rgba(8,11,19,0.22),rgba(8,11,19,0.58)_38%,rgba(7,10,16,0.95)_100%)]",
  },
  {
    slug: "hexadof",
    name: "HexaDOF",
    description: "Flight dynamics, telemetry, and six-degree-of-freedom analysis in a live mission workspace.",
    archiveUrl:
      "https://github.com/APRO-pk/hexadof2/releases/latest/download/hexadof-win64.zip",
    executablePath: "hexadof-desktop.exe",
    backgroundImage: hexadofBackground,
    iconImage: hexadofIcon,
    eyebrow: "Flight Dynamics",
    backgroundPosition: "center center",
    overlayClassName:
      "bg-[linear-gradient(180deg,rgba(8,11,19,0.22),rgba(8,11,19,0.58)_38%,rgba(7,10,16,0.95)_100%)]",
  },
];

const navItems: NavItem[] = [
  {
    id: "installed-apps",
    label: "Installed Apps",
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
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
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z" />
        <path d="M4 7.5 12 12l8-4.5M12 12v9" />
      </svg>
    ),
  },
  {
    id: "workflows",
    label: "Workflows",
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
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
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M12 4v10m0 0 4-4m-4 4-4-4M5 18h14" />
      </svg>
    ),
  },
];

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

const sectionCopy: Record<SectionId, { eyebrow: string; title: string; subtitle: string }> = {
  "all-apps": {
    eyebrow: "Library",
    title: "All Apps",
    subtitle: "",
  },
  "installed-apps": {
    eyebrow: "Local",
    title: "Installed Apps",
    subtitle: "",
  },
  workflows: {
    eyebrow: "Orchestration",
    title: "Workflows",
    subtitle: "",
  },
  downloads: {
    eyebrow: "Activity",
    title: "Downloads",
    subtitle: "",
  },
  settings: {
    eyebrow: "Controls",
    title: "Settings",
    subtitle: "",
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
    <div className="h-screen overflow-hidden bg-[radial-gradient(circle_at_top_left,#2b3857_0%,#121827_34%,#090d14_100%)] text-white">
      <div className="h-full w-full overflow-hidden rounded-[22px] border border-white/6 bg-[linear-gradient(180deg,rgba(7,10,16,0.94),rgba(10,13,20,0.985))] p-1.5 shadow-[0_40px_140px_rgba(0,0,0,0.52)]">
        <header className="panel-topbar flex h-12 items-center justify-between rounded-[20px] px-3">
          <div className="flex min-w-0 flex-1 items-center gap-3 pr-3">
            <div className="panel-chip flex items-center gap-2 rounded-full px-3 py-1.5">
              <img src={logo} alt="" className="h-4 w-auto object-contain opacity-90" />
              <span className="text-[0.72rem] font-semibold uppercase tracking-[0.26em] text-white/82">APRO</span>
            </div>
            <div className="h-4 w-px shrink-0 bg-white/8" />
            <p className="truncate text-[0.72rem] uppercase tracking-[0.26em] text-white/34">APRO Works</p>
          </div>
          <WindowControls />
        </header>

        <div className="flex h-[calc(100%-3.5rem)] items-center justify-center px-6 py-8">
          <div className="panel-shell surface-grid w-full max-w-[480px] rounded-[34px] p-7">
            <div className="flex items-center gap-4">
              <div className="panel-icon flex h-15 w-15 items-center justify-center rounded-[20px] p-3">
                <img src={logo} alt="" className="h-9 w-auto object-contain opacity-95" />
              </div>
              <div>
                <h1 className="text-[2.4rem] font-semibold leading-none tracking-tight text-white">Sign In</h1>
              </div>
            </div>

            <form
              className="mt-7 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                onSubmit();
              }}
            >
              <label className="block">
                <span className="mb-2 block text-[0.72rem] font-semibold uppercase tracking-[0.22em] text-white/44">Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => onEmailChange(event.target.value)}
                  placeholder="Enter your email"
                  className="panel-search w-full rounded-[22px] px-5 py-4 text-[0.98rem] text-white outline-none placeholder:text-white/30"
                  required
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-[0.72rem] font-semibold uppercase tracking-[0.22em] text-white/44">Password</span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => onPasswordChange(event.target.value)}
                  placeholder="Password"
                  className="panel-search w-full rounded-[22px] px-5 py-4 text-[0.98rem] text-white outline-none placeholder:text-white/30"
                  required
                />
              </label>

              {error ? (
                <div className="rounded-[18px] border border-[#ff9a9a]/22 bg-[#4a2020]/24 px-4 py-3 text-sm leading-6 text-[#ffc8c8]">
                  {error}
                </div>
              ) : null}

              <button
                type="submit"
                disabled={loading}
                className="control-primary w-full rounded-[999px] px-5 py-3.5 text-sm font-semibold text-slate-950 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? "Signing in..." : "Sign In"}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

function AproLogo() {
  return (
    <div className="flex items-center gap-3">
      <div className="panel-icon flex h-12 w-12 items-center justify-center rounded-[18px]">
        <img src={logo} alt="" className="h-7 w-auto object-contain opacity-95" />
      </div>
      <div>
        <p className="text-[0.66rem] uppercase tracking-[0.34em] text-[#95a8d8]/56">APRO</p>
        <h1 className="text-[1.7rem] font-semibold tracking-tight text-white">Works</h1>
      </div>
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

  const chromeButtonClass =
    "panel-soft flex h-8 w-8 items-center justify-center rounded-xl text-white/62 transition hover:text-white active:scale-[0.97]";

  return (
    <div className="flex items-center gap-2">
      <button type="button" aria-label="Minimize window" onClick={handleMinimize} onMouseDown={(event) => event.stopPropagation()} className={chromeButtonClass}>
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
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
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M8 8h9v9H8z" />
            <path d="M6 16V6h10" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />
          </svg>
        )}
      </button>
      <button
        type="button"
        aria-label="Close window"
        onClick={handleClose}
        onMouseDown={(event) => event.stopPropagation()}
        className="panel-soft-danger flex h-8 w-8 items-center justify-center rounded-xl text-[#ffc3c3] transition hover:text-white active:scale-[0.97]"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
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
    <label className="panel-search flex items-center gap-3 rounded-[999px] px-5 py-3.5">
      <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-white/38" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="11" cy="11" r="6.5" />
        <path d="m16 16 4 4" />
      </svg>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full bg-transparent text-[0.98rem] text-white outline-none placeholder:text-white/32"
      />
    </label>
  );
}

function StatPill({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="panel-chip rounded-[18px] px-4 py-3">
      <p className="text-[0.64rem] uppercase tracking-[0.28em] text-white/34">{label}</p>
      <p className="mt-1 text-base font-semibold text-white">{value}</p>
    </div>
  );
}

function SectionHeader({
  eyebrow,
  title,
  subtitle,
  stats,
  actions,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  stats?: Array<{ label: string; value: string | number }>;
  /** Section-specific controls, shown above the stat pills. */
  actions?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
      <div className="max-w-[42rem]">
        <p className="text-[0.68rem] uppercase tracking-[0.34em] text-[#95a8d8]/62">{eyebrow}</p>
        <h2 className="mt-2 text-[clamp(2rem,3vw,3.15rem)] font-semibold leading-[0.98] tracking-tight text-white">
          {title}
        </h2>
        {subtitle ? <p className="mt-3 max-w-[34rem] text-[0.95rem] leading-7 text-white/52">{subtitle}</p> : null}
      </div>
      {actions || (stats && stats.length > 0) ? (
        <div className="flex flex-col items-start gap-4 xl:items-end">
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
          {stats && stats.length > 0 ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:min-w-[15rem]">
              {stats.map((stat) => (
                <StatPill key={stat.label} label={stat.label} value={stat.value} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ProductCard({
  product,
  installed,
  updateAvailable,
  busy,
  onPrimaryAction,
  onSecondaryAction,
}: {
  product: ProductDefinition;
  installed: boolean;
  updateAvailable: boolean;
  busy: boolean;
  onPrimaryAction: () => void;
  onSecondaryAction?: () => void;
}) {
  return (
    <article className="panel-card panel-card-stack group relative overflow-hidden rounded-[30px]">
      {product.backgroundImage ? (
        <div
          className="absolute inset-0 scale-[1.02] bg-cover bg-center blur-[7px] transition duration-700 group-hover:scale-[1.08] group-hover:blur-[4px]"
          style={{
            backgroundImage: `url(${product.backgroundImage})`,
            backgroundPosition: product.backgroundPosition ?? "center center",
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_28%_18%,rgba(128,154,255,0.22),transparent_58%),linear-gradient(150deg,rgba(38,50,78,0.96),rgba(14,19,30,0.99))]" />
      )}
      <div className={`absolute inset-0 ${product.overlayClassName ?? "bg-[linear-gradient(180deg,rgba(8,11,19,0.22),rgba(8,11,19,0.58)_38%,rgba(7,10,16,0.95)_100%)]"}`} />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(125,154,242,0.18),transparent_22%),radial-gradient(circle_at_bottom_right,rgba(117,149,245,0.12),transparent_24%)] opacity-90" />
      <div className="panel-grain absolute inset-0 opacity-55" />

      <div className="relative flex h-full min-h-[318px] flex-col p-5">
        <div className="flex items-start justify-between gap-4">
          <span className="rounded-full border border-white/10 bg-transparent px-3 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.24em] text-white/68">
            {product.eyebrow}
          </span>
          <span
            className={`rounded-full border border-white/10 bg-transparent px-3 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.24em] ${
              updateAvailable ? "pill-update" : installed ? "pill-installed" : "pill-available"
            }`}
          >
            {updateAvailable ? "Update" : installed ? "Installed" : "Available"}
          </span>
        </div>

        <div className={`flex flex-1 flex-col items-center justify-center pt-4 text-center ${product.contentClassName ?? ""}`}>
          <div
            className={`mb-5 flex h-17 w-17 items-center justify-center transition duration-500 group-hover:scale-[1.06] ${
              product.iconClassName ?? ""
            }`}
          >
            {product.iconImage ? (
              <img src={product.iconImage} alt="" className="max-h-full w-auto object-contain" />
            ) : (
              <span className="flex h-full w-full items-center justify-center rounded-[20px] border border-white/10 bg-white/[0.06] text-[1.35rem] font-semibold tracking-[0.08em] text-white/72">
                {initialsFromName(product.name)}
              </span>
            )}
          </div>
          <h3
            className={`max-w-[13ch] text-[1.58rem] font-semibold leading-[0.98] tracking-tight text-white drop-shadow-[0_10px_20px_rgba(0,0,0,0.45)] ${
              product.titleClassName ?? ""
            }`}
          >
            {product.titleLines ? (
              product.titleLines.map((line, index) => (
                <span key={`${product.slug}-line-${index}`} className="block whitespace-nowrap">
                  {line}
                </span>
              ))
            ) : (
              product.name
            )}
          </h3>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            {installed && onSecondaryAction ? (
              <button
                type="button"
                onClick={onSecondaryAction}
                disabled={busy}
                className="control-glass control-secondary control-clear rounded-[999px] px-5 py-2.5 text-sm font-semibold text-white/78 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                Uninstall
              </button>
            ) : null}
              <button
                type="button"
                onClick={onPrimaryAction}
                disabled={busy}
                className="control-glass control-clear rounded-[999px] px-5 py-2.5 text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy ? "Working..." : updateAvailable ? "Update" : installed ? "Launch" : "Install"}
              </button>
          </div>
        </div>
      </div>
    </article>
  );
}

function LaunchOverlay({
  productName,
}: {
  productName: string;
}) {
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-[rgba(7,10,16,0.48)] backdrop-blur-[6px]">
      <div className="panel-shell w-full max-w-[420px] rounded-[30px] px-8 py-8 text-center shadow-[0_28px_90px_rgba(0,0,0,0.34)]">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-white/12 bg-white/[0.04]">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/18 border-t-[#aac3ff]" />
        </div>
        <p className="mt-5 text-[0.72rem] uppercase tracking-[0.32em] text-white/42">Launching</p>
        <h3 className="mt-3 text-[1.75rem] font-semibold tracking-tight text-white">{productName}</h3>
        <p className="mt-3 text-sm leading-6 text-white/56">Preparing the workspace window and handing control to the product.</p>
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
    <div className="panel-soft surface-grid flex min-h-[320px] items-center rounded-[28px] px-6 py-6">
      <div>
        <p className="text-2xl font-semibold tracking-tight text-white">{title}</p>
        <p className="mt-3 max-w-[26rem] text-sm leading-6 text-white/54">{detail}</p>
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
  return (
    <div
      className={`panel-soft flex items-start justify-between gap-4 rounded-[22px] px-4 py-4 ${
        item.tone === "error" ? "border border-[#ff9898]/22" : ""
      }`}
    >
      <div>
        <p className={`text-sm font-semibold ${item.tone === "error" ? "text-[#ffbcbc]" : "text-white"}`}>{item.title}</p>
        <p className={`mt-1 text-sm leading-6 ${item.tone === "error" ? "text-[#ffd3d3]/76" : "text-white/56"}`}>{item.detail}</p>
      </div>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={onDismiss}
        className="panel-chip rounded-xl px-2.5 py-1.5 text-xs font-semibold text-white/56 transition hover:text-white"
      >
        X
      </button>
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
      <section className="panel-soft surface-grid rounded-[30px] px-6 py-6">
        <div className="max-w-[42rem]">
          <p className="text-[0.72rem] uppercase tracking-[0.28em] text-white/38">Active transfer</p>
          <h3 className="mt-3 text-3xl font-semibold tracking-tight text-white">{activeProductName}</h3>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span className="panel-chip rounded-full px-3 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.24em] text-white/68">
              {stageLabels[downloadStage]}
            </span>
            <span className="text-sm text-white/48">{downloadProgress}% complete</span>
          </div>
          <p className="mt-5 max-w-[32rem] text-sm leading-6 text-white/62">{statusMessage}</p>
          <div className="panel-inset mt-6 rounded-full p-1.5">
            <div
              className="progress-fill h-3 rounded-full transition-[width] duration-300"
              style={{ width: `${downloadProgress}%` }}
            />
          </div>
          {errorMessage ? <p className="mt-4 text-sm text-[#ff9f9f]">{errorMessage}</p> : null}
        </div>
      </section>
    );
  }

  return (
    <section className="panel-soft surface-grid rounded-[30px] px-6 py-6">
      <p className="text-2xl font-semibold tracking-tight text-white">No downloads</p>
      <p className="mt-3 max-w-[30rem] text-sm leading-6 text-white/54">Completed installs stay here until you leave this tab or dismiss them manually.</p>
      {history.length > 0 ? (
        <div className="mt-6 space-y-3">
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
  onSignOut,
  signingOut,
}: {
  member: MemberRecord;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  return (
    <section className="panel-soft surface-grid rounded-[30px] px-6 py-6">
      <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="panel-inset rounded-[26px] px-5 py-5">
          <p className="text-[0.72rem] uppercase tracking-[0.28em] text-white/38">Account</p>
          <h3 className="mt-3 text-3xl font-semibold tracking-tight text-white">{member.full_name ?? member.email ?? "APRO member"}</h3>
          <p className="mt-4 max-w-[34rem] text-sm leading-7 text-white/58">Manage your APRO Works account session.</p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <span className="panel-chip rounded-full px-3 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.24em] text-white/68">
              {member.account_status}
            </span>
            <span className="text-sm text-white/48">{member.email ?? "No email available"}</span>
          </div>
          <button
            type="button"
            onClick={onSignOut}
            disabled={signingOut}
            className="control-secondary mt-7 rounded-[999px] px-5 py-3 text-sm font-semibold text-white/82 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {signingOut ? "Signing out..." : "Sign Out"}
          </button>
        </div>
        <div className="grid gap-3">
          <div className="panel-raised rounded-[24px] px-4 py-4">
            <p className="text-[0.68rem] uppercase tracking-[0.22em] text-white/38">Session</p>
            <p className="mt-2 text-sm text-white/72">Your sign-in session is restored automatically when APRO Works starts.</p>
          </div>
          <div className="panel-raised rounded-[24px] px-4 py-4">
            <p className="text-[0.68rem] uppercase tracking-[0.22em] text-white/38">Access</p>
            <p className="mt-2 text-sm text-white/72">Only approved members can open APRO Works.</p>
          </div>
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
  const filteredProducts = products.filter(matchesSearch);
  const filteredInstalledProducts = installedProducts.filter(matchesSearch);
  const availableProductsCount = products.length;
  const installedProductsCount = installedProducts.length;
  const showActiveDownload =
    activeSection === "downloads" &&
    (busy || downloadStage === "downloading" || downloadStage === "installing" || downloadStage === "uninstalling");

  const sectionStats: Record<SectionId, Array<{ label: string; value: string | number }>> = {
    "all-apps": [
      { label: "Available", value: availableProductsCount },
      { label: "Installed", value: installedProductsCount },
    ],
    "installed-apps": [{ label: "Installed", value: installedProductsCount }],
    workflows: [{ label: "Apps", value: availableProductsCount }],
    downloads: [
      { label: "State", value: stageLabels[downloadStage] },
      { label: "Queue", value: busy ? "Busy" : "Idle" },
    ],
    settings: [{ label: "Profile", value: "Local" }],
  };

  const activeCopy = sectionCopy[activeSection];

  if (!authReady) {
    return (
      <div className="h-screen overflow-hidden bg-[radial-gradient(circle_at_top_left,#2b3857_0%,#121827_34%,#090d14_100%)] text-white">
        <div className="flex h-full items-center justify-center">
          <div className="panel-shell rounded-[30px] px-8 py-7 text-center">
            <p className="text-[0.72rem] uppercase tracking-[0.32em] text-white/42">APRO Works</p>
            <p className="mt-3 text-2xl font-semibold tracking-tight text-white">Restoring session...</p>
          </div>
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
    <div className="h-screen overflow-hidden bg-[radial-gradient(circle_at_top_left,#2b3857_0%,#121827_34%,#090d14_100%)] text-white">
      <div className="h-full w-full overflow-hidden rounded-[22px] border border-white/6 bg-[linear-gradient(180deg,rgba(7,10,16,0.94),rgba(10,13,20,0.985))] p-1.5 shadow-[0_40px_140px_rgba(0,0,0,0.52)]">
        <header
          onMouseDown={handleTitlebarMouseDown}
          className="panel-topbar flex h-12 items-center justify-between rounded-[20px] px-3"
        >
            <div className="flex min-w-0 flex-1 items-center gap-3 pr-3">
              <div className="panel-chip flex items-center gap-2 rounded-full px-3 py-1.5">
              <img src={logo} alt="" className="h-4 w-auto object-contain opacity-90" />
              <span className="text-[0.72rem] font-semibold uppercase tracking-[0.26em] text-white/82">APRO</span>
            </div>
            <div className="h-4 w-px shrink-0 bg-white/8" />
            <p className="truncate text-[0.72rem] uppercase tracking-[0.26em] text-white/34">APRO Works</p>
          </div>
          <WindowControls />
        </header>
        <div className="mt-2 flex h-[calc(100%-3.75rem)] min-h-0 gap-3">
          <aside className="panel-shell flex w-[278px] min-w-[278px] flex-col rounded-[30px] p-5">
            <AproLogo />

            <nav className="mt-8 grid gap-3">
              {navItems.map((item) => {
                const isActive = item.id === activeSection;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setActiveSection(item.id)}
                    className={`flex items-center gap-3 rounded-[20px] px-4 py-3.5 text-left transition ${
                      isActive ? "nav-active text-white" : "nav-idle text-white/60 hover:text-white"
                    }`}
                  >
                    <span className={isActive ? "text-[#aac3ff]" : "text-white/48"}>{item.icon}</span>
                    <span className="text-[1rem] font-medium">{item.label}</span>
                  </button>
                );
              })}
            </nav>

            <div className="mt-auto border-t border-white/8 pt-5">
              <button
                type="button"
                onClick={() => setActiveSection("settings")}
                className={`mb-3 flex w-full items-center gap-3 rounded-[18px] px-3.5 py-3 text-left text-sm transition ${
                  activeSection === "settings" ? "nav-active text-white" : "nav-idle text-white/50 hover:text-white"
                }`}
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M10.5 3h3l.7 2.2a7.7 7.7 0 0 1 1.8.8l2.1-1.1 2.1 2.1-1.1 2.1c.3.6.6 1.2.8 1.8L21 12v3l-2.2.7c-.2.6-.5 1.2-.8 1.8l1.1 2.1-2.1 2.1-2.1-1.1c-.6.3-1.2.6-1.8.8L13.5 21h-3l-.7-2.2a7.7 7.7 0 0 1-1.8-.8l-2.1 1.1-2.1-2.1 1.1-2.1a7.7 7.7 0 0 1-.8-1.8L3 15v-3l2.2-.7c.2-.6.5-1.2.8-1.8L4.9 7.4 7 5.3l2.1 1.1c.6-.3 1.2-.6 1.8-.8L10.5 3Z" />
                  <circle cx="12" cy="12" r="3.2" />
                </svg>
                <span>Settings</span>
              </button>

              <div className="panel-soft flex items-center gap-3 rounded-[22px] px-3 py-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[linear-gradient(180deg,#f5f7fb,#b7bfd3)] text-sm font-semibold text-slate-900">
                  {initialsFromName(profileName)}
                </div>
                <div>
                  <p className="text-sm font-semibold text-white">{profileName}</p>
                  <p className="text-xs uppercase tracking-[0.22em] text-white/34">{profileSubtitle}</p>
                </div>
              </div>
            </div>
          </aside>

          <main className="panel-stage flex min-h-0 flex-1 flex-col overflow-hidden rounded-[32px] p-5">
            <div className="panel-board rounded-[30px] px-6 py-5">
              <SectionHeader
                eyebrow={activeCopy.eyebrow}
                title={activeCopy.title}
                subtitle={activeCopy.subtitle}
                stats={sectionStats[activeSection]}
                actions={
                  activeSection === "workflows" ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setWorkflowSync((token) => token + 1)}
                        title="Re-read the orchestration store"
                        className="panel-soft rounded-xl px-3.5 py-2 text-[12px] text-white/70 transition hover:text-white"
                      >
                        Sync
                      </button>
                      <button
                        type="button"
                        onClick={() => setWorkflowConsole(true)}
                        className="panel-raised flex items-center gap-2 rounded-xl px-3.5 py-2 text-[12px] text-white/86 transition hover:text-white"
                      >
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                          <rect x="3" y="4" width="18" height="16" rx="2.5" />
                          <path d="M7 9l3 3-3 3M12.5 15H17" />
                        </svg>
                        Console
                      </button>
                      <button
                        type="button"
                        onClick={() => setWorkflowReset((token) => token + 1)}
                        title="Reset the canvas to the default template"
                        className="panel-soft rounded-xl px-3.5 py-2 text-[12px] text-white/70 transition hover:text-white"
                      >
                        Reset
                      </button>
                    </>
                  ) : undefined
                }
              />
            </div>

            {(activeSection === "all-apps" || activeSection === "installed-apps") && (
              <div className="mt-4">
                <SearchField
                  value={searchQuery}
                  onChange={setSearchQuery}
                  placeholder={
                    activeSection === "all-apps"
                      ? "Search workspaces, propulsion, burn, telemetry..."
                      : "Search installed workspaces"
                  }
                />
              </div>
            )}

            <div className="panel-catalog custom-scrollbar mt-4 min-h-0 flex-1 overflow-y-auto rounded-[34px]">
              <div className="panel-catalog-surface min-h-full px-5 py-5">
                {activeSection === "all-apps" && (
                  <>
                    {filteredProducts.length > 0 ? (
                      <div className="grid grid-cols-1 gap-6 pb-6 xl:grid-cols-2 2xl:grid-cols-3">
                        {filteredProducts.map((product) => (
                          <ProductCard
                            key={product.slug}
                            product={product}
                            installed={Boolean(productStatuses[product.slug]?.installed)}
                            updateAvailable={Boolean(productStatuses[product.slug]?.update_available)}
                            busy={busy && activeProductSlug === product.slug}
                            onPrimaryAction={() => void handleProductAction(product)}
                            onSecondaryAction={
                              productStatuses[product.slug]?.installed ? () => void handleUninstallProduct(product) : undefined
                            }
                          />
                        ))}
                      </div>
                    ) : (
                      <EmptyState title="No products found" detail="Try a different search term or clear the current filter." />
                    )}
                  </>
                )}

                {activeSection === "installed-apps" && (
                  <>
                    {filteredInstalledProducts.length > 0 ? (
                      <div className="grid grid-cols-1 gap-6 pb-6 xl:grid-cols-2 2xl:grid-cols-3">
                        {filteredInstalledProducts.map((product) => (
                          <ProductCard
                            key={product.slug}
                            product={product}
                            installed
                            updateAvailable={Boolean(productStatuses[product.slug]?.update_available)}
                            busy={busy && activeProductSlug === product.slug}
                            onPrimaryAction={() => void handleProductAction(product)}
                            onSecondaryAction={() => void handleUninstallProduct(product)}
                          />
                        ))}
                      </div>
                    ) : installedProducts.length > 0 ? (
                      <EmptyState title="No products found" detail="The current filter does not match any installed workspace." />
                    ) : (
                      <EmptyState title="No products installed" detail="Install a workspace from All Apps and it will appear here." />
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
                    className="h-[calc(100vh-345px)] min-h-[430px]"
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
                    onDismissHistory={(id) => setDownloadHistory((current) => current.filter((entry) => entry.id !== id))}
                  />
                )}

                {activeSection === "settings" && (
                  <SettingsPanel member={member} onSignOut={() => void handleSignOut()} signingOut={signingOut} />
                )}
              </div>
            </div>
          </main>
        </div>
        {launchOverlayProduct ? <LaunchOverlay productName={launchOverlayProduct} /> : null}
      </div>

      {snackbar.visible ? (
        <div className="pointer-events-none fixed bottom-5 left-1/2 z-50 w-full max-w-[520px] -translate-x-1/2 px-4">
          <div className="panel-soft rounded-[22px] px-5 py-4">
            <p className="text-sm font-semibold text-white">{snackbar.title}</p>
            <p className="mt-1 text-sm text-white/58">{snackbar.detail}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;

import React, { useCallback, useEffect, useRef, useState } from "react";
import { toPng } from "html-to-image";

/**
 * Virtuelles Systembrett - Prototyp-Komponente (v22, Syntaxfix)
 * ----------------------------------------------------------------
 * Bugfix gegenüber v21 (Ursache jetzt zweifelsfrei behoben):
 *
 * "Figuren werden beim Wechsel in den Vollbildmodus unsichtbar und bleiben
 * es auch nach Rückkehr in den Normalmodus" - das war ein State-Bug, kein
 * CSS/Filter-Problem:
 *
 * Der Hook "useElementSize" registrierte seinen ResizeObserver bisher nur
 * einmalig beim ersten Mount (useEffect mit leerer Dependency-Liste,
 * gebunden an ein normales useRef-Objekt). Da v21 für den normalen Modus
 * und den Vollbildmodus jeweils einen eigenen BoardContent-JSX-Zweig
 * hatte, wurde beim Umschalten zwischen den Modi das komplette Element
 * (inkl. des div mit dem boardRef) unmounted und ein neues, separates div
 * gemounted. Der bereits registrierte ResizeObserver beobachtete danach
 * weiter das alte, nicht mehr existierende DOM-Element und wurde nie
 * erneut auf das neue Element registriert - "boardSizePx" blieb somit
 * dauerhaft eingefroren (bzw. auf 0), auch nach Rückkehr in den
 * Normalmodus, weil der Observer nie neu gebunden wurde. Da die
 * Figurengröße direkt aus "boardSizePx.width" berechnet wird, wurden
 * Figuren dadurch auf eine Größe von praktisch 0px zusammengeschrumpft.
 *
 * Fix: "useElementSize" nutzt jetzt einen zusätzlichen Callback, der bei
 * jedem Mount UND Unmount des Zielelements aufgerufen wird (React ruft
 * Callback-Refs zuverlässig bei jeder Element-Änderung auf). Dadurch wird
 * der ResizeObserver bei jedem Element-Austausch (z.B. durch bedingtes
 * Rendering beim Fullscreen-Wechsel) sauber abgemeldet und neu registriert.
 * Das normale RefObject bleibt für bestehende .current-Zugriffe in den
 * Drag-Handlern unverändert nutzbar.
 *
 * Hinweis: Alle Kommentare in dieser Datei verwenden ausschließlich "//",
 * keine Python-Raute "#", um den zuvor aufgetretenen esbuild-Syntaxfehler
 * zu vermeiden.
 *
 * Abhängigkeiten: React + Tailwind CSS + html-to-image (npm install html-to-image)
 */

// ---------- Typen ----------

type ShapeType = "circle" | "square" | "triangle";
type ColorKey = "yellow" | "green" | "red" | "blue";
type AnchorShape = "rect" | "circle" | "triangle";
type AnchorColorKey = "blue" | "red" | "yellow" | "green" | "gray";
type NoteColorKey = "yellow" | "pink" | "green" | "blue";
type CornerKey = "tl" | "tr" | "bl" | "br";

interface Figure {
  id: string;
  kind: "figure";
  type: ShapeType;
  label: string;
  x: number;
  y: number;
  rotation: number;
  color: ColorKey;
  sizePct: number;
}

interface Anchor {
  id: string;
  kind: "anchor";
  shape: AnchorShape;
  label: string;
  x: number;
  y: number;
  widthPct: number;
  heightPct: number;
  color: AnchorColorKey;
}

interface Note {
  id: string;
  kind: "note";
  text: string;
  x: number;
  y: number;
  widthPct: number;
  heightPct: number;
  color: NoteColorKey;
}

type ClipboardItem = { kind: "figure"; data: Figure } | { kind: "anchor"; data: Anchor };

// ---------- Konstanten ----------

const COLOR_STYLES: Record<ColorKey, { base: string; light: string; dark: string; label: string }> = {
  yellow: { base: "#eab308", light: "#fde68a", dark: "#92600a", label: "Gelb" },
  green: { base: "#65a30d", light: "#bef264", dark: "#3f6212", label: "Grün" },
  red: { base: "#dc2626", light: "#fca5a5", dark: "#7f1d1d", label: "Rot" },
  blue: { base: "#2563eb", light: "#93c5fd", dark: "#1e3a8a", label: "Blau" },
};

const ANCHOR_COLOR_STYLES: Record<AnchorColorKey, { fill: string; label: string }> = {
  blue: { fill: "#3b82f6", label: "Blau" },
  red: { fill: "#ef4444", label: "Rot" },
  yellow: { fill: "#eab308", label: "Gelb" },
  green: { fill: "#22c55e", label: "Grün" },
  gray: { fill: "#6b7280", label: "Grau" },
};

const NOTE_COLOR_STYLES: Record<NoteColorKey, { bg: string; label: string }> = {
  yellow: { bg: "#fef08a", label: "Gelb" },
  pink: { bg: "#fbcfe8", label: "Rosa" },
  green: { bg: "#bbf7d0", label: "Grün" },
  blue: { bg: "#bfdbfe", label: "Blau" },
};

const ANCHOR_OPACITY = 0.32;

const FIGURE_MIN_PCT = 4;
const FIGURE_MAX_PCT = 20;
const FIGURE_DEFAULT_PCT = 9.5;

const ANCHOR_MIN_PCT = 6;
const ANCHOR_MAX_PCT = 95;
const ANCHOR_DEFAULT_PCT = 16;

const NOTE_MIN_PCT = 8;
const NOTE_MAX_PCT = 45;
const NOTE_DEFAULT_WIDTH_PCT = 14;
const NOTE_DEFAULT_HEIGHT_PCT = 12;

const SHAPE_LABELS: Record<ShapeType, string> = {
  circle: "Frau",
  square: "Mann",
  triangle: "Element",
};

const ANCHOR_SHAPE_LABELS: Record<AnchorShape, string> = {
  rect: "Form (Rechteck)",
  circle: "Form (Kreis)",
  triangle: "Form (Dreieck)",
};

const BOARD_BASE_PX = 650;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.1;
const MOBILE_BREAKPOINT_PX = 640;
const MOBILE_DEFAULT_ZOOM = 0.55;
const PASTE_OFFSET_PCT = 4;
const FULLSCREEN_TOP_BAR_PX = 64;
const FULLSCREEN_MARGIN_PX = 32;

let idCounter = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now()}-${idCounter++}`;

const getInitialZoom = () => {
  if (typeof window === "undefined") return 1;
  return window.innerWidth < MOBILE_BREAKPOINT_PX ? MOBILE_DEFAULT_ZOOM : 1;
};

const computeFullscreenZoom = () => {
  if (typeof window === "undefined") return 1;
  const availableW = window.innerWidth - FULLSCREEN_MARGIN_PX * 2;
  const availableH = window.innerHeight - FULLSCREEN_TOP_BAR_PX - FULLSCREEN_MARGIN_PX * 2;
  const smaller = Math.min(availableW, availableH);
  const zoom = smaller / BOARD_BASE_PX;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(zoom * 100) / 100));
};

// ---------- Hilfsfunktionen: Fullscreen API mit Vendor-Fallback ----------

interface FullscreenCapableElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

interface FullscreenCapableDocument extends Document {
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenElement?: Element | null;
}

function requestFullscreenOn(el: HTMLElement) {
  const target = el as FullscreenCapableElement;
  if (target.requestFullscreen) {
    target.requestFullscreen().catch(() => {});
  } else if (target.webkitRequestFullscreen) {
    target.webkitRequestFullscreen();
  }
}

function exitFullscreen() {
  const doc = document as FullscreenCapableDocument;
  if (document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  } else if (doc.webkitExitFullscreen) {
    doc.webkitExitFullscreen();
  }
}

function getFullscreenElement(): Element | null {
  const doc = document as FullscreenCapableDocument;
  return document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

// ---------- SVG-Definitionen ----------

const WoodDefs: React.FC = () => (
  <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
    <defs>
      <filter id="woodGrainFine" x="-20%" y="-20%" width="140%" height="140%">
        <feTurbulence type="fractalNoise" baseFrequency="0.06 0.9" numOctaves="2" seed="7" result="noise" />
        <feColorMatrix
          in="noise"
          type="matrix"
          values="0 0 0 0 0.28
                  0 0 0 0 0.18
                  0 0 0 0 0.08
                  0 0 0 0.35 0"
        />
      </filter>
      <filter id="woodGrainBoard" x="0%" y="0%" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.012 0.15" numOctaves="3" seed="12" result="noise" />
        <feColorMatrix
          in="noise"
          type="matrix"
          values="0 0 0 0 0.55
                  0 0 0 0 0.38
                  0 0 0 0 0.20
                  0 0 0 0.22 0"
        />
      </filter>

      {(Object.keys(COLOR_STYLES) as ColorKey[]).map((key) => {
        const c = COLOR_STYLES[key];
        return (
          <radialGradient key={key} id={`figGradient-${key}`} cx="35%" cy="30%" r="75%">
            <stop offset="0%" stopColor={c.light} />
            <stop offset="55%" stopColor={c.base} />
            <stop offset="100%" stopColor={c.dark} />
          </radialGradient>
        );
      })}
    </defs>
  </svg>
);

// ---------- Hook: gemessene Element-Größe in px ----------
// Bugfix: Zusätzlich zum normalen RefObject (für bestehende .current-
// Zugriffe) wird ein Callback zurückgegeben, der die JSX-ref-Prop bindet.
// React ruft diesen Callback bei JEDEM Mount UND Unmount des Zielelements
// zuverlässig auf - dadurch wird der ResizeObserver bei jedem Element-
// Austausch (z.B. durch bedingtes Rendering beim Fullscreen-Wechsel)
// korrekt abgemeldet und neu registriert, statt auf einem entfernten
// DOM-Element hängen zu bleiben.

function useElementSize<T extends HTMLElement>() {
  const elementRef = useRef<T | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const attachRef = useCallback((node: T | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }

    elementRef.current = node;

    if (node) {
      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) {
          const { width, height } = entry.contentRect;
          setSize({ width, height });
        }
      });
      observer.observe(node);
      observerRef.current = observer;
      setSize({ width: node.clientWidth, height: node.clientHeight });
    } else {
      setSize({ width: 0, height: 0 });
    }
  }, []);

  useEffect(() => {
    return () => {
      observerRef.current?.disconnect();
    };
  }, []);

  return { ref: elementRef, attachRef, size };
}

// ---------- Figuren-Icon ----------

interface ShapeSvgProps {
  type: ShapeType;
  color: ColorKey;
  size: number;
  rotation?: number;
  selected?: boolean;
}

const ShapeSvg: React.FC<ShapeSvgProps> = ({ type, color, size, rotation = 0, selected }) => {
  const c = COLOR_STYLES[color];
  const half = size / 2;
  const eyeOffsetY = -half * 0.18;
  const eyeGap = size * 0.14;
  const eyeRadius = Math.max(1.8, size * 0.045);
  const gradientId = `figGradient-${color}`;

  const renderBase = () => {
    switch (type) {
      case "circle":
        return (
          <>
            <circle cx={0} cy={0} r={half - 2} fill={`url(#${gradientId})`} stroke={c.dark} strokeWidth={1.5} />
            <circle cx={0} cy={0} r={half - 2} fill={c.base} filter="url(#woodGrainFine)" opacity={0.5} />
          </>
        );
      case "square":
        return (
          <>
            <rect
              x={-half + 2}
              y={-half + 2}
              width={size - 4}
              height={size - 4}
              fill={`url(#${gradientId})`}
              stroke={c.dark}
              strokeWidth={1.5}
              rx={4}
            />
            <rect
              x={-half + 2}
              y={-half + 2}
              width={size - 4}
              height={size - 4}
              fill={c.base}
              filter="url(#woodGrainFine)"
              opacity={0.5}
              rx={4}
            />
          </>
        );
      case "triangle": {
        const r = half - 2;
        const pts = [
          [0, -r],
          [r * 0.9, r * 0.75],
          [-r * 0.9, r * 0.75],
        ]
          .map((p) => p.join(","))
          .join(" ");
        return (
          <>
            <polygon points={pts} fill={`url(#${gradientId})`} stroke={c.dark} strokeWidth={1.5} />
            <polygon points={pts} fill={c.base} filter="url(#woodGrainFine)" opacity={0.5} />
          </>
        );
      }
    }
  };

  return (
    <svg
      width={size}
      height={size}
      viewBox={`${-half} ${-half} ${size} ${size}`}
      className="overflow-visible pointer-events-none select-none"
      style={{
        outline: "none",
        border: "none",
        background: "transparent",
        display: "block",
        filter: "drop-shadow(0 3px 3px rgba(0,0,0,0.35))",
      }}
    >
      <g style={{ transform: `rotate(${rotation}deg)`, transformOrigin: "0 0" }}>
        {renderBase()}
        <circle cx={-eyeGap} cy={eyeOffsetY - half * 0.35} r={eyeRadius} fill={selected ? "#111827" : c.dark} />
        <circle cx={eyeGap} cy={eyeOffsetY - half * 0.35} r={eyeRadius} fill={selected ? "#111827" : c.dark} />
      </g>
      {selected && (
        <circle cx={0} cy={0} r={half + 4} fill="none" stroke="#111827" strokeWidth={1.5} strokeDasharray="4 3" />
      )}
    </svg>
  );
};

// ---------- Formen-Icon (Bodenanker) - reine CSS-<div>-Formen ----------

interface AnchorShapeDivProps {
  shape: AnchorShape;
  color: AnchorColorKey;
  selected?: boolean;
}

const AnchorShapeDiv: React.FC<AnchorShapeDivProps> = ({ shape, color, selected }) => {
  const fillColor = ANCHOR_COLOR_STYLES[color].fill;

  const baseStyle: React.CSSProperties = {
    width: "100%",
    height: "100%",
    backgroundColor: fillColor,
    opacity: ANCHOR_OPACITY,
    borderRadius: 0,
    clipPath: "none",
  };

  if (shape === "circle") {
    baseStyle.borderRadius = "50%";
  } else if (shape === "rect") {
    baseStyle.borderRadius = "4px";
  } else if (shape === "triangle") {
    baseStyle.clipPath = "polygon(50% 0%, 100% 100%, 0% 100%)";
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", background: "transparent" }}>
      <div style={baseStyle} />
      {selected && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            border: "1px dashed #111827",
            borderRadius: shape === "circle" ? "50%" : shape === "rect" ? "4px" : 0,
            background: "transparent",
          }}
        />
      )}
    </div>
  );
};

const AnchorPreview: React.FC<{ shape: AnchorShape; color: AnchorColorKey; size: number }> = ({
  shape,
  color,
  size,
}) => (
  <div style={{ width: size, height: size, background: "transparent" }}>
    <AnchorShapeDiv shape={shape} color={color} />
  </div>
);

const NotePreview: React.FC<{ color: NoteColorKey; size: number }> = ({ color, size }) => (
  <div
    style={{
      width: size,
      height: size,
      backgroundColor: NOTE_COLOR_STYLES[color].bg,
      boxShadow: "0 2px 4px rgba(0,0,0,0.15)",
    }}
    className="rounded-sm flex items-center justify-center"
  >
    <div className="w-2/3 space-y-0.5">
      <div className="h-0.5 bg-black/10 rounded" />
      <div className="h-0.5 bg-black/10 rounded w-4/5" />
    </div>
  </div>
);

// ---------- Icons für Toolbar-Buttons ----------

const IconFullscreen: React.FC = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconDownload: React.FC = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 19h16" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconSidebar: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <line x1="9" y1="4" x2="9" y2="20" />
  </svg>
);

// ---------- Zoom-, Vollbild- und Export-Kontrolle ----------

interface ToolbarProps {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onSaveAsImage: () => void;
  isExporting: boolean;
}

const Toolbar: React.FC<ToolbarProps> = ({
  zoom,
  onZoomIn,
  onZoomOut,
  onReset,
  isFullscreen,
  onToggleFullscreen,
  onSaveAsImage,
  isExporting,
}) => (
  <div className="flex items-center gap-2">
    <div className="flex items-center gap-1 bg-white border border-gray-200 rounded-lg shadow-sm px-2 py-1">
      <button
        onClick={onZoomOut}
        disabled={zoom <= ZOOM_MIN + 1e-9}
        title="Verkleinern"
        className="w-6 h-6 flex items-center justify-center rounded text-gray-600 hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-transparent"
      >
        -
      </button>
      <button
        onClick={onReset}
        title="Zoom zurücksetzen"
        className="text-xs text-gray-500 w-12 text-center hover:text-gray-800"
      >
        {Math.round(zoom * 100)}%
      </button>
      <button
        onClick={onZoomIn}
        disabled={zoom >= ZOOM_MAX - 1e-9}
        title="Vergrößern"
        className="w-6 h-6 flex items-center justify-center rounded text-gray-600 hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-transparent"
      >
        +
      </button>
    </div>

    <button
      onClick={onSaveAsImage}
      disabled={isExporting}
      title="Als Bild speichern"
      className="flex items-center justify-center w-8 h-8 bg-white border border-gray-200 rounded-lg shadow-sm text-gray-600 hover:bg-gray-100 disabled:opacity-40"
    >
      <IconDownload />
    </button>

    {!isFullscreen && (
      <button
        onClick={onToggleFullscreen}
        title="Vollbild anzeigen"
        className="flex items-center justify-center w-8 h-8 bg-white border border-gray-200 rounded-lg shadow-sm text-gray-600 hover:bg-gray-100"
      >
        <IconFullscreen />
      </button>
    )}
  </div>
);

// ---------- Sidebar-Toggle (Desktop) ----------

interface SidebarToggleProps {
  collapsed: boolean;
  onToggle: () => void;
}

const SidebarToggle: React.FC<SidebarToggleProps> = ({ collapsed, onToggle }) => (
  <button
    onClick={onToggle}
    title={collapsed ? "Menü einblenden" : "Menü ausblenden"}
    className="hidden lg:flex items-center justify-center w-8 h-8 bg-white border border-gray-200 rounded-lg shadow-sm text-gray-500 hover:bg-gray-50 hover:text-gray-800"
  >
    <IconSidebar />
  </button>
);

// ---------- Galerie ----------

interface GalleryProps {
  onAddFigure: (type: ShapeType) => void;
  onAddAnchor: (shape: AnchorShape) => void;
  onAddNote: () => void;
  onDragStartTemplate: (e: React.DragEvent, kind: "figure" | "anchor" | "note", value?: ShapeType | AnchorShape) => void;
  splitBoard: boolean;
  onToggleSplit: () => void;
  showFrame: boolean;
  onToggleFrame: () => void;
}

const Gallery: React.FC<GalleryProps> = ({
  onAddFigure,
  onAddAnchor,
  onAddNote,
  onDragStartTemplate,
  splitBoard,
  onToggleSplit,
  showFrame,
  onToggleFrame,
}) => {
  const figureTemplates: ShapeType[] = ["circle", "square", "triangle"];
  const anchorTemplates: AnchorShape[] = ["rect", "circle", "triangle"];

  return (
    <div className="w-full lg:w-64 shrink-0 bg-white border border-gray-200 rounded-xl p-4 flex flex-col gap-4 shadow-sm">
      <div>
        <h2 className="text-sm font-semibold text-gray-700 mb-1">Figuren</h2>
        <p className="text-xs text-gray-400 mb-3">Ziehen oder klicken, um aufs Brett zu setzen</p>
        <div className="flex gap-2">
          {figureTemplates.map((type) => (
            <button
              key={type}
              draggable
              onDragStart={(e) => onDragStartTemplate(e, "figure", type)}
              onClick={() => onAddFigure(type)}
              className="flex items-center justify-center rounded-lg border border-gray-200 p-2.5 hover:bg-gray-50 active:bg-gray-100 cursor-grab active:cursor-grabbing transition-colors"
              title={`${SHAPE_LABELS[type]} hinzufügen`}
            >
              <ShapeSvg type={type} color="yellow" size={32} />
            </button>
          ))}
        </div>
      </div>

      <div className="pt-3 border-t border-gray-100">
        <h2 className="text-sm font-semibold text-gray-700 mb-1">Formen</h2>
        <p className="text-xs text-gray-400 mb-3">Für Orte, Themen, Ressourcen etc.</p>
        <div className="flex gap-2">
          {anchorTemplates.map((shape) => (
            <button
              key={shape}
              draggable
              onDragStart={(e) => onDragStartTemplate(e, "anchor", shape)}
              onClick={() => onAddAnchor(shape)}
              className="flex items-center justify-center rounded-lg border border-gray-200 p-2.5 hover:bg-gray-50 active:bg-gray-100 cursor-grab active:cursor-grabbing transition-colors"
              title={ANCHOR_SHAPE_LABELS[shape]}
            >
              <AnchorPreview shape={shape} color="gray" size={32} />
            </button>
          ))}
        </div>
      </div>

      <div className="pt-3 border-t border-gray-100">
        <h2 className="text-sm font-semibold text-gray-700 mb-1">Post-its</h2>
        <p className="text-xs text-gray-400 mb-3">Für Notizen, Zitate, Beobachtungen</p>
        <div className="flex gap-2">
          <button
            draggable
            onDragStart={(e) => onDragStartTemplate(e, "note")}
            onClick={onAddNote}
            className="flex items-center justify-center rounded-lg border border-gray-200 p-2.5 hover:bg-gray-50 active:bg-gray-100 cursor-grab active:cursor-grabbing transition-colors"
            title="Post-it hinzufügen"
          >
            <NotePreview color="yellow" size={32} />
          </button>
        </div>
      </div>

      <div className="pt-3 border-t border-gray-100">
        <h2 className="text-sm font-semibold text-gray-700 mb-2">Brett</h2>
        <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none mb-2">
          <input type="checkbox" checked={splitBoard} onChange={onToggleSplit} className="accent-gray-700" />
          Trennlinie anzeigen
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
          <input type="checkbox" checked={showFrame} onChange={onToggleFrame} className="accent-gray-700" />
          Rahmen anzeigen
        </label>
        <p className="text-xs text-gray-400 mt-3">
          Tipp: Ausgewählte Elemente lassen sich mit Strg/Cmd+C und Strg/Cmd+V duplizieren, oder mit der Entf-Taste löschen.
        </p>
      </div>
    </div>
  );
};

// ---------- Kontextpanel: Figur ----------

interface FigurePanelProps {
  figure: Figure;
  onChange: (id: string, patch: Partial<Figure>) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

const FigurePanel: React.FC<FigurePanelProps> = ({ figure, onChange, onDelete, onClose }) => {
  return (
    <div className="w-full lg:w-64 shrink-0 bg-white border border-gray-200 rounded-xl p-4 flex flex-col gap-4 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">Figur</h2>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xs">
          × schließen
        </button>
      </div>

      <div className="flex justify-center">
        <ShapeSvg type={figure.type} color={figure.color} size={64} rotation={figure.rotation} selected />
      </div>

      <p className="text-xs text-gray-400 -mt-2 text-center">
        Blickrichtung: am runden Griff oben ziehen. Größe: an den Eck-Griffen ziehen.
      </p>

      <div>
        <label className="text-xs text-gray-500 block mb-1">Name</label>
        <input
          value={figure.label}
          onChange={(e) => onChange(figure.id, { label: e.target.value })}
          placeholder="Bezeichnung eingeben..."
          className="w-full border border-gray-200 rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-gray-300"
        />
      </div>

      <div>
        <label className="text-xs text-gray-500 block mb-2">Farbe</label>
        <div className="flex gap-2">
          {(Object.keys(COLOR_STYLES) as ColorKey[]).map((key) => (
            <button
              key={key}
              title={COLOR_STYLES[key].label}
              onClick={() => onChange(figure.id, { color: key })}
              className={`w-7 h-7 rounded-full border-2 transition-transform ${
                figure.color === key ? "border-gray-800 scale-110" : "border-gray-200"
              }`}
              style={{ backgroundColor: COLOR_STYLES[key].base }}
            />
          ))}
        </div>
      </div>

      <button
        onClick={() => onDelete(figure.id)}
        className="mt-2 text-sm text-red-500 hover:text-red-600 border border-red-200 rounded-md py-1.5 hover:bg-red-50 transition-colors"
      >
        Figur entfernen
      </button>
    </div>
  );
};

// ---------- Kontextpanel: Form (Bodenanker) ----------

interface AnchorPanelProps {
  anchor: Anchor;
  onChange: (id: string, patch: Partial<Anchor>) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

const AnchorPanel: React.FC<AnchorPanelProps> = ({ anchor, onChange, onDelete, onClose }) => {
  return (
    <div className="w-full lg:w-64 shrink-0 bg-white border border-gray-200 rounded-xl p-4 flex flex-col gap-4 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">Form</h2>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xs">
          × schließen
        </button>
      </div>

      <div className="flex justify-center">
        <div className="w-16 h-16">
          <AnchorShapeDiv shape={anchor.shape} color={anchor.color} selected />
        </div>
      </div>

      <p className="text-xs text-gray-400 -mt-2 text-center">Größe: an den Eck-Griffen auf dem Brett ziehen</p>

      <div>
        <label className="text-xs text-gray-500 block mb-1">Beschriftung</label>
        <input
          value={anchor.label}
          onChange={(e) => onChange(anchor.id, { label: e.target.value })}
          placeholder="z.B. Ziel, Ressource..."
          className="w-full border border-gray-200 rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-gray-300"
        />
      </div>

      <div>
        <label className="text-xs text-gray-500 block mb-2">Farbe</label>
        <div className="flex gap-2 flex-wrap">
          {(Object.keys(ANCHOR_COLOR_STYLES) as AnchorColorKey[]).map((key) => (
            <button
              key={key}
              title={ANCHOR_COLOR_STYLES[key].label}
              onClick={() => onChange(anchor.id, { color: key })}
              className={`w-7 h-7 rounded-full border-2 transition-transform ${
                anchor.color === key ? "border-gray-800 scale-110" : "border-gray-200"
              }`}
              style={{ backgroundColor: ANCHOR_COLOR_STYLES[key].fill, opacity: 0.7 }}
            />
          ))}
        </div>
      </div>

      <button
        onClick={() => onDelete(anchor.id)}
        className="mt-2 text-sm text-red-500 hover:text-red-600 border border-red-200 rounded-md py-1.5 hover:bg-red-50 transition-colors"
      >
        Form entfernen
      </button>
    </div>
  );
};

// ---------- Kontextpanel: Post-it ----------

interface NotePanelProps {
  note: Note;
  onChange: (id: string, patch: Partial<Note>) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

const NotePanel: React.FC<NotePanelProps> = ({ note, onChange, onDelete, onClose }) => {
  return (
    <div className="w-full lg:w-64 shrink-0 bg-white border border-gray-200 rounded-xl p-4 flex flex-col gap-4 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">Post-it</h2>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xs">
          × schließen
        </button>
      </div>

      <div className="flex justify-center">
        <div
          style={{ backgroundColor: NOTE_COLOR_STYLES[note.color].bg, width: 72, height: 64 }}
          className="rounded-sm shadow flex items-center justify-center p-1"
        >
          <span className="text-[10px] text-gray-700 text-center line-clamp-3">{note.text || "..."}</span>
        </div>
      </div>

      <p className="text-xs text-gray-400 -mt-2 text-center">Größe: am Eck-Griff auf dem Brett ziehen</p>

      <div>
        <label className="text-xs text-gray-500 block mb-1">Text</label>
        <textarea
          value={note.text}
          onChange={(e) => onChange(note.id, { text: e.target.value })}
          placeholder="Notiz eingeben..."
          rows={4}
          className="w-full border border-gray-200 rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-gray-300 resize-none"
        />
      </div>

      <div>
        <label className="text-xs text-gray-500 block mb-2">Farbe</label>
        <div className="flex gap-2">
          {(Object.keys(NOTE_COLOR_STYLES) as NoteColorKey[]).map((key) => (
            <button
              key={key}
              title={NOTE_COLOR_STYLES[key].label}
              onClick={() => onChange(note.id, { color: key })}
              className={`w-7 h-7 rounded-sm border-2 transition-transform ${
                note.color === key ? "border-gray-800 scale-110" : "border-gray-200"
              }`}
              style={{ backgroundColor: NOTE_COLOR_STYLES[key].bg }}
            />
          ))}
        </div>
      </div>

      <button
        onClick={() => onDelete(note.id)}
        className="mt-2 text-sm text-red-500 hover:text-red-600 border border-red-200 rounded-md py-1.5 hover:bg-red-50 transition-colors"
      >
        Post-it entfernen
      </button>
    </div>
  );
};

// ---------- Figur auf dem Brett ----------

interface BoardFigureProps {
  figure: Figure;
  boardSizePx: { width: number; height: number };
  isSelected: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, label: string) => void;
  onMove: (id: string, xPct: number, yPct: number) => void;
  onRotate: (id: string, rotation: number) => void;
  onResize: (id: string, sizePct: number) => void;
  boardRef: React.RefObject<HTMLDivElement>;
}

const BoardFigure: React.FC<BoardFigureProps> = ({
  figure,
  boardSizePx,
  isSelected,
  onSelect,
  onRename,
  onMove,
  onRotate,
  onResize,
  boardRef,
}) => {
  const [editingLabel, setEditingLabel] = useState(false);
  const [draft, setDraft] = useState(figure.label);
  const [dragging, setDragging] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [resizing, setResizing] = useState(false);
  const nodeRef = useRef<HTMLDivElement>(null);
  const resizeStartRef = useRef<{ startDist: number; sizePct: number } | null>(null);

  const size = (figure.sizePct / 100) * Math.max(boardSizePx.width, 1);

  const commitRename = () => {
    setEditingLabel(false);
    onRename(figure.id, draft.trim());
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (editingLabel) return;
    e.stopPropagation();
    onSelect(figure.id);
    setDragging(true);
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    const rect = boardRef.current?.getBoundingClientRect();
    if (!rect) return;
    const xPct = ((e.clientX - rect.left) / rect.width) * 100;
    const yPct = ((e.clientY - rect.top) / rect.height) * 100;
    onMove(figure.id, Math.min(99, Math.max(1, xPct)), Math.min(99, Math.max(1, yPct)));
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    setDragging(false);
    (e.target as Element).releasePointerCapture(e.pointerId);
  };

  const handleRotateStart = (e: React.PointerEvent) => {
    e.stopPropagation();
    onSelect(figure.id);
    setRotating(true);
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const handleRotateMove = (e: React.PointerEvent) => {
    if (!rotating) return;
    const node = nodeRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    const rad = Math.atan2(dx, -dy);
    let deg = (rad * 180) / Math.PI;
    deg = ((deg % 360) + 360) % 360;
    onRotate(figure.id, deg);
  };

  const handleRotateEnd = (e: React.PointerEvent) => {
    setRotating(false);
    (e.target as Element).releasePointerCapture(e.pointerId);
  };

  const handleResizeStart = (e: React.PointerEvent) => {
    e.stopPropagation();
    onSelect(figure.id);
    setResizing(true);
    const node = nodeRef.current;
    if (node) {
      const rect = node.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const startDist = Math.hypot(e.clientX - cx, e.clientY - cy);
      resizeStartRef.current = { startDist, sizePct: figure.sizePct };
    }
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const handleResizeMove = (e: React.PointerEvent) => {
    if (!resizing || !resizeStartRef.current) return;
    const node = nodeRef.current;
    if (!node) return;
    const nodeRect = node.getBoundingClientRect();
    const cx = nodeRect.left + nodeRect.width / 2;
    const cy = nodeRect.top + nodeRect.height / 2;
    const currentDist = Math.hypot(e.clientX - cx, e.clientY - cy);
    const { startDist, sizePct } = resizeStartRef.current;
    if (startDist < 1) return;
    const scaleFactor = currentDist / startDist;
    const newSize = Math.min(FIGURE_MAX_PCT, Math.max(FIGURE_MIN_PCT, sizePct * scaleFactor));
    onResize(figure.id, newSize);
  };

  const handleResizeEnd = (e: React.PointerEvent) => {
    setResizing(false);
    resizeStartRef.current = null;
    (e.target as Element).releasePointerCapture(e.pointerId);
  };

  const handleLabelToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraft(figure.label);
    setEditingLabel(true);
  };

  const half = size / 2;
  const cornerRadius = half * Math.SQRT2;
  const cornerAngles = [45, 135, 225, 315];
  const rotateHandleRadius = half + 20;

  return (
    <div
      ref={nodeRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={handleLabelToggle}
      style={{
        position: "absolute",
        left: `${figure.x}%`,
        top: `${figure.y}%`,
        width: size,
        height: size,
        transform: "translate(-50%, -50%)",
        cursor: dragging ? "grabbing" : "grab",
        touchAction: "none",
        zIndex: dragging || rotating || resizing ? 30 : isSelected ? 20 : 10,
        outline: "none",
        border: "none",
        background: "transparent",
      }}
      className="select-none"
    >
      <div
        style={{
          position: "relative",
          width: size,
          height: size,
          outline: "none",
          border: "none",
          background: "transparent",
        }}
      >
        <ShapeSvg type={figure.type} color={figure.color} size={size} rotation={figure.rotation} selected={isSelected} />

        {!editingLabel && figure.label && (
          <div
            className="absolute inset-0 flex items-center justify-center pointer-events-none px-1"
            onDoubleClick={handleLabelToggle}
          >
            <span
              className="text-[11px] font-medium text-black/80 text-center leading-tight px-1 truncate"
              style={{ maxWidth: "90%", textShadow: "0 1px 2px rgba(255,255,255,0.6)" }}
            >
              {figure.label}
            </span>
          </div>
        )}

        {isSelected && !editingLabel && (
          <div
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: 0,
              height: 0,
              transform: `rotate(${figure.rotation}deg)`,
              transformOrigin: "0 0",
              background: "transparent",
            }}
          >
            <div
              onPointerDown={handleRotateStart}
              onPointerMove={handleRotateMove}
              onPointerUp={handleRotateEnd}
              title="Ziehen, um die Blickrichtung zu drehen"
              style={{
                position: "absolute",
                left: 0,
                top: -rotateHandleRadius,
                width: 16,
                height: 16,
                marginLeft: -8,
                marginTop: -8,
                touchAction: "none",
                cursor: rotating ? "grabbing" : "grab",
                zIndex: 40,
              }}
              className="rounded-full bg-white border-2 border-gray-700 shadow flex items-center justify-center"
            >
              <div className="w-1.5 h-1.5 rounded-full bg-gray-700" />
            </div>

            <div
              style={{
                position: "absolute",
                left: -1,
                top: -rotateHandleRadius + 8,
                width: 2,
                height: rotateHandleRadius - half - 8,
                backgroundColor: "#9ca3af",
              }}
            />

            {cornerAngles.map((angle) => {
              const rad = (angle * Math.PI) / 180;
              const hx = cornerRadius * Math.sin(rad);
              const hy = -cornerRadius * Math.cos(rad);
              return (
                <div
                  key={angle}
                  onPointerDown={handleResizeStart}
                  onPointerMove={handleResizeMove}
                  onPointerUp={handleResizeEnd}
                  title="Ziehen, um die Größe zu ändern (Seitenverhältnis bleibt fest)"
                  style={{
                    position: "absolute",
                    left: hx,
                    top: hy,
                    width: 10,
                    height: 10,
                    marginLeft: -5,
                    marginTop: -5,
                    touchAction: "none",
                    cursor: resizing ? "grabbing" : "nwse-resize",
                    zIndex: 40,
                  }}
                  className="rounded-full bg-white border-2 border-blue-500 shadow"
                />
              );
            })}
          </div>
        )}

        {isSelected && editingLabel && (
          <div
            className="absolute inset-0 flex items-center justify-center"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") {
                  setDraft(figure.label);
                  setEditingLabel(false);
                }
              }}
              placeholder="Name..."
              className="text-xs text-center border border-gray-300 rounded px-1 py-0.5 w-20 bg-white shadow-sm"
            />
          </div>
        )}

        {isSelected && !editingLabel && !figure.label && (
          <div
            className="absolute left-1/2 -translate-x-1/2 flex justify-center"
            style={{ top: "100%", marginTop: 6, width: "max-content", background: "transparent" }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              onClick={handleLabelToggle}
              className="text-[10px] text-gray-400 border border-dashed border-gray-300 rounded px-1.5 py-0.5 bg-white/70 hover:text-gray-600 hover:border-gray-400"
            >
              + Name
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

// ---------- Generischer Hook: Ecken-basiertes Ziehen (Verschieben) ----------

function useCornerDrag(
  x: number,
  y: number,
  onMove: (xPct: number, yPct: number) => void,
  boardRef: React.RefObject<HTMLDivElement>
) {
  const [dragging, setDragging] = useState(false);
  const grabOffsetRef = useRef<{ ox: number; oy: number } | null>(null);

  const handlePointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    const rect = boardRef.current?.getBoundingClientRect();
    if (!rect) return;
    const clickXPct = ((e.clientX - rect.left) / rect.width) * 100;
    const clickYPct = ((e.clientY - rect.top) / rect.height) * 100;
    grabOffsetRef.current = { ox: clickXPct - x, oy: clickYPct - y };
    setDragging(true);
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragging || !grabOffsetRef.current) return;
    const rect = boardRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mouseXPct = ((e.clientX - rect.left) / rect.width) * 100;
    const mouseYPct = ((e.clientY - rect.top) / rect.height) * 100;
    const newX = mouseXPct - grabOffsetRef.current.ox;
    const newY = mouseYPct - grabOffsetRef.current.oy;
    onMove(Math.min(99, Math.max(0, newX)), Math.min(99, Math.max(0, newY)));
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    setDragging(false);
    grabOffsetRef.current = null;
    (e.target as Element).releasePointerCapture(e.pointerId);
  };

  return { dragging, handlePointerDown, handlePointerMove, handlePointerUp };
}

// ---------- Hilfsfunktion: freies Eck-Resize (Formen, Post-its) ----------

interface FreeResizeStart {
  corner: CornerKey;
  startX: number;
  startY: number;
  boxX: number;
  boxY: number;
  boxW: number;
  boxH: number;
}

function computeFreeResize(
  start: FreeResizeStart,
  dxPct: number,
  dyPct: number,
  minPct: number,
  maxPct: number
) {
  const { corner, boxX, boxY, boxW, boxH } = start;
  const right = boxX + boxW;
  const bottom = boxY + boxH;

  let newX = boxX;
  let newY = boxY;
  let newW = boxW;
  let newH = boxH;

  if (corner === "tl") {
    newX = Math.min(boxX + dxPct, right - minPct);
    newY = Math.min(boxY + dyPct, bottom - minPct);
    newW = right - newX;
    newH = bottom - newY;
  } else if (corner === "tr") {
    newY = Math.min(boxY + dyPct, bottom - minPct);
    newW = boxW + dxPct;
    newH = bottom - newY;
  } else if (corner === "bl") {
    newX = Math.min(boxX + dxPct, right - minPct);
    newW = right - newX;
    newH = boxH + dyPct;
  } else {
    newW = boxW + dxPct;
    newH = boxH + dyPct;
  }

  newW = Math.min(maxPct, Math.max(minPct, newW));
  newH = Math.min(maxPct, Math.max(minPct, newH));

  if (corner === "tl" || corner === "bl") {
    newX = right - newW;
  }
  if (corner === "tl" || corner === "tr") {
    newY = bottom - newH;
  }

  return {
    x: Math.max(0, Math.min(99, newX)),
    y: Math.max(0, Math.min(99, newY)),
    widthPct: newW,
    heightPct: newH,
  };
}

const CORNER_CONFIG: { key: CornerKey; cursor: string }[] = [
  { key: "tl", cursor: "nwse-resize" },
  { key: "tr", cursor: "nesw-resize" },
  { key: "bl", cursor: "nesw-resize" },
  { key: "br", cursor: "nwse-resize" },
];

// ---------- Form (Bodenanker) auf dem Brett ----------

interface BoardAnchorProps {
  anchor: Anchor;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onMove: (id: string, xPct: number, yPct: number) => void;
  onResize: (id: string, xPct: number, yPct: number, widthPct: number, heightPct: number) => void;
  boardRef: React.RefObject<HTMLDivElement>;
}

const BoardAnchor: React.FC<BoardAnchorProps> = ({ anchor, isSelected, onSelect, onMove, onResize, boardRef }) => {
  const { dragging, handlePointerDown, handlePointerMove, handlePointerUp } = useCornerDrag(
    anchor.x,
    anchor.y,
    (x, y) => onMove(anchor.id, x, y),
    boardRef
  );
  const [resizing, setResizing] = useState(false);
  const resizeStartRef = useRef<FreeResizeStart | null>(null);

  const handleResizeStart = (corner: CornerKey) => (e: React.PointerEvent) => {
    e.stopPropagation();
    onSelect(anchor.id);
    setResizing(true);
    const rect = boardRef.current?.getBoundingClientRect();
    if (rect) {
      const startXPct = ((e.clientX - rect.left) / rect.width) * 100;
      const startYPct = ((e.clientY - rect.top) / rect.height) * 100;
      resizeStartRef.current = {
        corner,
        startX: startXPct,
        startY: startYPct,
        boxX: anchor.x,
        boxY: anchor.y,
        boxW: anchor.widthPct,
        boxH: anchor.heightPct,
      };
    }
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const handleResizeMove = (e: React.PointerEvent) => {
    if (!resizing || !resizeStartRef.current) return;
    const rect = boardRef.current?.getBoundingClientRect();
    if (!rect) return;
    const currentXPct = ((e.clientX - rect.left) / rect.width) * 100;
    const currentYPct = ((e.clientY - rect.top) / rect.height) * 100;
    const start = resizeStartRef.current;
    const dxPct = currentXPct - start.startX;
    const dyPct = currentYPct - start.startY;
    const result = computeFreeResize(start, dxPct, dyPct, ANCHOR_MIN_PCT, ANCHOR_MAX_PCT);
    onResize(anchor.id, result.x, result.y, result.widthPct, result.heightPct);
  };

  const handleResizeEnd = (e: React.PointerEvent) => {
    setResizing(false);
    resizeStartRef.current = null;
    (e.target as Element).releasePointerCapture(e.pointerId);
  };

  return (
    <div
      onPointerDown={(e) => {
        onSelect(anchor.id);
        handlePointerDown(e);
      }}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        left: `${anchor.x}%`,
        top: `${anchor.y}%`,
        width: `${anchor.widthPct}%`,
        height: `${anchor.heightPct}%`,
        cursor: dragging ? "grabbing" : "grab",
        touchAction: "none",
        zIndex: dragging || resizing ? 9 : isSelected ? 8 : 5,
      }}
      className="select-none"
    >
      <div className="relative w-full h-full">
        <AnchorShapeDiv shape={anchor.shape} color={anchor.color} selected={isSelected} />

        {anchor.label && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none px-1">
            <span className="text-[11px] leading-tight text-gray-700 text-center bg-white/70 rounded px-1 py-0.5 max-w-full truncate">
              {anchor.label}
            </span>
          </div>
        )}

        {isSelected &&
          CORNER_CONFIG.map(({ key, cursor }) => {
            const positionStyle: React.CSSProperties = { position: "absolute", width: 12, height: 12 };
            if (key === "tl") {
              positionStyle.top = -6;
              positionStyle.left = -6;
            } else if (key === "tr") {
              positionStyle.top = -6;
              positionStyle.right = -6;
            } else if (key === "bl") {
              positionStyle.bottom = -6;
              positionStyle.left = -6;
            } else {
              positionStyle.bottom = -6;
              positionStyle.right = -6;
            }
            return (
              <div
                key={key}
                onPointerDown={handleResizeStart(key)}
                onPointerMove={handleResizeMove}
                onPointerUp={handleResizeEnd}
                title="Ziehen, um die Größe zu ändern (freies Seitenverhältnis)"
                className="rounded-sm bg-white border-2 border-gray-700 shadow"
                style={{ ...positionStyle, cursor, touchAction: "none", zIndex: 40 }}
              />
            );
          })}
      </div>
    </div>
  );
};

// ---------- Post-it auf dem Brett ----------

interface BoardNoteProps {
  note: Note;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onMove: (id: string, xPct: number, yPct: number) => void;
  onResize: (id: string, widthPct: number, heightPct: number) => void;
  onEditText: (id: string, text: string) => void;
  boardRef: React.RefObject<HTMLDivElement>;
}

const BoardNote: React.FC<BoardNoteProps> = ({ note, isSelected, onSelect, onMove, onResize, onEditText, boardRef }) => {
  const { dragging, handlePointerDown, handlePointerMove, handlePointerUp } = useCornerDrag(
    note.x,
    note.y,
    (x, y) => onMove(note.id, x, y),
    boardRef
  );
  const [resizing, setResizing] = useState(false);
  const [editing, setEditing] = useState(false);
  const resizeStartRef = useRef<{ startX: number; startY: number; w: number; h: number } | null>(null);

  const handleResizeStart = (e: React.PointerEvent) => {
    e.stopPropagation();
    onSelect(note.id);
    setResizing(true);
    resizeStartRef.current = { startX: e.clientX, startY: e.clientY, w: note.widthPct, h: note.heightPct };
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const handleResizeMove = (e: React.PointerEvent) => {
    if (!resizing || !resizeStartRef.current) return;
    const rect = boardRef.current?.getBoundingClientRect();
    if (!rect) return;
    const { startX, startY, w, h } = resizeStartRef.current;
    const dxPct = ((e.clientX - startX) / rect.width) * 100;
    const dyPct = ((e.clientY - startY) / rect.height) * 100;
    const newW = Math.min(NOTE_MAX_PCT, Math.max(NOTE_MIN_PCT, w + dxPct));
    const newH = Math.min(NOTE_MAX_PCT, Math.max(NOTE_MIN_PCT, h + dyPct));
    onResize(note.id, newW, newH);
  };

  const handleResizeEnd = (e: React.PointerEvent) => {
    setResizing(false);
    resizeStartRef.current = null;
    (e.target as Element).releasePointerCapture(e.pointerId);
  };

  return (
    <div
      onPointerDown={(e) => {
        if (editing) return;
        onSelect(note.id);
        handlePointerDown(e);
      }}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onSelect(note.id);
        setEditing(true);
      }}
      style={{
        position: "absolute",
        left: `${note.x}%`,
        top: `${note.y}%`,
        width: `${note.widthPct}%`,
        height: `${note.heightPct}%`,
        cursor: editing ? "text" : dragging ? "grabbing" : "grab",
        touchAction: "none",
        zIndex: dragging || resizing || editing ? 19 : isSelected ? 18 : 15,
      }}
      className="select-none"
    >
      <div
        className="relative w-full h-full rounded-sm p-1.5 overflow-hidden flex items-center justify-center"
        style={{
          backgroundColor: NOTE_COLOR_STYLES[note.color].bg,
          boxShadow: isSelected ? "0 4px 10px rgba(0,0,0,0.25)" : "0 2px 5px rgba(0,0,0,0.15)",
        }}
      >
        {editing ? (
          <textarea
            autoFocus
            value={note.text}
            onChange={(e) => onEditText(note.id, e.target.value)}
            onBlur={() => setEditing(false)}
            onPointerDown={(e) => e.stopPropagation()}
            className="w-full h-full bg-transparent resize-none outline-none text-[11px] text-gray-800 leading-tight text-center"
            style={{ textAlign: "center" }}
          />
        ) : (
          <span className="text-[11px] text-gray-800 leading-tight whitespace-pre-wrap break-words text-center">
            {note.text || <span className="text-gray-500 italic">Doppelklick zum Beschriften</span>}
          </span>
        )}

        {isSelected && !editing && (
          <div
            onPointerDown={handleResizeStart}
            onPointerMove={handleResizeMove}
            onPointerUp={handleResizeEnd}
            title="Ziehen, um die Größe zu ändern"
            className="absolute -bottom-2 -right-2 w-4 h-4 rounded-sm bg-white border-2 border-gray-700 shadow"
            style={{ cursor: "nwse-resize", touchAction: "none", zIndex: 40 }}
          />
        )}
      </div>
    </div>
  );
};

// ---------- Board-Inhalt (Brett + Figuren/Formen/Post-its) ----------

interface BoardContentProps {
  boardMaxPx: number;
  showFrame: boolean;
  splitBoard: boolean;
  figures: Figure[];
  anchors: Anchor[];
  notes: Note[];
  selected: Selectable;
  boardSizePx: { width: number; height: number };
  boardRef: React.RefObject<HTMLDivElement>;
  boardAttachRef: (node: HTMLDivElement | null) => void;
  boardCaptureRef: React.RefObject<HTMLDivElement>;
  onSelect: (sel: Selectable) => void;
  onBoardDragOver: (e: React.DragEvent) => void;
  onBoardDrop: (e: React.DragEvent) => void;
  onMoveFigure: (id: string, x: number, y: number) => void;
  onRotateFigure: (id: string, r: number) => void;
  onResizeFigure: (id: string, s: number) => void;
  onRenameFigure: (id: string, l: string) => void;
  onMoveAnchor: (id: string, x: number, y: number) => void;
  onResizeAnchor: (id: string, x: number, y: number, w: number, h: number) => void;
  onMoveNote: (id: string, x: number, y: number) => void;
  onResizeNote: (id: string, w: number, h: number) => void;
  onEditNoteText: (id: string, t: string) => void;
}

const BoardContent: React.FC<BoardContentProps> = ({
  boardMaxPx,
  showFrame,
  splitBoard,
  figures,
  anchors,
  notes,
  selected,
  boardSizePx,
  boardRef,
  boardAttachRef,
  boardCaptureRef,
  onSelect,
  onBoardDragOver,
  onBoardDrop,
  onMoveFigure,
  onRotateFigure,
  onResizeFigure,
  onRenameFigure,
  onMoveAnchor,
  onResizeAnchor,
  onMoveNote,
  onResizeNote,
  onEditNoteText,
}) => (
  <div
    ref={boardCaptureRef}
    className="relative rounded-xl overflow-hidden"
    style={{
      width: `${boardMaxPx}px`,
      height: `${boardMaxPx}px`,
      background: "linear-gradient(135deg, #f3d9ae 0%, #e8c58c 50%, #dfb877 100%)",
      boxShadow:
        "inset 0 2px 10px rgba(120, 80, 30, 0.25), inset 0 0 40px rgba(120, 80, 30, 0.12), 0 8px 20px rgba(0,0,0,0.15)",
    }}
  >
    <svg width="100%" height="100%" className="absolute inset-0 pointer-events-none" style={{ mixBlendMode: "multiply" }}>
      <rect x="0" y="0" width="100%" height="100%" fill="#c9985f" filter="url(#woodGrainBoard)" opacity={0.55} />
    </svg>

    {showFrame && (
      <div
        className="absolute pointer-events-none"
        style={{
          left: "6%",
          top: "6%",
          right: "6%",
          bottom: "6%",
          border: "3px solid #8b5a2b",
          borderRadius: "2px",
          boxShadow: "0 1px 2px rgba(255,255,255,0.3) inset",
        }}
      />
    )}

    <div
      ref={boardAttachRef}
      onDragOver={onBoardDragOver}
      onDrop={onBoardDrop}
      onClick={() => onSelect(null)}
      className="absolute"
      style={{ left: "6%", top: "6%", right: "6%", bottom: "6%" }}
    >
      {splitBoard && (
        <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-amber-800/40 -translate-x-1/2 pointer-events-none z-0" />
      )}

      {figures.length === 0 && anchors.length === 0 && notes.length === 0 && (
        <p className="absolute inset-0 flex items-center justify-center text-amber-800/40 text-sm pointer-events-none z-10 text-center px-6">
          Figuren, Formen oder Post-its aus der Galerie hierher ziehen
        </p>
      )}

      {anchors.map((a) => (
        <BoardAnchor
          key={a.id}
          anchor={a}
          isSelected={selected?.id === a.id}
          onSelect={(id) => onSelect({ id, kind: "anchor" })}
          onMove={onMoveAnchor}
          onResize={onResizeAnchor}
          boardRef={boardRef}
        />
      ))}

      {notes.map((n) => (
        <BoardNote
          key={n.id}
          note={n}
          isSelected={selected?.id === n.id}
          onSelect={(id) => onSelect({ id, kind: "note" })}
          onMove={onMoveNote}
          onResize={onResizeNote}
          onEditText={onEditNoteText}
          boardRef={boardRef}
        />
      ))}

      {figures.map((fig) => (
        <BoardFigure
          key={fig.id}
          figure={fig}
          boardSizePx={boardSizePx}
          isSelected={selected?.id === fig.id}
          onSelect={(id) => onSelect({ id, kind: "figure" })}
          onRename={onRenameFigure}
          onMove={onMoveFigure}
          onRotate={onRotateFigure}
          onResize={onResizeFigure}
          boardRef={boardRef}
        />
      ))}
    </div>
  </div>
);

// ---------- Hauptkomponente ----------

type Selectable = { id: string; kind: "figure" | "anchor" | "note" } | null;

const Systembrett: React.FC = () => {
  const [figures, setFigures] = useState<Figure[]>([]);
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [selected, setSelected] = useState<Selectable>(null);
  const [splitBoard, setSplitBoard] = useState(true);
  const [showFrame, setShowFrame] = useState(true);
  const [zoom, setZoom] = useState(getInitialZoom);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(true);
  const [isExporting, setIsExporting] = useState(false);
  const draggedTemplateRef = useRef<{ kind: "figure" | "anchor" | "note"; value?: ShapeType | AnchorShape } | null>(null);
  const clipboardRef = useRef<ClipboardItem | null>(null);
  const appRootRef = useRef<HTMLDivElement>(null);
  const boardCaptureRef = useRef<HTMLDivElement>(null);

  // Bugfix: "attachRef" wird als JSX-ref-Prop verwendet (Callback-Ref, der
  // bei jedem Mount/Unmount den ResizeObserver neu bindet). "ref" bleibt
  // ein normales RefObject für .current-Zugriffe in Drag-Handlern.
  const { ref: boardRef, attachRef: boardAttachRef, size: boardSizePx } = useElementSize<HTMLDivElement>();

  const selectedFigure = selected?.kind === "figure" ? figures.find((f) => f.id === selected.id) ?? null : null;
  const selectedAnchor = selected?.kind === "anchor" ? anchors.find((a) => a.id === selected.id) ?? null : null;
  const selectedNote = selected?.kind === "note" ? notes.find((n) => n.id === selected.id) ?? null : null;

  const clampPercent = (v: number) => Math.min(99, Math.max(1, v));

  const handleToggleFullscreen = () => {
    if (getFullscreenElement()) {
      exitFullscreen();
    } else if (appRootRef.current) {
      requestFullscreenOn(appRootRef.current);
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      const active = !!getFullscreenElement();
      setIsFullscreen(active);
      if (active) {
        setZoom(computeFullscreenZoom());
      } else {
        setZoom(getInitialZoom());
		setSidebarCollapsed(false);
      }
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", handleFullscreenChange);
    };
  }, []);

  const handleSaveAsImage = async () => {
    if (!boardCaptureRef.current || isExporting) return;
    setIsExporting(true);
    const previousSelection = selected;
    setSelected(null);
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const dataUrl = await toPng(boardCaptureRef.current, {
        pixelRatio: 2,
        backgroundColor: undefined,
      });
      const link = document.createElement("a");
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      link.download = `systembrett-${timestamp}.png`;
      link.href = dataUrl;
      link.click();
    } catch (err) {
      console.error("Export als Bild fehlgeschlagen:", err);
    } finally {
      setSelected(previousSelection);
      setIsExporting(false);
    }
  };

  const createFigure = useCallback(
    (type: ShapeType, xPct = 50, yPct = 50): Figure => ({
      id: nextId("fig"),
      kind: "figure",
      type,
      label: "",
      x: clampPercent(xPct),
      y: clampPercent(yPct),
      rotation: 0,
      color: "yellow",
      sizePct: FIGURE_DEFAULT_PCT,
    }),
    []
  );

  const createAnchor = useCallback(
    (shape: AnchorShape, xPct = 42, yPct = 42): Anchor => ({
      id: nextId("anchor"),
      kind: "anchor",
      shape,
      label: "",
      x: clampPercent(xPct),
      y: clampPercent(yPct),
      widthPct: ANCHOR_DEFAULT_PCT,
      heightPct: ANCHOR_DEFAULT_PCT,
      color: "gray",
    }),
    []
  );

  const createNote = useCallback(
    (xPct = 42, yPct = 42): Note => ({
      id: nextId("note"),
      kind: "note",
      text: "",
      x: clampPercent(xPct),
      y: clampPercent(yPct),
      widthPct: NOTE_DEFAULT_WIDTH_PCT,
      heightPct: NOTE_DEFAULT_HEIGHT_PCT,
      color: "yellow",
    }),
    []
  );

  const handleAddFigureFromSidebar = (type: ShapeType) => {
    const fig = createFigure(type, 50 + (Math.random() * 20 - 10), 50 + (Math.random() * 20 - 10));
    setFigures((prev) => [...prev, fig]);
    setSelected({ id: fig.id, kind: "figure" });
  };

  const handleAddAnchorFromSidebar = (shape: AnchorShape) => {
    const anchor = createAnchor(shape, 40 + Math.random() * 15, 40 + Math.random() * 15);
    setAnchors((prev) => [...prev, anchor]);
    setSelected({ id: anchor.id, kind: "anchor" });
  };

  const handleAddNoteFromSidebar = () => {
    const note = createNote(40 + Math.random() * 15, 40 + Math.random() * 15);
    setNotes((prev) => [...prev, note]);
    setSelected({ id: note.id, kind: "note" });
  };

  const handleTemplateDragStart = (
    e: React.DragEvent,
    kind: "figure" | "anchor" | "note",
    value?: ShapeType | AnchorShape
  ) => {
    draggedTemplateRef.current = { kind, value };
    e.dataTransfer.effectAllowed = "copy";
  };

  const getBoardRelativePosition = (clientX: number, clientY: number) => {
    const rect = boardRef.current?.getBoundingClientRect();
    if (!rect) return { x: 50, y: 50 };
    const x = ((clientX - rect.left) / rect.width) * 100;
    const y = ((clientY - rect.top) / rect.height) * 100;
    return { x: clampPercent(x), y: clampPercent(y) };
  };

  const handleBoardDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };

  const handleBoardDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const template = draggedTemplateRef.current;
    if (!template) return;
    const { x, y } = getBoardRelativePosition(e.clientX, e.clientY);
    if (template.kind === "figure") {
      const fig = createFigure(template.value as ShapeType, x, y);
      setFigures((prev) => [...prev, fig]);
      setSelected({ id: fig.id, kind: "figure" });
    } else if (template.kind === "anchor") {
      const anchor = createAnchor(template.value as AnchorShape, x, y);
      setAnchors((prev) => [...prev, anchor]);
      setSelected({ id: anchor.id, kind: "anchor" });
    } else {
      const note = createNote(x, y);
      setNotes((prev) => [...prev, note]);
      setSelected({ id: note.id, kind: "note" });
    }
    draggedTemplateRef.current = null;
  };

  const handleUpdateFigure = (id: string, patch: Partial<Figure>) => {
    setFigures((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  };

  const handleUpdateAnchor = (id: string, patch: Partial<Anchor>) => {
    setAnchors((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  };

  const handleUpdateNote = (id: string, patch: Partial<Note>) => {
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, ...patch } : n)));
  };

  const handleMoveFigure = (id: string, xPct: number, yPct: number) => {
    setFigures((prev) => prev.map((f) => (f.id === id ? { ...f, x: xPct, y: yPct } : f)));
  };

  const handleRotateFigure = (id: string, rotation: number) => {
    setFigures((prev) => prev.map((f) => (f.id === id ? { ...f, rotation } : f)));
  };

  const handleResizeFigure = (id: string, sizePct: number) => {
    setFigures((prev) => prev.map((f) => (f.id === id ? { ...f, sizePct } : f)));
  };

  const handleMoveAnchor = (id: string, xPct: number, yPct: number) => {
    setAnchors((prev) => prev.map((a) => (a.id === id ? { ...a, x: xPct, y: yPct } : a)));
  };

  const handleResizeAnchor = (id: string, xPct: number, yPct: number, widthPct: number, heightPct: number) => {
    setAnchors((prev) =>
      prev.map((a) => (a.id === id ? { ...a, x: xPct, y: yPct, widthPct, heightPct } : a))
    );
  };

  const handleMoveNote = (id: string, xPct: number, yPct: number) => {
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, x: xPct, y: yPct } : n)));
  };

  const handleResizeNote = (id: string, widthPct: number, heightPct: number) => {
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, widthPct, heightPct } : n)));
  };

  const handleEditNoteText = (id: string, text: string) => {
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, text } : n)));
  };

  const handleRenameFigure = (id: string, label: string) => {
    handleUpdateFigure(id, { label });
  };

  const handleDeleteFigure = (id: string) => {
    setFigures((prev) => prev.filter((f) => f.id !== id));
    if (selected?.id === id) setSelected(null);
  };

  const handleDeleteAnchor = (id: string) => {
    setAnchors((prev) => prev.filter((a) => a.id !== id));
    if (selected?.id === id) setSelected(null);
  };

  const handleDeleteNote = (id: string) => {
    setNotes((prev) => prev.filter((n) => n.id !== id));
    if (selected?.id === id) setSelected(null);
  };

  const handleZoomIn = () => setZoom((z) => Math.min(ZOOM_MAX, Math.round((z + ZOOM_STEP) * 100) / 100));
  const handleZoomOut = () => setZoom((z) => Math.max(ZOOM_MIN, Math.round((z - ZOOM_STEP) * 100) / 100));
  const handleZoomReset = () => setZoom(isFullscreen ? computeFullscreenZoom() : getInitialZoom());

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const isCopy = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c";
      const isPaste = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v";
      const isDelete = e.key === "Delete" || e.key === "Backspace";

      if (isEditableTarget(e.target)) return;

      if (isCopy) {
        if (selectedFigure) {
          clipboardRef.current = { kind: "figure", data: selectedFigure };
        } else if (selectedAnchor) {
          clipboardRef.current = { kind: "anchor", data: selectedAnchor };
        }
      }

      if (isPaste && clipboardRef.current) {
        e.preventDefault();
        const item = clipboardRef.current;
        if (item.kind === "figure") {
          const newFig: Figure = {
            ...item.data,
            id: nextId("fig"),
            x: clampPercent(item.data.x + PASTE_OFFSET_PCT),
            y: clampPercent(item.data.y + PASTE_OFFSET_PCT),
          };
          setFigures((prev) => [...prev, newFig]);
          setSelected({ id: newFig.id, kind: "figure" });
          clipboardRef.current = { kind: "figure", data: newFig };
        } else {
          const newAnchor: Anchor = {
            ...item.data,
            id: nextId("anchor"),
            x: clampPercent(item.data.x + PASTE_OFFSET_PCT),
            y: clampPercent(item.data.y + PASTE_OFFSET_PCT),
          };
          setAnchors((prev) => [...prev, newAnchor]);
          setSelected({ id: newAnchor.id, kind: "anchor" });
          clipboardRef.current = { kind: "anchor", data: newAnchor };
        }
      }

      if (isDelete && selected) {
        e.preventDefault();
        if (selected.kind === "figure") {
          setFigures((prev) => prev.filter((f) => f.id !== selected.id));
        } else if (selected.kind === "anchor") {
          setAnchors((prev) => prev.filter((a) => a.id !== selected.id));
        } else if (selected.kind === "note") {
          setNotes((prev) => prev.filter((n) => n.id !== selected.id));
        }
        setSelected(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selected, selectedFigure, selectedAnchor]);

  const hasSelection = selected !== null;
  const boardMaxPx = Math.round(BOARD_BASE_PX * zoom);

  const menuColumn = (
    <div className="flex items-start gap-0 relative">
      <div
        className="overflow-hidden transition-all duration-300 ease-in-out"
        style={{
          maxWidth: sidebarCollapsed ? 0 : 1000,
          opacity: sidebarCollapsed ? 0 : 1,
        }}
      >
        <div className="w-full lg:w-64 shrink-0 px-4 sm:px-0">
          <button
            onClick={() => setMobileMenuOpen((o) => !o)}
            className="lg:hidden w-full flex items-center justify-between text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-xl px-4 py-2.5 mb-2 shadow-sm"
          >
            Menü
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              style={{ transform: mobileMenuOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s" }}
            >
              <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          <div
            className="lg:!max-h-none lg:!opacity-100 overflow-hidden transition-all duration-300 ease-in-out"
            style={{
              maxHeight: mobileMenuOpen ? 2000 : 0,
              opacity: mobileMenuOpen ? 1 : 0,
            }}
          >
            {!hasSelection && (
              <Gallery
                onAddFigure={handleAddFigureFromSidebar}
                onAddAnchor={handleAddAnchorFromSidebar}
                onAddNote={handleAddNoteFromSidebar}
                onDragStartTemplate={handleTemplateDragStart}
                splitBoard={splitBoard}
                onToggleSplit={() => setSplitBoard((s) => !s)}
                showFrame={showFrame}
                onToggleFrame={() => setShowFrame((s) => !s)}
              />
            )}

            {selectedFigure && (
              <FigurePanel
                figure={selectedFigure}
                onChange={handleUpdateFigure}
                onDelete={handleDeleteFigure}
                onClose={() => setSelected(null)}
              />
            )}
            {selectedAnchor && (
              <AnchorPanel
                anchor={selectedAnchor}
                onChange={handleUpdateAnchor}
                onDelete={handleDeleteAnchor}
                onClose={() => setSelected(null)}
              />
            )}
            {selectedNote && (
              <NotePanel
                note={selectedNote}
                onChange={handleUpdateNote}
                onDelete={handleDeleteNote}
                onClose={() => setSelected(null)}
              />
            )}
          </div>
        </div>
      </div>

      <SidebarToggle collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed((c) => !c)} />
    </div>
  );

  const boardContentProps: Omit<BoardContentProps, "boardMaxPx"> = {
    showFrame,
    splitBoard,
    figures,
    anchors,
    notes,
    selected,
    boardSizePx,
    boardRef,
    boardAttachRef,
    boardCaptureRef,
    onSelect: setSelected,
    onBoardDragOver: handleBoardDragOver,
    onBoardDrop: handleBoardDrop,
    onMoveFigure: handleMoveFigure,
    onRotateFigure: handleRotateFigure,
    onResizeFigure: handleResizeFigure,
    onRenameFigure: handleRenameFigure,
    onMoveAnchor: handleMoveAnchor,
    onResizeAnchor: handleResizeAnchor,
    onMoveNote: handleMoveNote,
    onResizeNote: handleResizeNote,
    onEditNoteText: handleEditNoteText,
  };

  return (
    <div
      ref={appRootRef}
      className="w-full min-h-screen bg-gray-50 relative"
      style={
        isFullscreen
          ? { display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }
          : undefined
      }
    >
      <WoodDefs />

      {isFullscreen && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100]">
          <Toolbar
            zoom={zoom}
            onZoomIn={handleZoomIn}
            onZoomOut={handleZoomOut}
            onReset={handleZoomReset}
            isFullscreen={isFullscreen}
            onToggleFullscreen={handleToggleFullscreen}
            onSaveAsImage={handleSaveAsImage}
            isExporting={isExporting}
          />
        </div>
      )}

      {!isFullscreen && (
        <div className="w-full px-0 py-4 sm:p-6 flex flex-col lg:flex-row gap-4 items-start justify-center">
          <div className="order-1 lg:order-2 w-full lg:flex-1 flex flex-col items-center gap-2 min-w-0">
            <div className="w-full overflow-auto rounded-xl" style={{ maxHeight: "85vh" }}>
              <div className="relative inline-block p-2">
                <div className="sticky top-2 left-2 z-50 inline-block mb-2">
                  <Toolbar
                    zoom={zoom}
                    onZoomIn={handleZoomIn}
                    onZoomOut={handleZoomOut}
                    onReset={handleZoomReset}
                    isFullscreen={isFullscreen}
                    onToggleFullscreen={handleToggleFullscreen}
                    onSaveAsImage={handleSaveAsImage}
                    isExporting={isExporting}
                  />
                </div>

                <BoardContent boardMaxPx={boardMaxPx} {...boardContentProps} />
              </div>
            </div>
          </div>

          <div className="order-2 lg:order-1">{menuColumn}</div>
        </div>
      )}

      {isFullscreen && (
        <div className="flex-1 flex items-center justify-center gap-4 w-full overflow-auto px-4">
          {menuColumn}
          <BoardContent boardMaxPx={boardMaxPx} {...boardContentProps} />
        </div>
      )}
    </div>
  );
};

export default Systembrett;

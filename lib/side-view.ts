import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  HStack,
  isViewportTUI,
  matchesKey,
  type OverlayHandle,
  truncateToWidth,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  type ViewportTUI,
  visibleWidth,
  VStack,
} from "@earendil-works/pi-tui";
import { clampText } from "./bpmn-canvas.ts";
import { getNodeBadge, getNodeKindLabel, layoutAndRenderBpmn, type RenderedBpmn } from "./bpmn-layout.ts";
import type { BpmnModel, BpmnNode, DockPreference, LayoutOrientation, ResolvedDock, ZoomLevel } from "./types.ts";

export const MIN_SPLIT_TERM_WIDTH = 72;
export const MIN_PORTRAIT_TERM_WIDTH = 44;
export const MIN_PORTRAIT_TERM_HEIGHT = 24;
export const DEFAULT_SIZE_PERCENT = 45;
export const MIN_SIZE_PERCENT = 20;
export const MAX_SIZE_PERCENT = 75;

const ZOOM_ORDER: readonly ZoomLevel[] = ["fit", "compact", "detail"];
const DOCK_CYCLE: readonly DockPreference[] = ["auto", "right", "top", "bottom"];

function zoomShortLabel(zoom: ZoomLevel): string {
  if (zoom === "fit") return "FIT";
  if (zoom === "compact") return "CMP";
  return "DET";
}

function dockShortLabel(pref: DockPreference, resolved: ResolvedDock): string {
  const r = resolved === "right" ? "R" : resolved === "top" ? "T" : "B";
  return pref === "auto" ? `A:${r}` : r;
}

/** Decide active dock placement based on user preference and terminal aspect ratio. */
export function resolveDock(pref: DockPreference, cols: number, rows: number): ResolvedDock | null {
  if (cols < MIN_PORTRAIT_TERM_WIDTH || rows < 14) return null;
  if (pref === "right") {
    return cols >= MIN_SPLIT_TERM_WIDTH ? "right" : rows >= MIN_PORTRAIT_TERM_HEIGHT ? "top" : null;
  }
  if (pref === "top" || pref === "bottom") {
    return rows >= MIN_PORTRAIT_TERM_HEIGHT ? pref : cols >= MIN_SPLIT_TERM_WIDTH ? "right" : null;
  }
  // Auto mode: portrait / tall-narrow terminal -> top split; landscape -> right split
  if ((cols < 100 && rows >= 34) || (cols < MIN_SPLIT_TERM_WIDTH && rows >= MIN_PORTRAIT_TERM_HEIGHT)) {
    return "top";
  }
  if (cols >= MIN_SPLIT_TERM_WIDTH) return "right";
  return null;
}

export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SideViewCallbacks {
  getTheme: () => Theme;
  getTerminalSize: () => { cols: number; rows: number };
  getResolvedDock: () => ResolvedDock;
  getDockPreference: () => DockPreference;
  onSizeChange: (sizePercent: number) => void;
  onDockCycle: () => void;
  onViewStateChange?: () => void;
  onClose: () => void;
  onUnfocus: () => void;
  onReload?: () => void;
}

export class BpmnSidePaneComponent implements Component, Focusable {
  focused = false;

  private model: BpmnModel | null = null;
  private sourceLabel = "";
  private orientation: LayoutOrientation = "tb";
  private zoom: ZoomLevel = "fit";
  private sizePercent = DEFAULT_SIZE_PERCENT;
  private selectedNodeId: string | undefined;
  private scrollX = 0;
  private scrollY = 0;
  private inspectorExpanded = false;
  private draggingDivider = false;
  private draggingCanvas: {
    lastX: number;
    lastY: number;
    moved: boolean;
    startLocalX: number;
    startLocalY: number;
  } | null = null;
  private rendered: RenderedBpmn | null = null;
  private renderedKey = "";
  private lastViewportW = 54;
  private lastViewportH = 26;
  private lastRenderHeight = 26;
  private headerDockX = { start: -1, end: -1 };
  private headerZoomX = { start: -1, end: -1 };
  private headerToggleX = { start: -1, end: -1 };
  private headerCloseX = { start: -1, end: -1 };
  private getTargetHeight: () => number;
  private requestRender: () => void;
  private callbacks: SideViewCallbacks;

  constructor(
    getTargetHeight: () => number,
    requestRender: () => void,
    callbacks: SideViewCallbacks,
  ) {
    this.getTargetHeight = getTargetHeight;
    this.requestRender = requestRender;
    this.callbacks = callbacks;
  }

  setModel(model: BpmnModel, sourceLabel: string, opts?: { preserveScroll?: boolean }): void {
    this.model = model;
    this.sourceLabel = sourceLabel;
    if (!opts?.preserveScroll) {
      this.scrollX = 0;
      this.scrollY = 0;
    }
    if (this.selectedNodeId && !model.nodes.some((n) => n.id === this.selectedNodeId)) {
      this.selectedNodeId = undefined;
    }
    this.rendered = null;
    this.renderedKey = "";
    const rendered = this.ensureRendered();
    if (!this.selectedNodeId && rendered && rendered.nodeOrder.length > 0) {
      this.selectedNodeId = rendered.nodeOrder[0];
      this.rendered = null;
      this.renderedKey = "";
    }
    this.invalidate();
    this.requestRender();
  }

  getModel(): BpmnModel | null {
    return this.model;
  }

  getOrientation(): LayoutOrientation {
    return this.orientation;
  }

  setOrientation(orientation: LayoutOrientation): void {
    if (this.orientation === orientation) return;
    this.orientation = orientation;
    this.scrollX = 0;
    this.scrollY = 0;
    this.rendered = null;
    this.renderedKey = "";
    this.callbacks.onViewStateChange?.();
    this.invalidate();
    this.requestRender();
  }

  getZoom(): ZoomLevel {
    return this.zoom;
  }

  setZoom(zoom: ZoomLevel): void {
    if (this.zoom === zoom) return;
    this.zoom = zoom;
    this.scrollX = 0;
    this.scrollY = 0;
    this.rendered = null;
    this.renderedKey = "";
    this.callbacks.onViewStateChange?.();
    this.invalidate();
    this.requestRender();
  }

  stepZoom(delta: 1 | -1): void {
    const idx = ZOOM_ORDER.indexOf(this.zoom);
    const nextIdx = Math.max(0, Math.min(ZOOM_ORDER.length - 1, idx + delta));
    this.setZoom(ZOOM_ORDER[nextIdx]!);
  }

  cycleZoom(): void {
    const idx = ZOOM_ORDER.indexOf(this.zoom);
    this.setZoom(ZOOM_ORDER[(idx + 1) % ZOOM_ORDER.length]!);
  }

  getSizePercent(): number {
    return this.sizePercent;
  }

  setSizePercent(percent: number): void {
    const clamped = Math.max(MIN_SIZE_PERCENT, Math.min(MAX_SIZE_PERCENT, Math.round(percent)));
    if (clamped === this.sizePercent) return;
    this.sizePercent = clamped;
    this.callbacks.onSizeChange(clamped);
    this.invalidate();
    this.requestRender();
  }

  getSelectedNodeId(): string | undefined {
    return this.selectedNodeId;
  }

  selectNode(nodeId: string | undefined, scrollIntoView = true): void {
    this.selectedNodeId = nodeId;
    this.rendered = null;
    this.renderedKey = "";
    this.ensureRendered();
    if (scrollIntoView && nodeId) this.scrollToNode(nodeId);
    this.invalidate();
    this.requestRender();
  }

  private ensureRendered(): RenderedBpmn | null {
    if (!this.model) return null;
    const dimKey = this.zoom === "fit" ? `${this.lastViewportW}x${this.lastViewportH}` : "fixed";
    const key = `${this.zoom}:${this.orientation}:${this.selectedNodeId ?? ""}:${dimKey}`;
    if (this.rendered && this.renderedKey === key) return this.rendered;
    this.rendered = layoutAndRenderBpmn(this.model, {
      orientation: this.orientation,
      zoom: this.zoom,
      selectedNodeId: this.selectedNodeId,
      availableWidth: this.lastViewportW,
      availableHeight: this.lastViewportH,
    });
    this.renderedKey = key;
    this.clampScroll();
    return this.rendered;
  }

  private clampScroll(): void {
    if (!this.rendered) {
      this.scrollX = 0;
      this.scrollY = 0;
      return;
    }
    const maxX = Math.max(0, this.rendered.width - this.lastViewportW);
    const maxY = Math.max(0, this.rendered.height - this.lastViewportH);
    this.scrollX = Math.max(0, Math.min(maxX, this.scrollX));
    this.scrollY = Math.max(0, Math.min(maxY, this.scrollY));
  }

  private scrollToNode(nodeId: string): void {
    const r = this.ensureRendered();
    if (!r) return;
    const rect = r.hitRects.find((h) => h.nodeId === nodeId);
    if (!rect) return;
    const targetX = Math.max(0, Math.floor(rect.x + rect.width / 2 - this.lastViewportW / 2));
    const targetY = Math.max(0, Math.floor(rect.y + rect.height / 2 - this.lastViewportH / 2));
    this.scrollX = targetX;
    this.scrollY = targetY;
    this.clampScroll();
  }

  panBy(dx: number, dy: number): void {
    this.scrollX += dx;
    this.scrollY += dy;
    this.clampScroll();
    this.invalidate();
    this.requestRender();
  }

  private cycleNode(delta: 1 | -1): void {
    const r = this.ensureRendered();
    if (!r || r.nodeOrder.length === 0) return;
    const idx = this.selectedNodeId ? r.nodeOrder.indexOf(this.selectedNodeId) : -1;
    const nextIdx = idx === -1 ? 0 : (idx + delta + r.nodeOrder.length) % r.nodeOrder.length;
    this.selectNode(r.nodeOrder[nextIdx], true);
  }

  invalidate(): void {
    // Lightweight re-render from cached canvas.
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "alt+g")) {
      this.callbacks.onUnfocus();
      return;
    }
    if (data === "q" || data === "Q") {
      this.callbacks.onClose();
      return;
    }
    if (data === "+" || data === "=") {
      this.stepZoom(1);
      return;
    }
    if (data === "-" || data === "_") {
      this.stepZoom(-1);
      return;
    }
    if (data === "f" || data === "F") {
      this.setZoom("fit");
      return;
    }
    if (data === "v" || data === "V") {
      this.callbacks.onDockCycle();
      return;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.panBy(0, 2);
      return;
    }
    if (matchesKey(data, "up") || data === "k") {
      this.panBy(0, -2);
      return;
    }
    if (matchesKey(data, "right") || data === "l") {
      this.panBy(4, 0);
      return;
    }
    if (matchesKey(data, "left") || data === "h") {
      this.panBy(-4, 0);
      return;
    }
    if (data === "L" || matchesKey(data, "shift+right")) {
      this.panBy(12, 0);
      return;
    }
    if (data === "H" || matchesKey(data, "shift+left")) {
      this.panBy(-12, 0);
      return;
    }
    if (matchesKey(data, "pageDown") || data === "d" || matchesKey(data, "ctrl+d")) {
      this.panBy(0, Math.max(4, Math.floor(this.lastViewportH / 2)));
      return;
    }
    if (matchesKey(data, "pageUp") || data === "u" || matchesKey(data, "ctrl+u")) {
      this.panBy(0, -Math.max(4, Math.floor(this.lastViewportH / 2)));
      return;
    }
    if (matchesKey(data, "tab") || data === "n") {
      this.cycleNode(1);
      return;
    }
    if (matchesKey(data, "shift+tab") || data === "p") {
      this.cycleNode(-1);
      return;
    }
    if (data === "o" || data === "O") {
      this.setOrientation(this.orientation === "tb" ? "lr" : "tb");
      return;
    }
    if (data === "[") {
      this.setSizePercent(this.sizePercent - 5);
      return;
    }
    if (data === "]") {
      this.setSizePercent(this.sizePercent + 5);
      return;
    }
    if (data === "i" || data === "I") {
      this.inspectorExpanded = !this.inspectorExpanded;
      this.invalidate();
      this.requestRender();
      return;
    }
    if (data === "0" || matchesKey(data, "home")) {
      this.scrollX = 0;
      this.scrollY = 0;
      this.invalidate();
      this.requestRender();
      return;
    }
    if (data === "r" || data === "R") {
      this.callbacks.onReload?.();
      return;
    }
  }

  private getGeometryOffsets(dock: ResolvedDock): {
    headerRow: number;
    canvasTopRow: number;
    canvasLeftCol: number;
  } {
    if (dock === "right") return { headerRow: 0, canvasTopRow: 2, canvasLeftCol: 2 };
    if (dock === "top") return { headerRow: 0, canvasTopRow: 2, canvasLeftCol: 1 };
    return { headerRow: 1, canvasTopRow: 3, canvasLeftCol: 1 };
  }

  private isOnResizeDivider(event: TuiMouseEvent, dock: ResolvedDock): boolean {
    if (dock === "right") return event.x <= 1;
    if (dock === "top") return event.y >= this.lastRenderHeight - 1;
    return event.y === 0;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const dock = this.callbacks.getResolvedDock();

    // Active divider drag gesture (vertical in right dock, horizontal in top/bottom dock)
    if (this.draggingDivider) {
      if (event.type === "drag") {
        const { cols, rows } = this.callbacks.getTerminalSize();
        let pct: number;
        if (dock === "right") {
          pct = Math.round(((cols - event.screenX) / Math.max(1, cols)) * 100);
        } else if (dock === "top") {
          pct = Math.round(((event.screenY + 1) / Math.max(1, rows)) * 100);
        } else {
          pct = Math.round(((rows - event.screenY) / Math.max(1, rows)) * 100);
        }
        this.setSizePercent(pct);
        return { handled: true, capture: true, render: true };
      }
      if (event.type === "release") {
        this.draggingDivider = false;
        this.requestRender();
        return { handled: true, render: true };
      }
      return { handled: true, capture: true };
    }

    // Active canvas grab-and-drag 2D panning gesture
    if (this.draggingCanvas) {
      if (event.type === "drag") {
        const dx = this.draggingCanvas.lastX - event.screenX;
        const dy = this.draggingCanvas.lastY - event.screenY;
        if (dx !== 0 || dy !== 0) {
          this.draggingCanvas.moved = true;
          this.draggingCanvas.lastX = event.screenX;
          this.draggingCanvas.lastY = event.screenY;
          this.panBy(dx * 2, dy);
        }
        return { handled: true, capture: true, render: true };
      }
      if (event.type === "release") {
        const { moved, startLocalX, startLocalY } = this.draggingCanvas;
        this.draggingCanvas = null;
        if (!moved) {
          this.selectNodeAtLocal(startLocalX, startLocalY, dock);
        }
        this.requestRender();
        return { handled: true, focus: !moved, render: true };
      }
      return { handled: true, capture: true };
    }

    if (event.type === "wheel") {
      const delta = event.wheelDelta ?? 0;
      if (delta !== 0) {
        if (event.shift) this.panBy(delta * 4, 0);
        else this.panBy(0, delta * 2);
      }
      return { handled: true, render: true };
    }

    if (event.type === "press" && event.button === "left") {
      if (this.isOnResizeDivider(event, dock)) {
        this.draggingDivider = true;
        this.requestRender();
        return { handled: true, capture: true, render: true };
      }

      const geo = this.getGeometryOffsets(dock);
      if (event.y === geo.headerRow) {
        if (event.x >= this.headerCloseX.start && event.x <= this.headerCloseX.end) {
          this.callbacks.onClose();
          return { handled: true, render: true };
        }
        if (event.x >= this.headerDockX.start && event.x <= this.headerDockX.end) {
          this.callbacks.onDockCycle();
          return { handled: true, focus: true, render: true };
        }
        if (event.x >= this.headerZoomX.start && event.x <= this.headerZoomX.end) {
          this.cycleZoom();
          return { handled: true, focus: true, render: true };
        }
        if (event.x >= this.headerToggleX.start && event.x <= this.headerToggleX.end) {
          this.setOrientation(this.orientation === "tb" ? "lr" : "tb");
          return { handled: true, focus: true, render: true };
        }
      }

      const canvasRow = event.y - geo.canvasTopRow;
      if (
        !this.inspectorExpanded &&
        canvasRow >= 0 &&
        canvasRow < this.lastViewportH &&
        event.x >= geo.canvasLeftCol
      ) {
        this.draggingCanvas = {
          lastX: event.screenX,
          lastY: event.screenY,
          moved: false,
          startLocalX: event.x,
          startLocalY: event.y,
        };
        return { handled: true, capture: true, render: false };
      }

      return { handled: true, focus: true, render: true };
    }

    return undefined;
  }

  private selectNodeAtLocal(localX: number, localY: number, dock: ResolvedDock): void {
    const geo = this.getGeometryOffsets(dock);
    const canvasRow = localY - geo.canvasTopRow;
    const canvasCol = localX - geo.canvasLeftCol;
    if (canvasRow < 0 || canvasRow >= this.lastViewportH || canvasCol < 0) return;
    const r = this.ensureRendered();
    if (!r) return;
    const cx = this.scrollX + canvasCol;
    const cy = this.scrollY + canvasRow;
    const hit = r.hitRects.find(
      (rect) => cx >= rect.x && cx < rect.x + rect.width && cy >= rect.y && cy < rect.y + rect.height,
    );
    if (hit) {
      this.selectNode(hit.nodeId, false);
    }
  }

  private renderInspectorLines(innerW: number, maxRows: number, theme: Theme): string[] {
    const model = this.model;
    if (!model) return [theme.fg("muted", "No BPMN model loaded.")];
    const lines: string[] = [];
    const push = (s: string) => lines.push(truncateToWidth(s, innerW));

    push(theme.bold(theme.fg("accent", `Model Summary: ${model.title}`)));
    push(
      theme.fg(
        "muted",
        `Pools: ${model.pools.length} · Lanes: ${model.lanes.length} · Nodes: ${model.nodes.length} · Flows: ${model.flows.length}`,
      ),
    );
    if (this.sourceLabel) push(theme.fg("dim", `Source: ${this.sourceLabel}`));
    push("");

    if (model.diagnostics.length > 0) {
      push(theme.bold(theme.fg("warning", `Diagnostics (${model.diagnostics.length}):`)));
      for (const d of model.diagnostics) {
        push(theme.fg(d.level === "error" ? "error" : "warning", `  • ${d.message}`));
      }
      push("");
    }

    if (model.lanes.length > 0) {
      push(theme.bold(theme.fg("accent", "Swimlanes:")));
      for (const lane of model.lanes) {
        push(`  • ${lane.name} (${lane.nodeIds.length} nodes)`);
      }
      push("");
    }

    push(theme.bold(theme.fg("accent", "Elements & Flows:")));
    for (const n of model.nodes) {
      const marker = n.id === this.selectedNodeId ? theme.fg("success", "▶ ") : "  ";
      const badge = getNodeBadge(n);
      push(`${marker}${badge} ${n.name || n.id} ${theme.fg("dim", `[${getNodeKindLabel(n)}]`)}`);
      if (n.documentation) {
        push(theme.fg("muted", `      doc: ${n.documentation}`));
      }
      const outs = model.flows.filter((f) => f.sourceRef === n.id);
      for (const f of outs) {
        const target = model.nodes.find((x) => x.id === f.targetRef);
        const arrow = f.kind === "messageFlow" ? "┄▶" : "─▶";
        const cond = f.name ? ` (${f.name})` : "";
        push(theme.fg("dim", `      ${arrow}${cond} ${target?.name || f.targetRef}`));
      }
    }

    const slice = lines.slice(this.scrollY, this.scrollY + maxRows);
    while (slice.length < maxRows) slice.push("");
    return slice;
  }

  private renderSelectedFooter(innerW: number, compactFooter: boolean, theme: Theme): string[] {
    const model = this.model;
    const node: BpmnNode | undefined = model?.nodes.find((n) => n.id === this.selectedNodeId);
    const lines: string[] = [];

    if (!node || !model) {
      lines.push(theme.fg("dim", "Select a node with Tab or click to inspect."));
      if (!compactFooter) lines.push(this.renderHelpHint(innerW, theme));
      return lines;
    }

    const laneName = model.lanes.find((l) => l.id === node.laneId)?.name;
    const poolName = model.pools.find((p) => p.id === node.poolId)?.name;
    const scope = laneName ? (poolName ? `${poolName} / ${laneName}` : laneName) : poolName ?? "";
    const titlePart = `${getNodeBadge(node)} ${node.name || node.id}`;
    const metaPart = scope ? ` · ${getNodeKindLabel(node)} · ${scope}` : ` · ${getNodeKindLabel(node)}`;
    lines.push(
      truncateToWidth(theme.bold(theme.fg("text", titlePart)) + theme.fg("muted", metaPart), innerW),
    );

    if (!compactFooter) {
      const outs = model.flows.filter((f) => f.sourceRef === node.id);
      const ins = model.flows.filter((f) => f.targetRef === node.id);
      const flowSummary =
        outs.length > 0
          ? "→ " +
            outs
              .map((f) => {
                const target = model.nodes.find((x) => x.id === f.targetRef);
                const tName = target?.name || f.targetRef;
                return f.name ? `[${f.name}] ${tName}` : tName;
              })
              .join(" | ")
          : ins.length > 0
            ? `← from ${ins.map((f) => model.nodes.find((x) => x.id === f.sourceRef)?.name || f.sourceRef).join(", ")}`
            : node.documentation || "No connected flows";
      lines.push(truncateToWidth(theme.fg("muted", flowSummary), innerW));
    }
    lines.push(this.renderHelpHint(innerW, theme));
    return lines;
  }

  private renderHelpHint(innerW: number, theme: Theme): string {
    const dock = this.callbacks.getResolvedDock();
    const dragWord = dock === "right" ? "Drag │" : "Drag ─";
    const hint = this.draggingDivider
      ? `Dragging divider: ${this.sizePercent}% (release to lock)`
      : this.focused
        ? "+/- zoom · f fit · v dock · o TB/LR · [/] size · hjkl pan · Tab node · Esc chat · q close"
        : `${dragWord} to resize · Alt+G focus · +/- zoom · v dock · /bpmn close`;
    return truncateToWidth(theme.fg(this.draggingDivider ? "success" : "dim", hint), innerW);
  }

  render(width: number): string[] {
    const safeW = Math.max(16, Math.floor(width));
    const targetH = Math.max(10, this.getTargetHeight());
    this.lastRenderHeight = targetH;
    const dock = this.callbacks.getResolvedDock();
    const isRight = dock === "right";
    const theme = this.callbacks.getTheme();

    const leftChromeW = isRight ? 2 : 1; // right dock: "│ ", top/bottom dock: " "
    const innerW = Math.max(10, safeW - leftChromeW);
    const compactFooter = !isRight && targetH <= 18;
    const footerContentRows = compactFooter ? 2 : 3;
    const dragBorderRows = isRight ? 0 : 1;
    const headerH = 2; // header + rule
    const footerH = 1 + footerContentRows; // rule + footer lines
    const bodyH = Math.max(3, targetH - headerH - footerH - dragBorderRows);

    this.lastViewportW = innerW;
    this.lastViewportH = bodyH;

    const r = this.ensureRendered();
    const borderColor = this.draggingDivider ? "success" : this.focused ? "accent" : "borderMuted";
    const vChar = this.draggingDivider && isRight ? "┃" : "│";
    const hChar = this.draggingDivider && !isRight ? "━" : "─";
    const prefix = isRight ? `${theme.fg(borderColor, vChar)} ` : " ";

    const padLine = (content: string): string => {
      const clamped = truncateToWidth(content, innerW);
      const pad = Math.max(0, innerW - visibleWidth(clamped));
      return `${prefix}${clamped}${" ".repeat(pad)}`;
    };

    const makeDragDividerRow = (): string => {
      const label = this.draggingDivider ? ` ${this.sizePercent}% ` : " ═══ drag to resize ═══ ";
      const lw = visibleWidth(label);
      if (lw + 4 >= safeW) return theme.fg(borderColor, hChar.repeat(safeW));
      const leftLen = Math.floor((safeW - lw) / 2);
      const rightLen = safeW - lw - leftLen;
      return (
        theme.fg(borderColor, hChar.repeat(leftLen)) +
        theme.fg(this.draggingDivider ? "success" : "dim", label) +
        theme.fg(borderColor, hChar.repeat(rightLen))
      );
    };

    const out: string[] = [];

    // Bottom dock puts its draggable horizontal divider at row 0
    if (dock === "bottom") {
      out.push(makeDragDividerRow());
    }

    // Header row: focus dot + title + [A:T/R/B] [FIT/CMP/DET] [TB/LR] [×]
    const dockTag = `[${dockShortLabel(this.callbacks.getDockPreference(), dock)}]`;
    const zoomTag = `[${zoomShortLabel(this.zoom)}]`;
    const modeTag = this.inspectorExpanded ? "[INFO]" : `[${this.orientation.toUpperCase()}]`;
    const closeTag = "[×]";
    const focusTag = this.focused ? "●" : "○";
    const rightControls = `${dockTag} ${zoomTag} ${modeTag} ${closeTag}`;
    const rightW = visibleWidth(rightControls);
    const titleBudget = Math.max(4, innerW - rightW - 3);
    const titleRaw = this.model ? this.model.title : "BPMN View";
    const titleClamped = clampText(titleRaw, titleBudget);
    const gapW = Math.max(1, innerW - visibleWidth(focusTag) - 1 - visibleWidth(titleClamped) - rightW);

    const controlsStart = leftChromeW + visibleWidth(focusTag) + 1 + visibleWidth(titleClamped) + gapW;
    const dockW = visibleWidth(dockTag);
    const zoomW = visibleWidth(zoomTag);
    const modeW = visibleWidth(modeTag);
    this.headerDockX = { start: controlsStart, end: controlsStart + dockW - 1 };
    this.headerZoomX = { start: controlsStart + dockW + 1, end: controlsStart + dockW + 1 + zoomW - 1 };
    this.headerToggleX = {
      start: controlsStart + dockW + 1 + zoomW + 1,
      end: controlsStart + dockW + 1 + zoomW + 1 + modeW - 1,
    };
    this.headerCloseX = {
      start: controlsStart + dockW + 1 + zoomW + 1 + modeW + 1,
      end: controlsStart + rightW - 1,
    };

    const headerStr =
      theme.fg(this.focused ? "success" : "dim", focusTag) +
      " " +
      theme.bold(theme.fg(this.focused ? "accent" : "text", titleClamped)) +
      " ".repeat(gapW) +
      theme.fg("muted", dockTag) +
      " " +
      theme.fg(this.zoom === "fit" ? "success" : "warning", zoomTag) +
      " " +
      theme.fg("accent", modeTag) +
      " " +
      theme.fg("muted", closeTag);
    out.push(padLine(headerStr));

    // Top rule with scroll / size indicator
    const maxX = r ? Math.max(0, r.width - innerW) : 0;
    const maxY = r ? Math.max(0, r.height - bodyH) : 0;
    const posStr =
      r && !this.inspectorExpanded
        ? maxX === 0 && maxY === 0
          ? ` full ${this.sizePercent}% `
          : ` ${this.scrollX}/${maxX}x ${this.scrollY}/${maxY}y · ${this.sizePercent}% `
        : ` ${this.sizePercent}% `;
    const rulePrefix = isRight ? theme.fg(borderColor, vChar) : "";
    const ruleAvail = safeW - (isRight ? 1 : 0);
    const ruleLen = Math.max(0, ruleAvail - visibleWidth(posStr));
    out.push(`${rulePrefix}${theme.fg(borderColor, "─".repeat(ruleLen))}${posStr ? theme.fg("dim", posStr) : ""}`);

    // Body rows
    if (this.inspectorExpanded) {
      const infoLines = this.renderInspectorLines(innerW, bodyH, theme);
      for (const l of infoLines) out.push(padLine(l));
    } else if (r) {
      this.clampScroll();
      const slice = r.canvas.renderSlice(this.scrollX, this.scrollY, innerW, bodyH, theme);
      for (const l of slice) out.push(`${prefix}${l}`);
    } else {
      for (let i = 0; i < bodyH; i++) {
        out.push(padLine(i === 0 ? theme.fg("muted", "Use /bpmn <file.bpmn> or /bpmn demo") : ""));
      }
    }

    // Bottom inspector divider
    const diagCount = this.model?.diagnostics.length ?? 0;
    const diagTag = diagCount > 0 ? ` !${diagCount} ` : "";
    const bRuleLen = Math.max(0, ruleAvail - visibleWidth(diagTag));
    out.push(
      `${rulePrefix}${theme.fg(borderColor, "─".repeat(bRuleLen))}${diagTag ? theme.fg("warning", diagTag) : ""}`,
    );

    // Selected node inspector footer
    const footerLines = this.renderSelectedFooter(innerW, compactFooter, theme);
    for (let i = 0; i < footerContentRows; i++) {
      out.push(padLine(footerLines[i] ?? ""));
    }

    // Top dock puts its draggable horizontal divider at the very bottom row
    if (dock === "top") {
      out.push(makeDragDividerRow());
    }

    return out.slice(0, targetH).map((l) => truncateToWidth(l, safeW));
  }
}

interface TuiWithInternalLayout extends ViewportTUI {
  layoutRoot?: Component;
  getFocusedComponent?: () => Component | null;
  inputListeners?: Set<(data: string) => { consume?: boolean; data?: string } | undefined>;
}

export class BpmnSideViewManager {
  private tui: TUI | null = null;
  private originalRoot: Component | null = null;
  private splitRoot: Component | null = null;
  private regularOverlay: OverlayHandle | null = null;
  private previousFocus: Component | null = null;
  private removeHorizWheelListener: (() => void) | null = null;
  private open = false;
  private dockPreference: DockPreference = "auto";
  private resolvedDock: ResolvedDock | null = "right";
  private lastLayoutTermWidth = 0;
  private lastLayoutTermHeight = 0;
  private sizePercent = DEFAULT_SIZE_PERCENT;
  private readonly pane: BpmnSidePaneComponent;
  private readonly getTheme: () => Theme;
  private readonly onStatusChange: (status: string | undefined) => void;
  private readonly onReloadRequested: () => void;

  constructor(opts: {
    getTheme: () => Theme;
    onStatusChange: (status: string | undefined) => void;
    onReloadRequested: () => void;
  }) {
    this.getTheme = opts.getTheme;
    this.onStatusChange = opts.onStatusChange;
    this.onReloadRequested = opts.onReloadRequested;
    this.pane = new BpmnSidePaneComponent(
      () => this.computePaneHeight(),
      () => this.tui?.requestRender(),
      {
        getTheme: () => this.getTheme(),
        getTerminalSize: () => ({
          cols: this.tui?.terminal.columns ?? 120,
          rows: this.tui?.terminal.rows ?? 36,
        }),
        getResolvedDock: () => this.resolvedDock ?? "right",
        getDockPreference: () => this.dockPreference,
        onSizeChange: (pct) => {
          this.sizePercent = pct;
          this.rebuildSplitLayout();
          this.updateStatus();
        },
        onDockCycle: () => {
          const idx = DOCK_CYCLE.indexOf(this.dockPreference);
          this.setDockPreference(DOCK_CYCLE[(idx + 1) % DOCK_CYCLE.length]!);
        },
        onViewStateChange: () => this.updateStatus(),
        onClose: () => this.close(),
        onUnfocus: () => this.unfocus(),
        onReload: () => this.onReloadRequested(),
      },
    );
  }

  attachTui(tui: TUI): void {
    if (this.tui === tui) return;
    this.detachCurrentTui();
    this.tui = tui;
    this.installHorizontalWheelListener(tui);
    if (this.open) {
      this.mountOpenView();
    }
  }

  /** Intercept SGR horizontal trackpad scroll (button 66=left, 67=right) before TuiAltScreen drops it. */
  private installHorizontalWheelListener(tui: TUI): void {
    const listener = (data: string) => {
      if (!this.open) return undefined;
      const m = /^\x1b\[<(\d+);(\d+);(\d+)M$/.exec(data);
      if (!m) return undefined;
      const button = Number.parseInt(m[1]!, 10);
      if ((button & 64) === 0) return undefined;
      const dir = button & 3;
      if (dir !== 2 && dir !== 3) return undefined;
      const col0 = Number.parseInt(m[2]!, 10) - 1;
      const row0 = Number.parseInt(m[3]!, 10) - 1;
      if (!this.isPointInPane(col0, row0)) return undefined;
      this.pane.panBy(dir === 2 ? -4 : 4, 0);
      return { consume: true };
    };
    const internal = tui as TuiWithInternalLayout;
    if (internal.inputListeners instanceof Set) {
      const existing = [...internal.inputListeners];
      internal.inputListeners.clear();
      internal.inputListeners.add(listener);
      for (const fn of existing) internal.inputListeners.add(fn);
      this.removeHorizWheelListener = () => {
        internal.inputListeners?.delete(listener);
      };
    } else {
      this.removeHorizWheelListener = tui.addInputListener(listener);
    }
  }

  isOpen(): boolean {
    return this.open;
  }

  isFocused(): boolean {
    return this.pane.focused;
  }

  getPane(): BpmnSidePaneComponent {
    return this.pane;
  }

  getSizePercent(): number {
    return this.sizePercent;
  }

  getDockPreference(): DockPreference {
    return this.dockPreference;
  }

  getResolvedDock(): ResolvedDock | null {
    return this.resolvedDock;
  }

  getPaneRect(): PaneRect | null {
    if (!this.tui || !this.open || !this.resolvedDock) return null;
    const cols = this.tui.terminal.columns;
    const rows = this.tui.terminal.rows;
    if (this.resolvedDock === "right") {
      const w = this.computeRightCols(cols);
      return { x: cols - w, y: 0, width: w, height: rows };
    }
    const h = this.computeVerticalRows(rows);
    if (this.resolvedDock === "top") {
      return { x: 0, y: 0, width: cols, height: h };
    }
    return { x: 0, y: rows - h, width: cols, height: h };
  }

  isPointInPane(col0: number, row0: number): boolean {
    const rect = this.getPaneRect();
    if (!rect) return false;
    return (
      col0 >= rect.x &&
      col0 < rect.x + rect.width &&
      row0 >= rect.y &&
      row0 < rect.y + rect.height
    );
  }

  private computeRightCols(termCols: number): number {
    const raw = Math.round((termCols * this.sizePercent) / 100);
    return Math.max(26, Math.min(termCols - 28, raw));
  }

  private computeVerticalRows(termRows: number): number {
    const raw = Math.round((termRows * this.sizePercent) / 100);
    return Math.max(10, Math.min(termRows - 12, raw));
  }

  private computePaneHeight(): number {
    if (!this.tui) return 24;
    if (!isViewportTUI(this.tui)) return Math.max(12, Math.floor(this.tui.terminal.rows * 0.85));
    if (this.resolvedDock === "top" || this.resolvedDock === "bottom") {
      return this.computeVerticalRows(this.tui.terminal.rows);
    }
    return Math.max(12, this.tui.terminal.rows);
  }

  showModel(
    model: BpmnModel,
    sourceLabel: string,
    opts?: {
      orientation?: LayoutOrientation;
      zoom?: ZoomLevel;
      dock?: DockPreference;
      preserveScroll?: boolean;
      focus?: boolean;
    },
  ): void {
    if (opts?.orientation) this.pane.setOrientation(opts.orientation);
    if (opts?.zoom) this.pane.setZoom(opts.zoom);
    if (opts?.dock) this.dockPreference = opts.dock;
    this.pane.setModel(model, sourceLabel, { preserveScroll: opts?.preserveScroll });
    if (!this.open) {
      this.open = true;
      this.mountOpenView();
    } else {
      this.rebuildSplitLayout();
    }
    if (opts?.focus) this.focus();
    this.updateStatus();
  }

  setSizePercent(pct: number): void {
    this.pane.setSizePercent(pct);
    this.updateStatus();
  }

  setOrientation(orientation: LayoutOrientation): void {
    this.pane.setOrientation(orientation);
    this.updateStatus();
  }

  setZoom(zoom: ZoomLevel): void {
    this.pane.setZoom(zoom);
    this.updateStatus();
  }

  setDockPreference(pref: DockPreference): void {
    if (this.dockPreference === pref) return;
    this.dockPreference = pref;
    if (this.open) {
      this.rebuildSplitLayout();
    }
    this.updateStatus();
  }

  focus(): boolean {
    if (!this.open || !this.tui) return false;
    if (isViewportTUI(this.tui) && !this.resolvedDock) {
      return false;
    }
    const t = this.tui as TuiWithInternalLayout;
    const currentFocus = t.getFocusedComponent?.() ?? null;
    if (currentFocus && currentFocus !== this.pane) {
      this.previousFocus = currentFocus;
    }
    if (this.regularOverlay) {
      this.regularOverlay.focus();
    } else {
      this.tui.setFocus(this.pane);
    }
    this.pane.invalidate();
    this.tui.requestRender();
    this.updateStatus();
    return true;
  }

  unfocus(): void {
    if (!this.tui) return;
    if (this.regularOverlay) {
      this.regularOverlay.unfocus();
    } else if (this.pane.focused) {
      this.tui.setFocus(this.previousFocus);
    }
    this.pane.invalidate();
    this.tui.requestRender();
    this.updateStatus();
  }

  close(): void {
    if (!this.open) return;
    this.unfocus();
    this.open = false;
    this.unmountOpenView();
    this.onStatusChange(undefined);
    this.tui?.requestRender();
  }

  dispose(): void {
    this.close();
    this.detachCurrentTui();
  }

  private updateStatus(): void {
    if (!this.open) {
      this.onStatusChange(undefined);
      return;
    }
    const model = this.pane.getModel();
    const title = model ? clampText(model.title, 18) : "BPMN";
    if (this.tui && isViewportTUI(this.tui) && !this.resolvedDock) {
      this.onStatusChange("BPMN hidden (small terminal · /bpmn modal)");
      return;
    }
    const dockTag = dockShortLabel(this.dockPreference, this.resolvedDock ?? "right");
    const focusNote = this.pane.focused ? " [focused]" : " (Alt+G)";
    this.onStatusChange(
      `BPMN: ${title} [${dockTag} ${zoomShortLabel(this.pane.getZoom())}/${this.pane.getOrientation().toUpperCase()} ${this.sizePercent}%]${focusNote}`,
    );
  }

  private mountOpenView(): void {
    if (!this.tui) return;
    if (isViewportTUI(this.tui)) {
      const vtui = this.tui as TuiWithInternalLayout;
      const currentRoot = vtui.layoutRoot;
      if (currentRoot && currentRoot !== this.splitRoot) {
        this.originalRoot = currentRoot;
      }
      if (this.originalRoot) {
        this.rebuildSplitLayout();
        return;
      }
    }
    if (!this.regularOverlay) {
      const cols = this.tui.terminal.columns;
      const rows = this.tui.terminal.rows;
      const dock = resolveDock(this.dockPreference, cols, rows) ?? "right";
      this.resolvedDock = dock;
      this.regularOverlay = this.tui.showOverlay(
        this.pane,
        dock === "top" || dock === "bottom"
          ? {
              anchor: dock === "top" ? "top-center" : "bottom-center",
              width: "98%",
              maxHeight: `${this.sizePercent}%`,
              nonCapturing: true,
              visible: (w, h) => this.open && resolveDock(this.dockPreference, w, h) !== null,
            }
          : {
              anchor: "top-right",
              width: `${this.sizePercent}%`,
              minWidth: 28,
              maxHeight: "90%",
              margin: { top: 1, right: 0 },
              nonCapturing: true,
              visible: (w, h) => this.open && resolveDock(this.dockPreference, w, h) !== null,
            },
      );
    }
    this.tui.requestRender();
  }

  private rebuildSplitLayout(): void {
    if (!this.open || !this.tui) return;
    if (!isViewportTUI(this.tui)) {
      if (this.regularOverlay) {
        this.regularOverlay.hide();
        this.regularOverlay = null;
        this.mountOpenView();
      }
      return;
    }
    if (!this.originalRoot) return;

    const termCols = this.tui.terminal.columns;
    const termRows = this.tui.terminal.rows;
    this.lastLayoutTermWidth = termCols;
    this.lastLayoutTermHeight = termRows;
    const nextDock = resolveDock(this.dockPreference, termCols, termRows);
    const prevDock = this.resolvedDock;
    this.resolvedDock = nextDock;

    const checkResize = (vp: { width: number; height: number }): boolean => {
      if (this.open && (vp.width !== this.lastLayoutTermWidth || vp.height !== this.lastLayoutTermHeight)) {
        this.lastLayoutTermWidth = vp.width;
        this.lastLayoutTermHeight = vp.height;
        queueMicrotask(() => {
          this.rebuildSplitLayout();
          this.updateStatus();
        });
      }
      return this.open && resolveDock(this.dockPreference, vp.width, vp.height) === nextDock && nextDock !== null;
    };

    if (!nextDock) {
      // Too small for either right or top split -> show only originalRoot, keep resize watcher via hidden child
      this.splitRoot = new HStack(
        [
          { component: this.originalRoot, basis: 0, grow: 1, shrink: 1, minSize: 20 },
          { component: this.pane, basis: 0, grow: 0, visible: checkResize },
        ],
        { gap: 0, align: "stretch" },
      );
    } else if (nextDock === "right") {
      const rightCols = this.computeRightCols(termCols);
      this.splitRoot = new HStack(
        [
          { component: this.originalRoot, basis: 0, grow: 1, shrink: 1, minSize: 28 },
          { component: this.pane, basis: rightCols, grow: 0, shrink: 1, minSize: 26, visible: checkResize },
        ],
        { gap: 0, align: "stretch" },
      );
    } else if (nextDock === "top") {
      const topRows = this.computeVerticalRows(termRows);
      this.splitRoot = new VStack(
        [
          { component: this.pane, basis: topRows, grow: 0, shrink: 1, minSize: 10, visible: checkResize },
          { component: this.originalRoot, basis: 0, grow: 1, shrink: 1, minSize: 12 },
        ],
        { gap: 0, align: "stretch" },
      );
    } else {
      const bottomRows = this.computeVerticalRows(termRows);
      this.splitRoot = new VStack(
        [
          { component: this.originalRoot, basis: 0, grow: 1, shrink: 1, minSize: 12 },
          { component: this.pane, basis: bottomRows, grow: 0, shrink: 1, minSize: 10, visible: checkResize },
        ],
        { gap: 0, align: "stretch" },
      );
    }

    this.tui.setLayoutRoot(this.splitRoot);
    this.pane.invalidate();
    this.tui.requestRender();
    if (prevDock !== nextDock) {
      queueMicrotask(() => this.updateStatus());
    }
  }

  private unmountOpenView(): void {
    if (!this.tui) return;
    if (isViewportTUI(this.tui)) {
      const vtui = this.tui as TuiWithInternalLayout;
      if (this.originalRoot && vtui.layoutRoot === this.splitRoot) {
        vtui.setLayoutRoot(this.originalRoot);
      }
      this.splitRoot = null;
    }
    if (this.regularOverlay) {
      this.regularOverlay.hide();
      this.regularOverlay = null;
    }
  }

  private detachCurrentTui(): void {
    this.removeHorizWheelListener?.();
    this.removeHorizWheelListener = null;
    this.unmountOpenView();
    this.tui = null;
    this.originalRoot = null;
    this.previousFocus = null;
  }
}

import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

export type StyleRole =
  | "default"
  | "laneBorder"
  | "laneTitle"
  | "poolTitle"
  | "startBorder"
  | "endBorder"
  | "eventBorder"
  | "taskBorder"
  | "gatewayBorder"
  | "selectedBorder"
  | "selectedText"
  | "nodeText"
  | "edge"
  | "messageEdge"
  | "backEdge"
  | "edgeLabel"
  | "note";

interface Cell {
  ch: string;
  width: 1 | 2;
  style: StyleRole;
  cont?: boolean;
  /** True for cells belonging to a node box or label (protected from edge overwrite). */
  locked?: boolean;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function splitGraphemes(text: string): string[] {
  const out: string[] = [];
  for (const seg of graphemeSegmenter.segment(text)) {
    out.push(seg.segment);
  }
  return out;
}

export function charDisplayWidth(g: string): 0 | 1 | 2 {
  const w = visibleWidth(g);
  if (w <= 0) return 0;
  return w >= 2 ? 2 : 1;
}

/** Wrap text into lines fitting within maxCols visible columns. */
export function wrapLabel(text: string, maxCols: number, maxLines = 3): string[] {
  const safeMax = Math.max(4, maxCols);
  const rawParagraphs = text.split("\n");
  const lines: string[] = [];

  for (const para of rawParagraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    let current = "";
    let currentW = 0;

    for (const g of splitGraphemes(trimmed)) {
      const gw = charDisplayWidth(g);
      if (gw === 0) continue;
      if (currentW + gw > safeMax) {
        // Try splitting at last space if it's an English phrase
        const lastSpace = current.lastIndexOf(" ");
        if (lastSpace > 0 && visibleWidth(current.slice(lastSpace + 1)) <= safeMax - 2) {
          lines.push(current.slice(0, lastSpace).trimEnd());
          const tail = current.slice(lastSpace + 1);
          current = (tail ? tail : "") + (g === " " ? "" : g);
          currentW = visibleWidth(current);
        } else {
          lines.push(current.trimEnd());
          current = g === " " ? "" : g;
          currentW = visibleWidth(current);
        }
        if (lines.length >= maxLines) break;
      } else {
        current += g;
        currentW += gw;
      }
    }
    if (lines.length < maxLines && current.trim()) {
      lines.push(current.trim());
    }
    if (lines.length >= maxLines) break;
  }

  if (lines.length === 0) return [""];

  // If truncated and last line exceeds safeMax, clamp with ellipsis
  if (lines.length > maxLines) lines.length = maxLines;
  const lastIdx = lines.length - 1;
  if (visibleWidth(lines[lastIdx]!) > safeMax) {
    lines[lastIdx] = clampText(lines[lastIdx]!, safeMax);
  }
  return lines;
}

export function clampText(text: string, maxCols: number): string {
  if (maxCols <= 0) return "";
  if (visibleWidth(text) <= maxCols) return text;
  if (maxCols === 1) return "…";
  let out = "";
  let w = 0;
  for (const g of splitGraphemes(text)) {
    const gw = charDisplayWidth(g);
    if (w + gw > maxCols - 1) break;
    out += g;
    w += gw;
  }
  return out + "…";
}

// Direction bitmask for orthogonal line merging
const DIR_UP = 1;
const DIR_RIGHT = 2;
const DIR_DOWN = 4;
const DIR_LEFT = 8;

const CHAR_TO_MASK: Record<string, number> = {
  "─": DIR_LEFT | DIR_RIGHT,
  "│": DIR_UP | DIR_DOWN,
  "┌": DIR_RIGHT | DIR_DOWN,
  "┐": DIR_LEFT | DIR_DOWN,
  "└": DIR_UP | DIR_RIGHT,
  "┘": DIR_UP | DIR_LEFT,
  "├": DIR_UP | DIR_DOWN | DIR_RIGHT,
  "┤": DIR_UP | DIR_DOWN | DIR_LEFT,
  "┬": DIR_LEFT | DIR_RIGHT | DIR_DOWN,
  "┴": DIR_LEFT | DIR_RIGHT | DIR_UP,
  "┼": DIR_UP | DIR_RIGHT | DIR_DOWN | DIR_LEFT,
};

const MASK_TO_CHAR: Record<number, string> = {
  [DIR_UP]: "│",
  [DIR_DOWN]: "│",
  [DIR_UP | DIR_DOWN]: "│",
  [DIR_LEFT]: "─",
  [DIR_RIGHT]: "─",
  [DIR_LEFT | DIR_RIGHT]: "─",
  [DIR_RIGHT | DIR_DOWN]: "┌",
  [DIR_LEFT | DIR_DOWN]: "┐",
  [DIR_UP | DIR_RIGHT]: "└",
  [DIR_UP | DIR_LEFT]: "┘",
  [DIR_UP | DIR_DOWN | DIR_RIGHT]: "├",
  [DIR_UP | DIR_DOWN | DIR_LEFT]: "┤",
  [DIR_LEFT | DIR_RIGHT | DIR_DOWN]: "┬",
  [DIR_LEFT | DIR_RIGHT | DIR_UP]: "┴",
  [DIR_UP | DIR_RIGHT | DIR_DOWN | DIR_LEFT]: "┼",
};

export class BpmnCanvas {
  readonly width: number;
  readonly height: number;
  private readonly grid: Cell[][];

  constructor(width: number, height: number) {
    this.width = Math.max(1, Math.ceil(width));
    this.height = Math.max(1, Math.ceil(height));
    this.grid = Array.from({ length: this.height }, () =>
      Array.from({ length: this.width }, () => ({ ch: " ", width: 1 as const, style: "default" as StyleRole })),
    );
  }

  private clearCell(x: number, y: number): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const row = this.grid[y]!;
    const cell = row[x]!;
    if (cell.cont && x > 0) {
      row[x - 1] = { ch: " ", width: 1, style: "default" };
    }
    if (cell.width === 2 && x + 1 < this.width) {
      row[x + 1] = { ch: " ", width: 1, style: "default" };
    }
    row[x] = { ch: " ", width: 1, style: "default" };
  }

  isLocked(x: number, y: number): boolean {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return true;
    return this.grid[y]![x]!.locked === true;
  }

  getChar(x: number, y: number): string {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return " ";
    return this.grid[y]![x]!.ch;
  }

  setChar(
    x: number,
    y: number,
    ch: string,
    style: StyleRole = "default",
    opts?: { lock?: boolean; skipLocked?: boolean },
  ): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    if (opts?.skipLocked && this.grid[y]![x]!.locked) return;
    const w = charDisplayWidth(ch);
    if (w === 0) return;
    if (w === 2 && x + 1 >= this.width) return;
    if (opts?.skipLocked && w === 2 && this.grid[y]![x + 1]!.locked) return;

    this.clearCell(x, y);
    if (w === 2) this.clearCell(x + 1, y);

    const row = this.grid[y]!;
    row[x] = { ch, width: w, style, locked: opts?.lock ?? row[x]!.locked };
    if (w === 2) {
      row[x + 1] = { ch: "", width: 1, style, cont: true, locked: opts?.lock ?? row[x + 1]!.locked };
    }
  }

  drawText(
    x: number,
    y: number,
    text: string,
    style: StyleRole = "default",
    opts?: { maxCols?: number; lock?: boolean; skipLocked?: boolean },
  ): number {
    if (y < 0 || y >= this.height) return 0;
    const clamped = opts?.maxCols !== undefined ? clampText(text, opts.maxCols) : text;
    let cx = x;
    for (const g of splitGraphemes(clamped)) {
      const w = charDisplayWidth(g);
      if (w === 0) continue;
      if (cx >= this.width) break;
      if (w === 2 && cx + 1 >= this.width) break;
      if (cx >= 0) {
        this.setChar(cx, y, g, style, { lock: opts?.lock, skipLocked: opts?.skipLocked });
      }
      cx += w;
    }
    return cx - x;
  }

  drawBox(
    x: number,
    y: number,
    w: number,
    h: number,
    borderStyle: StyleRole,
    variant: "rounded" | "sharp" | "double" | "dashed" = "rounded",
    lock = true,
  ): void {
    if (w < 2 || h < 2) return;
    const chars =
      variant === "double"
        ? { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" }
        : variant === "sharp"
          ? { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" }
          : variant === "dashed"
            ? { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "┄", v: "┆" }
            : { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" };

    // Fill interior & lock if needed
    for (let ry = y; ry < y + h; ry++) {
      for (let rx = x; rx < x + w; rx++) {
        if (rx === x || rx === x + w - 1 || ry === y || ry === y + h - 1) continue;
        this.setChar(rx, ry, " ", "nodeText", { lock });
      }
    }

    this.setChar(x, y, chars.tl, borderStyle, { lock });
    this.setChar(x + w - 1, y, chars.tr, borderStyle, { lock });
    this.setChar(x, y + h - 1, chars.bl, borderStyle, { lock });
    this.setChar(x + w - 1, y + h - 1, chars.br, borderStyle, { lock });

    for (let rx = x + 1; rx < x + w - 1; rx++) {
      this.setChar(rx, y, chars.h, borderStyle, { lock });
      this.setChar(rx, y + h - 1, chars.h, borderStyle, { lock });
    }
    for (let ry = y + 1; ry < y + h - 1; ry++) {
      this.setChar(x, ry, chars.v, borderStyle, { lock });
      this.setChar(x + w - 1, ry, chars.v, borderStyle, { lock });
    }
  }

  /** Draw a connectable orthogonal segment cell that merges with existing single-line segments. */
  private putSegment(
    x: number,
    y: number,
    addMask: number,
    style: StyleRole,
    dashed: boolean,
  ): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const cell = this.grid[y]![x]!;
    if (cell.locked) return;
    if (dashed) {
      if (cell.ch === " ") {
        const ch = addMask === (DIR_LEFT | DIR_RIGHT) || addMask === DIR_LEFT || addMask === DIR_RIGHT
          ? "┄"
          : addMask === (DIR_UP | DIR_DOWN) || addMask === DIR_UP || addMask === DIR_DOWN
            ? "┆"
            : MASK_TO_CHAR[addMask] ?? "·";
        this.setChar(x, y, ch, style);
      }
      return;
    }
    const existingMask = CHAR_TO_MASK[cell.ch] ?? 0;
    const merged = existingMask | addMask;
    const ch = MASK_TO_CHAR[merged] ?? MASK_TO_CHAR[addMask] ?? "·";
    this.setChar(x, y, ch, style);
  }

  /** Draw an orthogonal polyline through integer grid points, ending with an optional arrowhead. */
  drawPolyline(
    points: Array<{ x: number; y: number }>,
    style: StyleRole = "edge",
    opts?: { dashed?: boolean; arrow?: "right" | "down" | "left" | "up" | "none" },
  ): void {
    if (points.length < 2) return;
    const dashed = opts?.dashed ?? false;

    // Expand consecutive orthogonal points into step-by-step cell coordinates
    const cells: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      let cx = Math.round(a.x);
      let cy = Math.round(a.y);
      const tx = Math.round(b.x);
      const ty = Math.round(b.y);
      if (cells.length === 0) cells.push({ x: cx, y: cy });
      while (cx !== tx || cy !== ty) {
        if (cx !== tx) cx += cx < tx ? 1 : -1;
        else if (cy !== ty) cy += cy < ty ? 1 : -1;
        cells.push({ x: cx, y: cy });
      }
    }

    for (let i = 0; i < cells.length; i++) {
      const cur = cells[i]!;
      const prev = i > 0 ? cells[i - 1] : undefined;
      const next = i < cells.length - 1 ? cells[i + 1] : undefined;

      // Final cell with arrowhead
      if (i === cells.length - 1 && opts?.arrow && opts.arrow !== "none") {
        const arrowChar =
          opts.arrow === "right"
            ? "▶"
            : opts.arrow === "down"
              ? "▼"
              : opts.arrow === "left"
                ? "◀"
                : "▲";
        this.setChar(cur.x, cur.y, arrowChar, style, { skipLocked: true });
        continue;
      }

      let mask = 0;
      if (prev) {
        if (prev.x < cur.x) mask |= DIR_LEFT;
        else if (prev.x > cur.x) mask |= DIR_RIGHT;
        if (prev.y < cur.y) mask |= DIR_UP;
        else if (prev.y > cur.y) mask |= DIR_DOWN;
      }
      if (next) {
        if (next.x < cur.x) mask |= DIR_LEFT;
        else if (next.x > cur.x) mask |= DIR_RIGHT;
        if (next.y < cur.y) mask |= DIR_UP;
        else if (next.y > cur.y) mask |= DIR_DOWN;
      }
      if (mask !== 0) {
        this.putSegment(cur.x, cur.y, mask, style, dashed);
      }
    }
  }

  /** Place a short edge label if cells are unlocked; avoids overwriting boxes or other labels. */
  drawEdgeLabel(x: number, y: number, label: string, style: StyleRole = "edgeLabel"): void {
    if (!label || y < 0 || y >= this.height) return;
    const isFreeForLabel = (sx: number, width: number): boolean => {
      if (sx < 0 || sx + width > this.width) return false;
      const checkStart = Math.max(0, sx - 1);
      const checkEnd = Math.min(this.width, sx + width + 1);
      for (let rx = checkStart; rx < checkEnd; rx++) {
        const cell = this.grid[y]![rx]!;
        if (rx >= sx && rx < sx + width && cell.locked) return false;
        const isEmptyOrLine =
          cell.ch === " " ||
          cell.ch === "┄" ||
          cell.ch === "┆" ||
          Boolean(CHAR_TO_MASK[cell.ch]);
        if (!isEmptyOrLine) return false;
      }
      return true;
    };
    const padded = ` ${label} `;
    const paddedW = visibleWidth(padded);
    const bareW = visibleWidth(label);
    const candidates = [
      { text: padded, w: paddedW, sx: Math.max(0, Math.min(this.width - paddedW, Math.round(x - paddedW / 2))) },
      { text: label, w: bareW, sx: Math.max(0, Math.min(this.width - bareW, Math.round(x - bareW / 2))) },
      { text: label, w: bareW, sx: Math.max(0, Math.min(this.width - bareW, Math.round(x - bareW / 2) + 2)) },
      { text: label, w: bareW, sx: Math.max(0, Math.min(this.width - bareW, Math.round(x - bareW / 2) - 2)) },
    ];
    for (const c of candidates) {
      if (isFreeForLabel(c.sx, c.w)) {
        this.drawText(c.sx, y, c.text, style, { skipLocked: true });
        return;
      }
    }
  }

  /** Render a plain unstyled viewport slice (great for unit tests & assertions). */
  renderPlainSlice(scrollX: number, scrollY: number, viewWidth: number, viewHeight: number): string[] {
    return this.renderSlice(scrollX, scrollY, viewWidth, viewHeight, undefined);
  }

  /** Render a styled viewport slice guaranteed to fit within viewWidth columns per line. */
  renderSlice(
    scrollX: number,
    scrollY: number,
    viewWidth: number,
    viewHeight: number,
    theme: Theme | undefined,
  ): string[] {
    const safeW = Math.max(1, Math.floor(viewWidth));
    const safeH = Math.max(0, Math.floor(viewHeight));
    const sx = Math.max(0, Math.floor(scrollX));
    const sy = Math.max(0, Math.floor(scrollY));
    const lines: string[] = [];

    for (let rowOffset = 0; rowOffset < safeH; rowOffset++) {
      const y = sy + rowOffset;
      if (y < 0 || y >= this.height) {
        lines.push(" ".repeat(safeW));
        continue;
      }
      const row = this.grid[y]!;
      let out = "";
      let runText = "";
      let runStyle: StyleRole | null = null;

      const flush = () => {
        if (!runText) return;
        out += applyStyle(runText, runStyle ?? "default", theme);
        runText = "";
        runStyle = null;
      };

      let col = 0;
      while (col < safeW) {
        const x = sx + col;
        if (x < 0 || x >= this.width) {
          if (runStyle !== "default") {
            flush();
            runStyle = "default";
          }
          runText += " ";
          col += 1;
          continue;
        }
        const cell = row[x]!;
        // Guard against splitting a 2-column glyph at left or right viewport boundary
        if (cell.cont) {
          if (runStyle !== "default") {
            flush();
            runStyle = "default";
          }
          runText += " ";
          col += 1;
          continue;
        }
        if (cell.width === 2 && col + 1 >= safeW) {
          if (runStyle !== "default") {
            flush();
            runStyle = "default";
          }
          runText += " ";
          col += 1;
          continue;
        }
        if (runStyle !== cell.style) {
          flush();
          runStyle = cell.style;
        }
        runText += cell.ch;
        col += cell.width;
      }
      flush();
      lines.push(out);
    }

    return lines;
  }
}

function applyStyle(text: string, role: StyleRole, theme: Theme | undefined): string {
  if (!theme || role === "default") return text;
  switch (role) {
    case "laneBorder":
      return theme.fg("borderMuted", text);
    case "laneTitle":
      return theme.bold(theme.fg("accent", text));
    case "poolTitle":
      return theme.bold(theme.fg("muted", text));
    case "startBorder":
      return theme.fg("success", text);
    case "endBorder":
      return theme.fg("error", text);
    case "eventBorder":
      return theme.fg("warning", text);
    case "taskBorder":
      return theme.fg("accent", text);
    case "gatewayBorder":
      return theme.fg("warning", text);
    case "selectedBorder":
      return theme.bold(theme.fg("success", text));
    case "selectedText":
      return theme.bold(theme.fg("text", text));
    case "nodeText":
      return theme.fg("text", text);
    case "edge":
      return theme.fg("dim", text);
    case "messageEdge":
      return theme.fg("accent", text);
    case "backEdge":
      return theme.fg("warning", text);
    case "edgeLabel":
      return theme.fg("warning", text);
    case "note":
      return theme.fg("muted", text);
    default:
      return text;
  }
}

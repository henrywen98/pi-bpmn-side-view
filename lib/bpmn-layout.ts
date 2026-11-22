import { visibleWidth } from "@earendil-works/pi-tui";
import { BpmnCanvas, clampText, type StyleRole, wrapLabel } from "./bpmn-canvas.ts";
import type {
  BpmnFlow,
  BpmnModel,
  BpmnNode,
  LayoutOrientation,
  NodeHitRect,
  ZoomLevel,
} from "./types.ts";

export interface RenderedBpmn {
  canvas: BpmnCanvas;
  hitRects: NodeHitRect[];
  /** Node IDs in logical reading order (rank, then track). */
  nodeOrder: string[];
  width: number;
  height: number;
  /** Effective mode actually used after auto-fit resolution. */
  effectiveZoom: ZoomLevel;
}

interface Track {
  id: string;
  title: string;
  poolName?: string;
  nodeIds: string[];
}

interface PlacedNode {
  node: BpmnNode;
  trackIdx: number;
  rank: number;
  subSlot: number;
  x: number;
  y: number;
  w: number;
  h: number;
  lines: string[];
  badge: string;
  compactPill?: boolean;
}

function laneTag(idx: number): string {
  return `${idx + 1}·`;
}

export function getNodeBadge(node: BpmnNode): string {
  const markerSuffix =
    node.eventMarker === "timer"
      ? "T"
      : node.eventMarker === "message"
        ? "M"
        : node.eventMarker === "error"
          ? "!"
          : node.eventMarker === "signal"
            ? "S"
            : node.eventMarker === "terminate"
              ? "X"
              : "";

  switch (node.kind) {
    case "startEvent":
      return markerSuffix ? `○[${markerSuffix}]` : "○";
    case "endEvent":
      return markerSuffix ? `◉[${markerSuffix}]` : "◉";
    case "intermediateCatchEvent":
    case "intermediateThrowEvent":
    case "boundaryEvent":
      return markerSuffix ? `◎[${markerSuffix}]` : "◎";
    case "exclusiveGateway":
      return "◇×";
    case "parallelGateway":
      return "◇+";
    case "inclusiveGateway":
      return "◇○";
    case "eventBasedGateway":
      return "◇◎";
    case "complexGateway":
      return "◇*";
    case "userTask":
      return "[U]";
    case "serviceTask":
      return "[S]";
    case "scriptTask":
      return "[#]";
    case "manualTask":
      return "[H]";
    case "businessRuleTask":
      return "[R]";
    case "sendTask":
      return "[→]";
    case "receiveTask":
      return "[←]";
    case "subProcess":
      return "[+]";
    case "callActivity":
      return "[⇒]";
    case "dataObjectReference":
    case "dataStoreReference":
      return "[D]";
    default:
      return "▪";
  }
}

function getShortBadge(node: BpmnNode): string {
  switch (node.kind) {
    case "startEvent":
      return "○";
    case "endEvent":
      return node.eventMarker === "terminate" ? "◈" : "◉";
    case "intermediateCatchEvent":
    case "intermediateThrowEvent":
    case "boundaryEvent":
      return "◎";
    case "exclusiveGateway":
      return "◇×";
    case "parallelGateway":
      return "◇+";
    case "inclusiveGateway":
      return "◇○";
    case "eventBasedGateway":
      return "◇◎";
    case "complexGateway":
      return "◇*";
    case "sendTask":
      return "→";
    case "receiveTask":
      return "←";
    case "callActivity":
      return "⇒";
    default:
      return "";
  }
}

export function getNodeKindLabel(node: BpmnNode): string {
  const base = node.kind.replace(/([A-Z])/g, " $1").trim();
  const pretty = base.charAt(0).toUpperCase() + base.slice(1);
  if (node.eventMarker !== "none") {
    return `${pretty} (${node.eventMarker})`;
  }
  return pretty;
}

function getBorderStyle(node: BpmnNode, selected: boolean): StyleRole {
  if (selected) return "selectedBorder";
  switch (node.kind) {
    case "startEvent":
      return "startBorder";
    case "endEvent":
      return "endBorder";
    case "intermediateCatchEvent":
    case "intermediateThrowEvent":
    case "boundaryEvent":
      return "eventBorder";
    case "exclusiveGateway":
    case "parallelGateway":
    case "inclusiveGateway":
    case "eventBasedGateway":
    case "complexGateway":
      return "gatewayBorder";
    case "dataObjectReference":
    case "dataStoreReference":
      return "note";
    default:
      return "taskBorder";
  }
}

function getPillDelimiters(node: BpmnNode, selected: boolean): [string, string] {
  if (selected) return ["▶", "◀"];
  switch (node.kind) {
    case "startEvent":
    case "intermediateCatchEvent":
    case "intermediateThrowEvent":
    case "boundaryEvent":
      return ["(", ")"];
    case "endEvent":
      return ["⟦", "⟧"];
    case "exclusiveGateway":
    case "parallelGateway":
    case "inclusiveGateway":
    case "eventBasedGateway":
    case "complexGateway":
      return ["‹", "›"];
    default:
      return ["[", "]"];
  }
}

function getBoxVariant(node: BpmnNode, selected: boolean): "rounded" | "sharp" | "double" | "dashed" {
  if (selected) return "double";
  switch (node.kind) {
    case "endEvent":
      return "double";
    case "exclusiveGateway":
    case "parallelGateway":
    case "inclusiveGateway":
    case "eventBasedGateway":
    case "complexGateway":
      return "sharp";
    case "dataObjectReference":
    case "dataStoreReference":
      return "dashed";
    default:
      return "rounded";
  }
}

function buildTracks(model: BpmnModel): { tracks: Track[]; nodeTrack: Map<string, number> } {
  const poolNameById = new Map(model.pools.map((p) => [p.id, p.name]));
  const tracks: Track[] = [];
  const nodeTrack = new Map<string, number>();

  for (const lane of model.lanes) {
    const idx = tracks.length;
    const poolName = lane.poolId ? poolNameById.get(lane.poolId) : undefined;
    tracks.push({
      id: lane.id,
      title: lane.name,
      poolName,
      nodeIds: [],
    });
    for (const nid of lane.nodeIds) {
      if (!nodeTrack.has(nid)) nodeTrack.set(nid, idx);
    }
  }

  for (const node of model.nodes) {
    if (nodeTrack.has(node.id)) continue;
    if (node.laneId) {
      const idx = tracks.findIndex((t) => t.id === node.laneId);
      if (idx !== -1) {
        nodeTrack.set(node.id, idx);
        continue;
      }
    }
    const poolKey = node.poolId ? `pool:${node.poolId}` : `proc:${node.processId}`;
    let idx = tracks.findIndex((t) => t.id === poolKey);
    if (idx === -1) {
      const poolName = node.poolId ? poolNameById.get(node.poolId) : undefined;
      const title = poolName || (tracks.length > 0 ? "Unassigned" : model.title || "Process");
      idx = tracks.length;
      tracks.push({ id: poolKey, title, poolName, nodeIds: [] });
    }
    nodeTrack.set(node.id, idx);
  }

  for (const node of model.nodes) {
    const idx = nodeTrack.get(node.id) ?? 0;
    if (tracks[idx]) tracks[idx]!.nodeIds.push(node.id);
  }

  const nonEmpty = tracks.filter((t) => t.nodeIds.length > 0);
  if (nonEmpty.length > 0 && nonEmpty.length !== tracks.length) {
    const remapped = new Map<string, number>();
    nonEmpty.forEach((t, newIdx) => {
      for (const nid of t.nodeIds) remapped.set(nid, newIdx);
    });
    return { tracks: nonEmpty, nodeTrack: remapped };
  }

  return { tracks, nodeTrack };
}

function computeRanks(
  model: BpmnModel,
): { ranks: Map<string, number>; backEdgeIds: Set<string> } {
  const nodeIds = new Set(model.nodes.map((n) => n.id));
  const outEdges = new Map<string, BpmnFlow[]>();
  const inDegree = new Map<string, number>();

  for (const n of model.nodes) {
    outEdges.set(n.id, []);
    inDegree.set(n.id, 0);
  }

  const seqFlows = model.flows.filter(
    (f) => f.kind === "sequenceFlow" && nodeIds.has(f.sourceRef) && nodeIds.has(f.targetRef),
  );
  for (const f of seqFlows) {
    outEdges.get(f.sourceRef)!.push(f);
    inDegree.set(f.targetRef, (inDegree.get(f.targetRef) ?? 0) + 1);
  }

  for (const n of model.nodes) {
    if (n.kind === "boundaryEvent" && n.attachedToRef && nodeIds.has(n.attachedToRef)) {
      const synthetic: BpmnFlow = {
        id: `__boundary_${n.id}`,
        name: "",
        kind: "sequenceFlow",
        sourceRef: n.attachedToRef,
        targetRef: n.id,
      };
      outEdges.get(n.attachedToRef)!.push(synthetic);
      inDegree.set(n.id, (inDegree.get(n.id) ?? 0) + 1);
    }
  }

  const state = new Map<string, 0 | 1 | 2>();
  const backEdgeIds = new Set<string>();

  const roots = [
    ...model.nodes.filter((n) => n.kind === "startEvent"),
    ...model.nodes.filter((n) => n.kind !== "startEvent" && (inDegree.get(n.id) ?? 0) === 0),
    ...model.nodes,
  ];

  const dfs = (u: string) => {
    state.set(u, 1);
    for (const f of outEdges.get(u) ?? []) {
      const v = f.targetRef;
      const st = state.get(v) ?? 0;
      if (st === 1) {
        backEdgeIds.add(f.id);
      } else if (st === 0) {
        dfs(v);
      }
    }
    state.set(u, 2);
  };

  for (const r of roots) {
    if ((state.get(r.id) ?? 0) === 0) dfs(r.id);
  }

  const ranks = new Map<string, number>();
  for (const n of model.nodes) ranks.set(n.id, 0);

  const dagEdges = seqFlows.filter((f) => !backEdgeIds.has(f.id));
  for (const n of model.nodes) {
    if (n.kind === "boundaryEvent" && n.attachedToRef && nodeIds.has(n.attachedToRef)) {
      dagEdges.push({
        id: `__boundary_${n.id}`,
        name: "",
        kind: "sequenceFlow",
        sourceRef: n.attachedToRef,
        targetRef: n.id,
      });
    }
  }

  for (let pass = 0; pass < model.nodes.length; pass++) {
    let changed = false;
    for (const f of dagEdges) {
      const nextRank = (ranks.get(f.sourceRef) ?? 0) + 1;
      if (nextRank > (ranks.get(f.targetRef) ?? 0)) {
        ranks.set(f.targetRef, nextRank);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const msgFlows = model.flows.filter(
    (f) => f.kind === "messageFlow" && nodeIds.has(f.sourceRef) && nodeIds.has(f.targetRef),
  );
  for (const n of model.nodes) {
    const hasSeq = seqFlows.some((f) => f.sourceRef === n.id || f.targetRef === n.id);
    if (hasSeq) continue;
    const peers = msgFlows
      .filter((f) => f.sourceRef === n.id || f.targetRef === n.id)
      .map((f) => (f.sourceRef === n.id ? f.targetRef : f.sourceRef));
    if (peers.length > 0) {
      const avg = Math.round(
        peers.reduce((sum, pid) => sum + (ranks.get(pid) ?? 0), 0) / peers.length,
      );
      ranks.set(n.id, avg);
    }
  }

  return { ranks, backEdgeIds };
}

function measureNodeBox(
  node: BpmnNode,
  maxInnerWidth: number,
  compactPill: boolean,
  prefixTag = "",
): {
  w: number;
  h: number;
  lines: string[];
  badge: string;
} {
  const badge = compactPill ? getShortBadge(node) : getNodeBadge(node);
  const label = node.name || node.id;
  const parts = [prefixTag, badge, label].filter(Boolean);
  const combined = parts.join(compactPill ? "" : " ");

  if (compactPill) {
    const text = clampText(
      prefixTag ? `${prefixTag}${badge ? badge : ""}${label}` : badge ? `${badge} ${label}` : label,
      Math.max(6, maxInnerWidth),
    );
    const w = Math.max(6, visibleWidth(text) + 2); // 1-col delimiters on left & right
    return { w, h: 1, lines: [text], badge };
  }

  const lines = wrapLabel(combined, maxInnerWidth, 3);
  const textW = lines.reduce((m, l) => Math.max(m, visibleWidth(l)), 4);
  const w = Math.max(10, Math.min(maxInnerWidth + 4, textW + 4));
  const h = lines.length + 2;
  return { w, h, lines, badge };
}

function drawPlacedNode(
  canvas: BpmnCanvas,
  pn: PlacedNode,
  selected: boolean,
): void {
  const borderStyle = getBorderStyle(pn.node, selected);
  const textStyle: StyleRole = selected ? "selectedText" : "nodeText";

  if (pn.compactPill || pn.h === 1) {
    const [leftD, rightD] = getPillDelimiters(pn.node, selected);
    const innerW = Math.max(1, pn.w - 2);
    const content = clampText(pn.lines[0] ?? "", innerW);
    const cw = visibleWidth(content);
    const padL = Math.floor((innerW - cw) / 2);
    canvas.setChar(pn.x, pn.y, leftD, borderStyle, { lock: true });
    for (let cx = pn.x + 1; cx < pn.x + pn.w - 1; cx++) {
      canvas.setChar(cx, pn.y, " ", textStyle, { lock: true });
    }
    canvas.drawText(pn.x + 1 + padL, pn.y, content, textStyle, { maxCols: innerW, lock: true });
    canvas.setChar(pn.x + pn.w - 1, pn.y, rightD, borderStyle, { lock: true });
    return;
  }

  const variant = getBoxVariant(pn.node, selected);
  canvas.drawBox(pn.x, pn.y, pn.w, pn.h, borderStyle, variant, true);

  const innerW = pn.w - 2;
  for (let i = 0; i < pn.lines.length; i++) {
    const line = clampText(pn.lines[i]!, innerW - 2);
    const lw = visibleWidth(line);
    const padLeft = Math.max(1, Math.floor((innerW - lw) / 2));
    canvas.drawText(pn.x + 1 + padLeft, pn.y + 1 + i, line, textStyle, {
      maxCols: innerW - 1,
      lock: true,
    });
  }
}

export function layoutAndRenderBpmn(
  model: BpmnModel,
  options: {
    orientation: LayoutOrientation;
    zoom?: ZoomLevel;
    selectedNodeId?: string;
    availableWidth?: number;
    availableHeight?: number;
  },
): RenderedBpmn {
  const zoom = options.zoom ?? "fit";
  if (model.nodes.length === 0) {
    const msg = model.diagnostics[0]?.message ?? "Empty BPMN diagram";
    const w = Math.max(28, visibleWidth(msg) + 6);
    const canvas = new BpmnCanvas(w, 5);
    canvas.drawBox(1, 1, w - 2, 3, "note", "dashed", true);
    canvas.drawText(3, 2, msg, "note", { maxCols: w - 6, lock: true });
    return { canvas, hitRects: [], nodeOrder: [], width: w, height: 5, effectiveZoom: zoom };
  }

  const { tracks, nodeTrack } = buildTracks(model);
  const { ranks, backEdgeIds } = computeRanks(model);
  const maxRank = Math.max(0, ...[...ranks.values()]);
  const showTrackHeaders = tracks.length > 1 || model.lanes.length > 0 || model.pools.length > 0;

  const cellGroups = new Map<string, BpmnNode[]>();
  for (const node of model.nodes) {
    const t = nodeTrack.get(node.id) ?? 0;
    const r = ranks.get(node.id) ?? 0;
    const key = `${t}:${r}`;
    const arr = cellGroups.get(key) ?? [];
    arr.push(node);
    cellGroups.set(key, arr);
  }
  for (const arr of cellGroups.values()) {
    arr.sort((a, b) => {
      if (a.bounds && b.bounds) {
        return options.orientation === "tb" ? a.bounds.x - b.bounds.x : a.bounds.y - b.bounds.y;
      }
      return a.id.localeCompare(b.id);
    });
  }

  const availW = Math.max(30, options.availableWidth ?? 64);
  const availH = Math.max(14, options.availableHeight ?? 30);

  if (zoom === "fit") {
    // 1. If detailed physical swimlanes already fit the viewport cleanly, use them!
    const detailTry = renderSwimlaneDiagram(
      model,
      tracks,
      nodeTrack,
      ranks,
      maxRank,
      backEdgeIds,
      cellGroups,
      showTrackHeaders,
      options.orientation,
      "detail",
      options.selectedNodeId,
    );
    if (detailTry.width <= availW && detailTry.height <= availH) {
      return { ...detailTry, effectiveZoom: "detail" };
    }

    // 2. If compact physical swimlanes fit the viewport width (and reasonable height), use them!
    const compactTry = renderSwimlaneDiagram(
      model,
      tracks,
      nodeTrack,
      ranks,
      maxRank,
      backEdgeIds,
      cellGroups,
      showTrackHeaders,
      options.orientation,
      "compact",
      options.selectedNodeId,
    );
    if (compactTry.width <= availW && compactTry.height <= Math.max(availH, 38)) {
      return { ...compactTry, effectiveZoom: "compact" };
    }

    // 3. Otherwise render the adaptive full-diagram fit strictly bounded to availW!
    return renderFitFullDiagram(
      model,
      tracks,
      nodeTrack,
      ranks,
      maxRank,
      backEdgeIds,
      showTrackHeaders,
      availW,
      availH,
      options.selectedNodeId,
    );
  }

  return renderSwimlaneDiagram(
    model,
    tracks,
    nodeTrack,
    ranks,
    maxRank,
    backEdgeIds,
    cellGroups,
    showTrackHeaders,
    options.orientation,
    zoom,
    options.selectedNodeId,
  );
}

/**
 * Adaptive Full-Diagram Fit View:
 * Strictly fits all pools/lanes, ranks, branches, loops, and message flows within `availW`
 * (zero horizontal scroll) and packs vertically to show the whole process at a glance.
 */
function renderFitFullDiagram(
  model: BpmnModel,
  tracks: Track[],
  nodeTrack: Map<string, number>,
  ranks: Map<string, number>,
  maxRank: number,
  backEdgeIds: Set<string>,
  showTrackHeaders: boolean,
  availW: number,
  availH: number,
  selectedNodeId: string | undefined,
): RenderedBpmn {
  const safeW = Math.max(30, Math.floor(availW));
  const hasBack = backEdgeIds.size > 0;
  const leftMargin = hasBack ? 3 : 0;
  const rightMargin = hasBack ? 3 : 0;
  const contentW = Math.max(24, safeW - leftMargin - rightMargin);

  // Build legend rows for swimlanes (1·Requester 2·Manager ...)
  const legendLines: string[] = [];
  if (showTrackHeaders && tracks.length > 0) {
    const items = tracks.map((t, i) => `${laneTag(i)}${t.title}`);
    let cur = "";
    for (const item of items) {
      const candidate = cur ? `${cur}  ${item}` : item;
      if (visibleWidth(candidate) > safeW - 2 && cur) {
        legendLines.push(cur);
        cur = item;
      } else {
        cur = candidate;
      }
    }
    if (cur) legendLines.push(cur);
  }

  // Group nodes by rank, ordered by trackIdx then id
  const nodesByRank: BpmnNode[][] = [];
  for (let r = 0; r <= maxRank; r++) {
    const arr = model.nodes
      .filter((n) => (ranks.get(n.id) ?? 0) === r)
      .sort((a, b) => {
        const ta = nodeTrack.get(a.id) ?? 0;
        const tb = nodeTrack.get(b.id) ?? 0;
        if (ta !== tb) return ta - tb;
        return a.id.localeCompare(b.id);
      });
    nodesByRank.push(arr);
  }

  // Decide vertical density: gapH = 2 rows if it fits availH, else 1 row
  const legendH = legendLines.length > 0 ? legendLines.length + 1 : 0;
  const noteH = model.annotations.length > 0 ? model.annotations.length + 1 : 0;
  const neededWith2Gap = legendH + (maxRank + 1) * 1 + maxRank * 2 + noteH + 1;
  const gapH = neededWith2Gap <= availH ? 2 : 1;

  // Measure and place pills rank by rank within contentW
  const placedById = new Map<string, PlacedNode>();
  const placedList: PlacedNode[] = [];
  let curY = legendH;

  for (let r = 0; r <= maxRank; r++) {
    const rowNodes = nodesByRank[r]!;
    if (rowNodes.length === 0) continue;

    // Split rowNodes into sub-rows only if they can't fit side by side (min 10 cols each)
    const maxPerLine = Math.max(1, Math.floor((contentW + 1) / 11));
    const chunks: BpmnNode[][] = [];
    for (let i = 0; i < rowNodes.length; i += maxPerLine) {
      chunks.push(rowNodes.slice(i, i + maxPerLine));
    }

    for (let cIdx = 0; cIdx < chunks.length; cIdx++) {
      const chunk = chunks[cIdx]!;
      const gapX = chunk.length > 1 ? 1 : 0;
      const perSlotMax = Math.max(
        8,
        Math.floor((contentW - gapX * (chunk.length - 1)) / chunk.length),
      );
      const measured = chunk.map((node) => {
        const tIdx = nodeTrack.get(node.id) ?? 0;
        const prefix = showTrackHeaders && tracks.length > 1 ? laneTag(tIdx) : "";
        return measureNodeBox(node, perSlotMax - 2, true, prefix);
      });
      const totalChunkW =
        measured.reduce((s, m) => s + m.w, 0) + gapX * Math.max(0, chunk.length - 1);
      let gx = leftMargin + Math.max(0, Math.floor((contentW - totalChunkW) / 2));

      for (let i = 0; i < chunk.length; i++) {
        const node = chunk[i]!;
        const m = measured[i]!;
        const pn: PlacedNode = {
          node,
          trackIdx: nodeTrack.get(node.id) ?? 0,
          rank: r,
          subSlot: i,
          x: gx,
          y: curY,
          w: m.w,
          h: 1,
          lines: m.lines,
          badge: m.badge,
          compactPill: true,
        };
        placedById.set(node.id, pn);
        placedList.push(pn);
        gx += m.w + gapX;
      }
      curY += 1;
      if (cIdx < chunks.length - 1) curY += 1;
    }

    if (r < maxRank) curY += gapH;
  }

  const totalHeight = curY + (noteH > 0 ? noteH + 1 : 1);
  const canvas = new BpmnCanvas(safeW, totalHeight);

  // Draw swimlane legend at top
  if (legendLines.length > 0) {
    for (let i = 0; i < legendLines.length; i++) {
      canvas.drawText(0, i, legendLines[i]!, "laneTitle", { maxCols: safeW, lock: true });
    }
    for (let x = 0; x < safeW; x++) {
      canvas.setChar(x, legendLines.length, "┄", "laneBorder", { lock: true });
    }
  }

  // Draw all node pills first (locked)
  const hitRects: NodeHitRect[] = [];
  for (const pn of placedList) {
    drawPlacedNode(canvas, pn, pn.node.id === selectedNodeId);
    hitRects.push({ nodeId: pn.node.id, x: pn.x, y: pn.y, width: pn.w, height: pn.h });
  }

  // Draw edges cleanly within safeW
  let backIdx = 0;
  for (const flow of model.flows) {
    const src = placedById.get(flow.sourceRef);
    const dst = placedById.get(flow.targetRef);
    if (!src || !dst) continue;

    const isBack = backEdgeIds.has(flow.id) || (flow.kind === "sequenceFlow" && dst.y <= src.y);
    const isMsg = flow.kind === "messageFlow";
    const style: StyleRole = isMsg ? "messageEdge" : isBack ? "backEdge" : "edge";
    const label = flow.name || (flow.isDefault ? "default" : "");

    if (isBack) {
      const useLeftGutter = src.x <= leftMargin + Math.floor(contentW / 3);
      if (useLeftGutter) {
        const gutterX = Math.min(leftMargin - 1, Math.max(0, backIdx));
        backIdx++;
        canvas.drawPolyline(
          [
            { x: src.x - 1, y: src.y },
            { x: gutterX, y: src.y },
            { x: gutterX, y: dst.y },
            { x: dst.x - 1, y: dst.y },
          ],
          style,
          { arrow: "right" },
        );
        const tag = label ? `«${clampText(label, 8)}` : "«";
        const midY = Math.round((src.y + dst.y) / 2);
        canvas.drawText(gutterX + 1, midY, tag, "backEdge", { skipLocked: true });
      } else {
        const gutterX = Math.max(leftMargin + contentW, safeW - 1 - backIdx);
        backIdx++;
        canvas.drawPolyline(
          [
            { x: src.x + src.w, y: src.y },
            { x: gutterX, y: src.y },
            { x: gutterX, y: dst.y },
            { x: dst.x + dst.w, y: dst.y },
          ],
          style,
          { arrow: "left" },
        );
        const tag = label ? `«${clampText(label, 8)}` : "«";
        const midY = Math.round((src.y + dst.y) / 2);
        canvas.drawText(Math.max(0, gutterX - visibleWidth(tag)), midY, tag, "backEdge", {
          skipLocked: true,
        });
      }
      continue;
    }

    if (isMsg) {
      const srcCx = src.x + Math.floor(src.w / 2);
      const dstCx = dst.x + Math.floor(dst.w / 2);
      if (src.y === dst.y) {
        const goRight = dst.x >= src.x;
        canvas.drawPolyline(
          [
            { x: goRight ? src.x + src.w : src.x - 1, y: src.y },
            { x: goRight ? dst.x - 1 : dst.x + dst.w, y: dst.y },
          ],
          style,
          { dashed: true, arrow: goRight ? "right" : "left" },
        );
      } else {
        const goDown = dst.y > src.y;
        const midY = Math.round((src.y + dst.y) / 2);
        canvas.drawPolyline(
          [
            { x: srcCx, y: goDown ? src.y + 1 : src.y - 1 },
            { x: srcCx, y: midY },
            { x: dstCx, y: midY },
            { x: dstCx, y: goDown ? dst.y - 1 : dst.y + 1 },
          ],
          style,
          { dashed: true, arrow: goDown ? "down" : "up" },
        );
      }
      continue;
    }

    // Forward downward sequence flow
    const srcCx = src.x + Math.floor(src.w / 2);
    const dstCx = dst.x + Math.floor(dst.w / 2);
    const startY = src.y + 1;
    const endY = dst.y - 1;
    if (endY < startY) continue;

    if (startY === endY) {
      // Tight 1-row gap
      if (srcCx === dstCx) {
        canvas.setChar(dstCx, endY, "▼", style, { skipLocked: true });
      } else {
        canvas.drawPolyline(
          [
            { x: srcCx, y: startY },
            { x: dstCx, y: endY },
          ],
          style,
          { arrow: "down" },
        );
      }
      if (label && Math.abs(dstCx - srcCx) >= 4) {
        canvas.drawEdgeLabel(Math.round((srcCx + dstCx) / 2), startY, clampText(label, 8));
      }
    } else {
      const midY = Math.min(endY - 1, startY);
      if (srcCx === dstCx) {
        canvas.drawPolyline(
          [
            { x: srcCx, y: startY },
            { x: dstCx, y: endY },
          ],
          style,
          { arrow: "down" },
        );
        if (label) {
          canvas.drawEdgeLabel(srcCx + Math.ceil(visibleWidth(label) / 2) + 2, startY, clampText(label, 8));
        }
      } else {
        canvas.drawPolyline(
          [
            { x: srcCx, y: startY },
            { x: srcCx, y: midY },
            { x: dstCx, y: midY },
            { x: dstCx, y: endY },
          ],
          style,
          { arrow: "down" },
        );
        if (label) {
          canvas.drawEdgeLabel(Math.round((srcCx + dstCx) / 2), midY, clampText(label, 8));
        }
      }
    }
  }

  // Notes at bottom
  if (model.annotations.length > 0) {
    const ny = curY + 1;
    for (let i = 0; i < model.annotations.length; i++) {
      const ann = model.annotations[i]!;
      canvas.drawText(0, ny + i, `┆ ${ann.text}`, "note", { maxCols: safeW, lock: true });
    }
  }

  const nodeOrder = placedList.map((p) => p.node.id);
  return {
    canvas,
    hitRects,
    nodeOrder,
    width: safeW,
    height: totalHeight,
    effectiveZoom: "fit",
  };
}

function renderSwimlaneDiagram(
  model: BpmnModel,
  tracks: Track[],
  nodeTrack: Map<string, number>,
  ranks: Map<string, number>,
  maxRank: number,
  backEdgeIds: Set<string>,
  cellGroups: Map<string, BpmnNode[]>,
  showTrackHeaders: boolean,
  orientation: LayoutOrientation,
  density: "compact" | "detail",
  selectedNodeId: string | undefined,
): RenderedBpmn {
  const isCompact = density === "compact";
  const maxBoxInner = isCompact
    ? orientation === "tb"
      ? 12
      : 14
    : orientation === "tb"
      ? 14
      : 18;
  const measured = new Map<string, ReturnType<typeof measureNodeBox>>();
  for (const node of model.nodes) {
    measured.set(node.id, measureNodeBox(node, maxBoxInner, isCompact));
  }

  if (orientation === "tb") {
    return renderTopToBottom(
      model,
      tracks,
      nodeTrack,
      ranks,
      maxRank,
      backEdgeIds,
      cellGroups,
      measured,
      showTrackHeaders,
      isCompact,
      selectedNodeId,
    );
  }
  return renderLeftToRight(
    model,
    tracks,
    nodeTrack,
    ranks,
    maxRank,
    backEdgeIds,
    cellGroups,
    measured,
    showTrackHeaders,
    isCompact,
    selectedNodeId,
  );
}

function renderTopToBottom(
  model: BpmnModel,
  tracks: Track[],
  _nodeTrack: Map<string, number>,
  _ranks: Map<string, number>,
  maxRank: number,
  backEdgeIds: Set<string>,
  cellGroups: Map<string, BpmnNode[]>,
  measured: Map<string, ReturnType<typeof measureNodeBox>>,
  showTrackHeaders: boolean,
  isCompact: boolean,
  selectedNodeId: string | undefined,
): RenderedBpmn {
  const PAD_X = 1;
  const SUB_GAP_X = isCompact ? 1 : 2;
  const RANK_GAP_Y = isCompact ? 2 : 3;
  const HEADER_H = showTrackHeaders ? 3 : 1;
  const RETURN_GUTTER_RIGHT = backEdgeIds.size > 0 ? (isCompact ? 9 : 11) : 2;

  const trackWidths = tracks.map((track, tIdx) => {
    let w = Math.max(isCompact ? 12 : 18, visibleWidth(track.title) + 2);
    for (let r = 0; r <= maxRank; r++) {
      const group = cellGroups.get(`${tIdx}:${r}`) ?? [];
      if (group.length === 0) continue;
      const sumW =
        group.reduce((s, n) => s + measured.get(n.id)!.w, 0) +
        Math.max(0, group.length - 1) * SUB_GAP_X +
        PAD_X * 2;
      if (sumW > w) w = sumW;
    }
    return w;
  });

  const trackX: number[] = [];
  let curX = 1;
  for (const tw of trackWidths) {
    trackX.push(curX);
    curX += tw + 1;
  }
  const laneAreaRight = curX;
  const totalWidth = laneAreaRight + RETURN_GUTTER_RIGHT;

  const rankHeights: number[] = [];
  for (let r = 0; r <= maxRank; r++) {
    let maxH = isCompact ? 1 : 3;
    for (let tIdx = 0; tIdx < tracks.length; tIdx++) {
      const group = cellGroups.get(`${tIdx}:${r}`) ?? [];
      for (const n of group) {
        const h = measured.get(n.id)!.h;
        if (h > maxH) maxH = h;
      }
    }
    rankHeights.push(maxH);
  }

  const rankY: number[] = [];
  let curY = HEADER_H + 1;
  for (const rh of rankHeights) {
    rankY.push(curY);
    curY += rh + RANK_GAP_Y;
  }

  const noteRows = model.annotations.length > 0 ? model.annotations.length + 3 : 0;
  const laneAreaBottom = curY;
  const totalHeight = laneAreaBottom + noteRows + 1;

  const canvas = new BpmnCanvas(totalWidth, totalHeight);

  if (showTrackHeaders) {
    canvas.drawBox(0, 0, laneAreaRight, laneAreaBottom, "laneBorder", "sharp", false);
    for (let tIdx = 0; tIdx < tracks.length; tIdx++) {
      const tx = trackX[tIdx]!;
      const tw = trackWidths[tIdx]!;
      const track = tracks[tIdx]!;
      if (tIdx > 0) {
        const divX = tx - 1;
        canvas.setChar(divX, 0, "┬", "laneBorder");
        canvas.setChar(divX, HEADER_H - 1, "┼", "laneBorder");
        canvas.setChar(divX, laneAreaBottom - 1, "┴", "laneBorder");
        for (let y = 1; y < laneAreaBottom - 1; y++) {
          if (y === HEADER_H - 1) continue;
          canvas.setChar(divX, y, "│", "laneBorder");
        }
      }
      for (let x = tx; x < tx + tw; x++) {
        canvas.setChar(x, HEADER_H - 1, "─", "laneBorder");
      }
      if (tIdx === 0) canvas.setChar(0, HEADER_H - 1, "├", "laneBorder");
      if (tIdx === tracks.length - 1) canvas.setChar(laneAreaRight - 1, HEADER_H - 1, "┤", "laneBorder");

      const title = clampText(track.title, tw - 2);
      const pad = Math.max(0, Math.floor((tw - visibleWidth(title)) / 2));
      canvas.drawText(tx + pad, 1, title, "laneTitle", { maxCols: tw - 1, lock: true });
    }
  }

  const placedById = new Map<string, PlacedNode>();
  const placedList: PlacedNode[] = [];
  for (let r = 0; r <= maxRank; r++) {
    for (let tIdx = 0; tIdx < tracks.length; tIdx++) {
      const group = cellGroups.get(`${tIdx}:${r}`) ?? [];
      if (group.length === 0) continue;
      const totalGroupW =
        group.reduce((s, n) => s + measured.get(n.id)!.w, 0) +
        Math.max(0, group.length - 1) * SUB_GAP_X;
      let gx = trackX[tIdx]! + Math.max(1, Math.floor((trackWidths[tIdx]! - totalGroupW) / 2));
      for (let sub = 0; sub < group.length; sub++) {
        const node = group[sub]!;
        const m = measured.get(node.id)!;
        const py = rankY[r]! + Math.floor((rankHeights[r]! - m.h) / 2);
        const pn: PlacedNode = {
          node,
          trackIdx: tIdx,
          rank: r,
          subSlot: sub,
          x: gx,
          y: py,
          w: m.w,
          h: m.h,
          lines: m.lines,
          badge: m.badge,
          compactPill: isCompact,
        };
        placedById.set(node.id, pn);
        placedList.push(pn);
        gx += m.w + SUB_GAP_X;
      }
    }
  }

  const hitRects: NodeHitRect[] = [];
  for (const pn of placedList) {
    drawPlacedNode(canvas, pn, pn.node.id === selectedNodeId);
    hitRects.push({ nodeId: pn.node.id, x: pn.x, y: pn.y, width: pn.w, height: pn.h });
  }

  let backChannelIdx = 0;
  for (const flow of model.flows) {
    const src = placedById.get(flow.sourceRef);
    const dst = placedById.get(flow.targetRef);
    if (!src || !dst) continue;

    const isBack = backEdgeIds.has(flow.id) || (flow.kind === "sequenceFlow" && dst.rank <= src.rank);
    const isMsg = flow.kind === "messageFlow";
    const style: StyleRole = isMsg ? "messageEdge" : isBack ? "backEdge" : "edge";
    const label = flow.name || (flow.isDefault ? "default" : "");

    if (isMsg) {
      const srcY = src.y + Math.floor(src.h / 2);
      const dstY = dst.y + Math.floor(dst.h / 2);
      const goRight = dst.x >= src.x;
      const startX = goRight ? src.x + src.w : src.x - 1;
      const endX = goRight ? dst.x - 1 : dst.x + dst.w;
      const minX = Math.min(startX, endX);
      const maxX = Math.max(startX, endX);
      const hasBlocker = placedList.some(
        (p) =>
          p.node.id !== src.node.id &&
          p.node.id !== dst.node.id &&
          srcY >= p.y &&
          srcY < p.y + p.h &&
          p.x < maxX &&
          p.x + p.w > minX,
      );
      if (hasBlocker) {
        const corridorY = src.y + src.h;
        const srcCenterX = src.x + Math.floor(src.w / 2);
        const approachX = goRight ? dst.x - 2 : dst.x + dst.w + 1;
        canvas.drawPolyline(
          [
            { x: srcCenterX, y: corridorY },
            { x: approachX, y: corridorY },
            { x: approachX, y: dstY },
            { x: endX, y: dstY },
          ],
          style,
          { dashed: true, arrow: goRight ? "right" : "left" },
        );
        if (label) {
          canvas.drawEdgeLabel(
            Math.round((srcCenterX + approachX) / 2),
            corridorY,
            clampText(label, 12),
            "messageEdge",
          );
        }
      } else {
        const midX = Math.round((startX + endX) / 2);
        canvas.drawPolyline(
          [
            { x: startX, y: srcY },
            { x: midX, y: srcY },
            { x: midX, y: dstY },
            { x: endX, y: dstY },
          ],
          style,
          { dashed: true, arrow: goRight ? "right" : "left" },
        );
        if (label) {
          canvas.drawEdgeLabel(midX, Math.min(srcY, dstY), clampText(label, 12), "messageEdge");
        }
      }
      continue;
    }

    if (isBack) {
      const gutterX = Math.min(totalWidth - 2, laneAreaRight + 1 + backChannelIdx * 2);
      backChannelIdx++;
      const srcCenterX = src.x + Math.floor(src.w / 2);
      const exitY = src.y + src.h;
      const dstY = dst.y + Math.floor(dst.h / 2);
      canvas.drawPolyline(
        [
          { x: srcCenterX, y: exitY },
          { x: gutterX, y: exitY },
          { x: gutterX, y: dstY },
          { x: dst.x + dst.w, y: dstY },
        ],
        style,
        { arrow: "left" },
      );
      const backLabel = label ? `«${label}` : "«";
      canvas.drawText(
        Math.max(gutterX - 1, laneAreaRight),
        Math.round((exitY + dstY) / 2),
        clampText(backLabel, Math.max(4, totalWidth - laneAreaRight)),
        "backEdge",
        { skipLocked: true },
      );
      continue;
    }

    const srcCenterX = src.x + Math.floor(src.w / 2);
    const dstCenterX = dst.x + Math.floor(dst.w / 2);
    const startY = src.y + src.h;
    const endY = dst.y - 1;

    if (srcCenterX === dstCenterX && dst.rank === src.rank + 1) {
      canvas.drawPolyline(
        [
          { x: srcCenterX, y: startY },
          { x: dstCenterX, y: endY },
        ],
        style,
        { arrow: "down" },
      );
      if (label) {
        canvas.drawEdgeLabel(srcCenterX + Math.ceil(visibleWidth(label) / 2) + 1, startY, clampText(label, 12));
      }
    } else if (dst.rank === src.rank + 1) {
      const midY = Math.min(endY - 1, startY + (isCompact ? 0 : 1));
      canvas.drawPolyline(
        [
          { x: srcCenterX, y: startY },
          { x: srcCenterX, y: midY },
          { x: dstCenterX, y: midY },
          { x: dstCenterX, y: endY },
        ],
        style,
        { arrow: "down" },
      );
      if (label) {
        const lx = Math.round((srcCenterX + dstCenterX) / 2);
        canvas.drawEdgeLabel(lx, midY, clampText(label, 12));
      }
    } else {
      const routeX =
        dstCenterX >= srcCenterX
          ? trackX[dst.trackIdx]! + trackWidths[dst.trackIdx]! - 1
          : trackX[dst.trackIdx]!;
      const dropY = startY;
      const enterY = Math.max(dropY + 1, endY - 1);
      canvas.drawPolyline(
        [
          { x: srcCenterX, y: dropY },
          { x: routeX, y: dropY },
          { x: routeX, y: enterY },
          { x: dstCenterX, y: enterY },
          { x: dstCenterX, y: endY },
        ],
        style,
        { arrow: "down" },
      );
      if (label) {
        canvas.drawEdgeLabel(Math.round((srcCenterX + routeX) / 2), dropY, clampText(label, 12));
      }
    }
  }

  if (model.annotations.length > 0) {
    const noteY = laneAreaBottom + 1;
    canvas.drawText(1, noteY, "Notes:", "note", { lock: true });
    for (let i = 0; i < model.annotations.length; i++) {
      const ann = model.annotations[i]!;
      const targetNames = ann.targetIds
        .map((id) => placedById.get(id)?.node.name || id)
        .join(", ");
      const prefix = targetNames ? `┆ [${targetNames}] ` : "┆ ";
      canvas.drawText(1, noteY + 1 + i, `${prefix}${ann.text}`, "note", {
        maxCols: totalWidth - 2,
        lock: true,
      });
    }
  }

  const nodeOrder = placedList.map((p) => p.node.id);
  return {
    canvas,
    hitRects,
    nodeOrder,
    width: totalWidth,
    height: totalHeight,
    effectiveZoom: isCompact ? "compact" : "detail",
  };
}

function renderLeftToRight(
  model: BpmnModel,
  tracks: Track[],
  _nodeTrack: Map<string, number>,
  _ranks: Map<string, number>,
  maxRank: number,
  backEdgeIds: Set<string>,
  cellGroups: Map<string, BpmnNode[]>,
  measured: Map<string, ReturnType<typeof measureNodeBox>>,
  showTrackHeaders: boolean,
  isCompact: boolean,
  selectedNodeId: string | undefined,
): RenderedBpmn {
  const LANE_LABEL_W = showTrackHeaders
    ? Math.max(8, Math.min(isCompact ? 12 : 18, Math.max(...tracks.map((t) => visibleWidth(t.title))) + 3))
    : 1;
  const RANK_GAP_X = isCompact ? 4 : 6;
  const SUB_GAP_Y = 1;
  const PAD_Y = 1;
  const RETURN_GUTTER_BOTTOM = backEdgeIds.size > 0 ? 3 : 1;

  const rankWidths: number[] = [];
  for (let r = 0; r <= maxRank; r++) {
    let maxW = isCompact ? 8 : 12;
    for (let tIdx = 0; tIdx < tracks.length; tIdx++) {
      const group = cellGroups.get(`${tIdx}:${r}`) ?? [];
      for (const n of group) {
        const w = measured.get(n.id)!.w;
        if (w > maxW) maxW = w;
      }
    }
    rankWidths.push(maxW);
  }

  const rankX: number[] = [];
  let curX = LANE_LABEL_W + 2;
  for (const rw of rankWidths) {
    rankX.push(curX);
    curX += rw + RANK_GAP_X;
  }
  const laneAreaRight = curX;

  const trackHeights = tracks.map((_track, tIdx) => {
    let h = isCompact ? 3 : 5;
    for (let r = 0; r <= maxRank; r++) {
      const group = cellGroups.get(`${tIdx}:${r}`) ?? [];
      if (group.length === 0) continue;
      const sumH =
        group.reduce((s, n) => s + measured.get(n.id)!.h, 0) +
        Math.max(0, group.length - 1) * SUB_GAP_Y +
        PAD_Y * 2;
      if (sumH > h) h = sumH;
    }
    return h;
  });

  const trackY: number[] = [];
  let curY = 1;
  for (const th of trackHeights) {
    trackY.push(curY);
    curY += th + 1;
  }
  const laneAreaBottom = curY;
  const noteRows = model.annotations.length > 0 ? model.annotations.length + 3 : 0;
  const totalWidth = laneAreaRight + 2;
  const totalHeight = laneAreaBottom + RETURN_GUTTER_BOTTOM + noteRows + 1;

  const canvas = new BpmnCanvas(totalWidth, totalHeight);

  if (showTrackHeaders) {
    canvas.drawBox(0, 0, laneAreaRight, laneAreaBottom, "laneBorder", "sharp", false);
    for (let y = 1; y < laneAreaBottom - 1; y++) {
      canvas.setChar(LANE_LABEL_W, y, "│", "laneBorder");
    }
    canvas.setChar(LANE_LABEL_W, 0, "┬", "laneBorder");
    canvas.setChar(LANE_LABEL_W, laneAreaBottom - 1, "┴", "laneBorder");

    for (let tIdx = 0; tIdx < tracks.length; tIdx++) {
      const ty = trackY[tIdx]!;
      const th = trackHeights[tIdx]!;
      if (tIdx > 0) {
        const divY = ty - 1;
        canvas.setChar(0, divY, "├", "laneBorder");
        canvas.setChar(LANE_LABEL_W, divY, "┼", "laneBorder");
        canvas.setChar(laneAreaRight - 1, divY, "┤", "laneBorder");
        for (let x = 1; x < laneAreaRight - 1; x++) {
          if (x === LANE_LABEL_W) continue;
          canvas.setChar(x, divY, "─", "laneBorder");
        }
      }
      const wrapped = wrapLabel(tracks[tIdx]!.title, LANE_LABEL_W - 2, Math.max(1, th - 1));
      const startY = ty + Math.max(0, Math.floor((th - wrapped.length) / 2));
      for (let i = 0; i < wrapped.length; i++) {
        canvas.drawText(1, startY + i, wrapped[i]!, "laneTitle", {
          maxCols: LANE_LABEL_W - 2,
          lock: true,
        });
      }
    }
  }

  const placedById = new Map<string, PlacedNode>();
  const placedList: PlacedNode[] = [];
  for (let r = 0; r <= maxRank; r++) {
    for (let tIdx = 0; tIdx < tracks.length; tIdx++) {
      const group = cellGroups.get(`${tIdx}:${r}`) ?? [];
      if (group.length === 0) continue;
      const totalGroupH =
        group.reduce((s, n) => s + measured.get(n.id)!.h, 0) +
        Math.max(0, group.length - 1) * SUB_GAP_Y;
      let gy = trackY[tIdx]! + Math.max(1, Math.floor((trackHeights[tIdx]! - totalGroupH) / 2));
      for (let sub = 0; sub < group.length; sub++) {
        const node = group[sub]!;
        const m = measured.get(node.id)!;
        const px = rankX[r]! + Math.floor((rankWidths[r]! - m.w) / 2);
        const pn: PlacedNode = {
          node,
          trackIdx: tIdx,
          rank: r,
          subSlot: sub,
          x: px,
          y: gy,
          w: m.w,
          h: m.h,
          lines: m.lines,
          badge: m.badge,
          compactPill: isCompact,
        };
        placedById.set(node.id, pn);
        placedList.push(pn);
        gy += m.h + SUB_GAP_Y;
      }
    }
  }

  const hitRects: NodeHitRect[] = [];
  for (const pn of placedList) {
    drawPlacedNode(canvas, pn, pn.node.id === selectedNodeId);
    hitRects.push({ nodeId: pn.node.id, x: pn.x, y: pn.y, width: pn.w, height: pn.h });
  }

  let backRowIdx = 0;
  for (const flow of model.flows) {
    const src = placedById.get(flow.sourceRef);
    const dst = placedById.get(flow.targetRef);
    if (!src || !dst) continue;

    const isBack = backEdgeIds.has(flow.id) || (flow.kind === "sequenceFlow" && dst.rank <= src.rank);
    const isMsg = flow.kind === "messageFlow";
    const style: StyleRole = isMsg ? "messageEdge" : isBack ? "backEdge" : "edge";
    const label = flow.name || (flow.isDefault ? "default" : "");

    if (isMsg) {
      const srcX = src.x + Math.floor(src.w / 2);
      const dstX = dst.x + Math.floor(dst.w / 2);
      const goDown = dst.y >= src.y;
      const startY = goDown ? src.y + src.h : src.y - 1;
      const endY = goDown ? dst.y - 1 : dst.y + dst.h;
      const midY = Math.round((startY + endY) / 2);
      canvas.drawPolyline(
        [
          { x: srcX, y: startY },
          { x: srcX, y: midY },
          { x: dstX, y: midY },
          { x: dstX, y: endY },
        ],
        style,
        { dashed: true, arrow: goDown ? "down" : "up" },
      );
      if (label) {
        canvas.drawEdgeLabel(Math.round((srcX + dstX) / 2), midY, clampText(label, 12), "messageEdge");
      }
      continue;
    }

    if (isBack) {
      const gutterY = Math.min(laneAreaBottom + RETURN_GUTTER_BOTTOM - 1, laneAreaBottom + backRowIdx);
      backRowIdx++;
      const srcX = src.x + Math.floor(src.w / 2);
      const dstX = dst.x + Math.floor(dst.w / 2);
      canvas.drawPolyline(
        [
          { x: srcX, y: src.y + src.h },
          { x: srcX, y: gutterY },
          { x: dstX, y: gutterY },
          { x: dstX, y: dst.y + dst.h },
        ],
        style,
        { arrow: "up" },
      );
      const backLabel = label ? `«${label}` : "«";
      canvas.drawEdgeLabel(Math.round((srcX + dstX) / 2), gutterY, clampText(backLabel, 14), "backEdge");
      continue;
    }

    const srcCenterY = src.y + Math.floor(src.h / 2);
    const dstCenterY = dst.y + Math.floor(dst.h / 2);
    const startX = src.x + src.w;
    const endX = dst.x - 1;
    const midX = Math.max(startX + 1, Math.min(endX - 1, Math.round((startX + endX) / 2)));

    canvas.drawPolyline(
      [
        { x: startX, y: srcCenterY },
        { x: midX, y: srcCenterY },
        { x: midX, y: dstCenterY },
        { x: endX, y: dstCenterY },
      ],
      style,
      { arrow: "right" },
    );
    if (label) {
      const labelY = srcCenterY === dstCenterY ? Math.max(1, srcCenterY - 1) : Math.round((srcCenterY + dstCenterY) / 2);
      canvas.drawEdgeLabel(midX, labelY, clampText(label, 10));
    }
  }

  if (model.annotations.length > 0) {
    const noteY = laneAreaBottom + RETURN_GUTTER_BOTTOM + 1;
    canvas.drawText(1, noteY, "Notes:", "note", { lock: true });
    for (let i = 0; i < model.annotations.length; i++) {
      const ann = model.annotations[i]!;
      const targetNames = ann.targetIds
        .map((id) => placedById.get(id)?.node.name || id)
        .join(", ");
      const prefix = targetNames ? `┆ [${targetNames}] ` : "┆ ";
      canvas.drawText(1, noteY + 1 + i, `${prefix}${ann.text}`, "note", {
        maxCols: totalWidth - 2,
        lock: true,
      });
    }
  }

  const nodeOrder = placedList.map((p) => p.node.id);
  return {
    canvas,
    hitRects,
    nodeOrder,
    width: totalWidth,
    height: totalHeight,
    effectiveZoom: isCompact ? "compact" : "detail",
  };
}

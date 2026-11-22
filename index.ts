import { existsSync, type FSWatcher, readdirSync, readFileSync, statSync, watch } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEMO_BPMN_XML, extractBpmnFromMarkdown, parseBpmnXml } from "./lib/bpmn-parser.ts";
import {
  BpmnSidePaneComponent,
  BpmnSideViewManager,
  MAX_SIZE_PERCENT,
  MIN_SIZE_PERCENT,
} from "./lib/side-view.ts";
import type { BpmnModel, DockPreference, LayoutOrientation, ZoomLevel } from "./lib/types.ts";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".turbo"]);

function findBpmnFiles(rootDir: string, maxDepth = 3, maxFiles = 40): string[] {
  const results: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || results.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(join(dir, entry.name), depth + 1);
      } else if (entry.isFile() && /\.bpmn2?$/i.test(entry.name)) {
        results.push(join(dir, entry.name));
      }
    }
  };
  walk(rootDir, 0);
  return results.sort();
}

function extractMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
        return String((part as { text?: string }).text ?? "");
      }
      return "";
    })
    .join("\n");
}

function summarizeModel(model: BpmnModel, sourceLabel: string, layout: LayoutOrientation, open: boolean): string {
  const lines = [
    `BPMN "${model.title}" (${sourceLabel})`,
    `Side view: ${open ? "open" : "closed"} · Layout: ${layout.toUpperCase()}`,
    `Elements: ${model.nodes.length} nodes, ${model.flows.length} flows, ${model.pools.length} pools, ${model.lanes.length} lanes`,
  ];
  if (model.diagnostics.length > 0) {
    lines.push(`Diagnostics: ${model.diagnostics.map((d) => `${d.level}: ${d.message}`).join("; ")}`);
  }
  return lines.join("\n");
}

export default function bpmnSideView(pi: ExtensionAPI) {
  let activeCtx: ExtensionContext | null = null;
  let currentFilePath: string | null = null;
  let currentSourceLabel = "";
  let watcher: FSWatcher | null = null;
  let watchTimer: ReturnType<typeof setTimeout> | null = null;
  let autoDetect = true;
  let unsubscribeInput: (() => void) | null = null;

  const stopWatching = () => {
    if (watchTimer) {
      clearTimeout(watchTimer);
      watchTimer = null;
    }
    if (watcher) {
      try {
        watcher.close();
      } catch {
        // ignore close errors
      }
      watcher = null;
    }
  };

  const manager = new BpmnSideViewManager({
    getTheme: () => activeCtx!.ui.theme,
    onStatusChange: (status) => {
      if (activeCtx?.mode === "tui") {
        activeCtx.ui.setStatus("bpmn-side-view", status);
      }
    },
    onReloadRequested: () => {
      if (currentFilePath && activeCtx) {
        loadFile(currentFilePath, activeCtx, { preserveScroll: true, notify: true });
      }
    },
  });

  const startWatching = (filePath: string) => {
    stopWatching();
    try {
      watcher = watch(filePath, () => {
        if (watchTimer) clearTimeout(watchTimer);
        watchTimer = setTimeout(() => {
          watchTimer = null;
          if (currentFilePath === filePath && manager.isOpen() && activeCtx) {
            loadFile(filePath, activeCtx, { preserveScroll: true, notify: false });
          }
        }, 120);
      });
      watcher.on("error", () => stopWatching());
    } catch {
      stopWatching();
    }
  };

  const loadXml = (
    xml: string,
    sourceLabel: string,
    ctx: ExtensionContext,
    opts?: {
      title?: string;
      orientation?: LayoutOrientation;
      zoom?: ZoomLevel;
      dock?: DockPreference;
      widthPercent?: number;
      preserveScroll?: boolean;
      focus?: boolean;
      filePath?: string | null;
    },
  ): BpmnModel => {
    activeCtx = ctx;
    const model = parseBpmnXml(xml, opts?.title || sourceLabel || "BPMN Diagram");
    if (opts?.title) model.title = opts.title;
    currentSourceLabel = sourceLabel;
    if (opts?.filePath !== undefined) {
      currentFilePath = opts.filePath;
      if (currentFilePath) startWatching(currentFilePath);
      else stopWatching();
    }
    if (opts?.widthPercent !== undefined) {
      manager.setSizePercent(opts.widthPercent);
    }
    if (ctx.mode === "tui") {
      manager.showModel(model, sourceLabel, {
        orientation: opts?.orientation,
        zoom: opts?.zoom,
        dock: opts?.dock,
        preserveScroll: opts?.preserveScroll,
        focus: opts?.focus,
      });
    }
    return model;
  };

  const loadFile = (
    inputPath: string,
    ctx: ExtensionContext,
    opts?: {
      title?: string;
      orientation?: LayoutOrientation;
      zoom?: ZoomLevel;
      dock?: DockPreference;
      widthPercent?: number;
      preserveScroll?: boolean;
      focus?: boolean;
      notify?: boolean;
    },
  ): { model?: BpmnModel; error?: string } => {
    const resolved = isAbsolute(inputPath) ? inputPath : resolve(ctx.cwd, inputPath);
    if (!existsSync(resolved)) {
      const error = `BPMN file not found: ${resolved}`;
      if (opts?.notify && ctx.mode === "tui") ctx.ui.notify(error, "error");
      return { error };
    }
    try {
      const st = statSync(resolved);
      if (!st.isFile()) {
        const error = `Not a file: ${resolved}`;
        if (opts?.notify && ctx.mode === "tui") ctx.ui.notify(error, "error");
        return { error };
      }
      const xml = readFileSync(resolved, "utf8");
      const rel = relative(ctx.cwd, resolved);
      const label = rel && !rel.startsWith("..") ? rel : basename(resolved);
      const model = loadXml(xml, label, ctx, {
        ...opts,
        title: opts?.title,
        filePath: resolved,
      });
      if (opts?.notify && ctx.mode === "tui") {
        const warnCount = model.diagnostics.length;
        const msg =
          warnCount > 0
            ? `Loaded ${label} (${model.nodes.length} nodes, ${warnCount} warning(s))`
            : `Loaded ${label} (${model.nodes.length} nodes)`;
        ctx.ui.notify(msg, warnCount > 0 ? "warning" : "info");
      }
      return { model };
    } catch (e) {
      const error = `Failed to read ${resolved}: ${String(e)}`;
      if (opts?.notify && ctx.mode === "tui") ctx.ui.notify(error, "error");
      return { error };
    }
  };

  const openModalView = async (ctx: ExtensionContext) => {
    const model = manager.getPane().getModel();
    if (!model) {
      ctx.ui.notify("No BPMN loaded yet. Run /bpmn <file.bpmn> or /bpmn demo first.", "warning");
      return;
    }
    await ctx.ui.custom<void>(
      (tui, _theme, _kb, done) => {
        const modalPane = new BpmnSidePaneComponent(
          () => Math.max(14, Math.floor(tui.terminal.rows * 0.9)),
          () => tui.requestRender(),
          {
            getTheme: () => ctx.ui.theme,
            getTerminalSize: () => ({ cols: tui.terminal.columns, rows: tui.terminal.rows }),
            getResolvedDock: () => "right",
            getDockPreference: () => "right",
            onSizeChange: () => {},
            onDockCycle: () => {},
            onClose: () => done(undefined),
            onUnfocus: () => done(undefined),
            onReload: () => {
              if (currentFilePath) {
                const res = loadFile(currentFilePath, ctx, { preserveScroll: true });
                if (res.model) modalPane.setModel(res.model, currentSourceLabel, { preserveScroll: true });
              }
            },
          },
        );
        modalPane.focused = true;
        modalPane.setOrientation(manager.getPane().getOrientation());
        modalPane.setZoom(manager.getPane().getZoom());
        modalPane.setModel(model, currentSourceLabel);
        return modalPane;
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "94%",
          maxHeight: "92%",
        },
      },
    );
  };

  // Lifecycle hooks
  pi.on("session_start", (_event, ctx) => {
    activeCtx = ctx;
    if (ctx.mode !== "tui") return;

    // Zero-height hook widget to obtain the active TUI renderer cleanly (including after mode switches)
    ctx.ui.setWidget(
      "bpmn-side-view.host",
      (tui, _theme) => {
        manager.attachTui(tui);
        return {
          invalidate() {},
          render: () => [],
        };
      },
      { placement: "belowEditor" },
    );

    unsubscribeInput?.();
    unsubscribeInput = ctx.ui.onTerminalInput((data) => {
      if (!manager.isOpen() || !manager.isFocused()) return undefined;
      const m = /^\x1b\[<0;(\d+);(\d+)M$/.exec(data);
      if (m) {
        const col0 = Number.parseInt(m[1]!, 10) - 1;
        const row0 = Number.parseInt(m[2]!, 10) - 1;
        if (!manager.isPointInPane(col0, row0)) {
          manager.unfocus();
        }
      }
      return undefined;
    });
  });

  pi.on("message_end", (event, ctx) => {
    if (!autoDetect || ctx.mode !== "tui") return;
    const msg = event.message as { role?: string } | undefined;
    if (msg?.role !== "assistant") return;
    const text = extractMessageText(msg);
    if (!text.includes("definitions")) return;
    const xml = extractBpmnFromMarkdown(text);
    if (!xml) return;
    loadXml(xml, "chat response", ctx, { filePath: null, focus: false });
  });

  pi.on("session_shutdown", () => {
    stopWatching();
    unsubscribeInput?.();
    unsubscribeInput = null;
    manager.dispose();
    activeCtx = null;
  });

  // Keyboard shortcut: Alt+G toggles focus on the right-side BPMN pane (or reopens last diagram)
  pi.registerShortcut("alt+g", {
    description: "Focus or unfocus BPMN right-side view",
    handler: async (ctx) => {
      activeCtx = ctx;
      if (ctx.mode !== "tui") return;
      if (manager.isOpen()) {
        if (manager.isFocused()) {
          manager.unfocus();
        } else {
          const focused = manager.focus();
          if (!focused) {
            ctx.ui.notify("Terminal too narrow for split view. Use /bpmn modal.", "warning");
          }
        }
        return;
      }
      const existing = manager.getPane().getModel();
      if (existing) {
        manager.showModel(existing, currentSourceLabel, { preserveScroll: true, focus: false });
        if (currentFilePath) startWatching(currentFilePath);
      } else {
        ctx.ui.notify("No BPMN loaded. Run /bpmn <file.bpmn> or /bpmn demo.", "info");
      }
    },
  });

  // Slash command: /bpmn
  pi.registerCommand("bpmn", {
    description: "Display and control BPMN 2.0 view (/bpmn <file|demo|dock|fit|zoom|layout|width|focus|modal|close>)",
    handler: async (args, ctx) => {
      activeCtx = ctx;
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/bpmn requires interactive TUI mode.", "error");
        return;
      }

      const trimmed = args.trim();
      const parts = trimmed ? trimmed.split(/\s+/) : [];
      const sub = (parts[0] ?? "").toLowerCase();

      if (!trimmed) {
        if (manager.isOpen()) {
          if (!manager.focus()) {
            await openModalView(ctx);
          }
          return;
        }
        const existing = manager.getPane().getModel();
        if (existing) {
          manager.showModel(existing, currentSourceLabel, { preserveScroll: true, focus: false });
          if (currentFilePath) startWatching(currentFilePath);
          return;
        }
        // Check recent session messages for BPMN XML
        const branch = ctx.sessionManager.getBranch();
        for (let i = branch.length - 1; i >= 0; i--) {
          const entry = branch[i];
          if (entry?.type === "message") {
            const xml = extractBpmnFromMarkdown(extractMessageText(entry.message));
            if (xml) {
              loadXml(xml, "session history", ctx, { filePath: null, focus: false });
              ctx.ui.notify("Loaded BPMN diagram from conversation.", "info");
              return;
            }
          }
        }
        // Otherwise check workspace .bpmn files
        const files = findBpmnFiles(ctx.cwd);
        if (files.length === 1) {
          loadFile(files[0]!, ctx, { notify: true });
          return;
        }
        if (files.length > 1) {
          const rels = files.map((f) => relative(ctx.cwd, f));
          const choice = await ctx.ui.select("Select a BPMN file", [...rels, "[Built-in Demo]"]);
          if (!choice) return;
          if (choice === "[Built-in Demo]") {
            loadXml(DEMO_BPMN_XML, "demo.bpmn", ctx, { filePath: null, focus: false });
            return;
          }
          loadFile(choice, ctx, { notify: true });
          return;
        }
        loadXml(DEMO_BPMN_XML, "demo.bpmn", ctx, { filePath: null, focus: false });
        ctx.ui.notify("Opened built-in BPMN demo. Use /bpmn <file.bpmn> to load your own.", "info");
        return;
      }

      if (sub === "close" || sub === "hide" || sub === "off") {
        stopWatching();
        manager.close();
        return;
      }

      if (sub === "demo") {
        loadXml(DEMO_BPMN_XML, "demo.bpmn", ctx, { filePath: null, focus: false });
        return;
      }

      if (sub === "focus") {
        if (!manager.isOpen()) {
          const existing = manager.getPane().getModel();
          if (!existing) {
            ctx.ui.notify("No BPMN loaded. Run /bpmn <file.bpmn> or /bpmn demo.", "warning");
            return;
          }
          manager.showModel(existing, currentSourceLabel, { preserveScroll: true, focus: true });
          return;
        }
        if (!manager.focus()) {
          await openModalView(ctx);
        }
        return;
      }

      if (sub === "modal") {
        await openModalView(ctx);
        return;
      }

      if (sub === "fit") {
        manager.setZoom("fit");
        return;
      }

      if (sub === "zoom") {
        const level = (parts[1] ?? "").toLowerCase();
        if (level !== "fit" && level !== "compact" && level !== "detail") {
          ctx.ui.notify("Usage: /bpmn zoom fit | compact | detail", "warning");
          return;
        }
        manager.setZoom(level);
        return;
      }

      if (sub === "layout") {
        const mode = (parts[1] ?? "").toLowerCase();
        if (mode !== "tb" && mode !== "lr") {
          ctx.ui.notify("Usage: /bpmn layout tb | lr", "warning");
          return;
        }
        manager.setOrientation(mode);
        return;
      }

      if (sub === "dock") {
        const pos = (parts[1] ?? "").toLowerCase();
        if (pos !== "auto" && pos !== "right" && pos !== "top" && pos !== "bottom") {
          ctx.ui.notify("Usage: /bpmn dock auto | right | top | bottom", "warning");
          return;
        }
        manager.setDockPreference(pos);
        return;
      }

      if (sub === "width" || sub === "size") {
        const val = Number.parseInt(parts[1] ?? "", 10);
        if (!Number.isFinite(val)) {
          ctx.ui.notify(`Usage: /bpmn size <${MIN_SIZE_PERCENT}-${MAX_SIZE_PERCENT}>`, "warning");
          return;
        }
        manager.setSizePercent(val);
        return;
      }

      if (sub === "auto") {
        const flag = (parts[1] ?? "").toLowerCase();
        if (flag === "on" || flag === "true") autoDetect = true;
        else if (flag === "off" || flag === "false") autoDetect = false;
        else autoDetect = !autoDetect;
        ctx.ui.notify(`BPMN auto-detect in replies: ${autoDetect ? "ON" : "OFF"}`, "info");
        return;
      }

      if (sub === "list") {
        const files = findBpmnFiles(ctx.cwd);
        if (files.length === 0) {
          ctx.ui.notify("No .bpmn files found in workspace. Try /bpmn demo.", "info");
          return;
        }
        const rels = files.map((f) => relative(ctx.cwd, f));
        const choice = await ctx.ui.select("Select a BPMN file", rels);
        if (choice) loadFile(choice, ctx, { notify: true });
        return;
      }

      // Treat entire trimmed argument as a file path (supports spaces in path)
      loadFile(trimmed, ctx, { notify: true });
    },
  });

  // Custom LLM tool: show_bpmn
  pi.registerTool({
    name: "show_bpmn",
    label: "Show BPMN Side View",
    description:
      "Display a BPMN 2.0 XML diagram in the right-side view panel inside Pi (or close it). Pass either a file `path` or inline `xml`.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Path to a .bpmn XML file (relative to workspace or absolute)." })),
      xml: Type.Optional(Type.String({ description: "Inline BPMN 2.0 XML content to render directly." })),
      title: Type.Optional(Type.String({ description: "Optional title override shown in the right-side view header." })),
      layout: Type.Optional(
        Type.Union([Type.Literal("tb"), Type.Literal("lr")], {
          description: "Diagram orientation: 'tb' (vertical swimlanes) or 'lr' (horizontal swimlanes).",
        }),
      ),
      zoom: Type.Optional(
        Type.Union([Type.Literal("fit"), Type.Literal("compact"), Type.Literal("detail")], {
          description: "Zoom/density: 'fit' (auto-fit full diagram, default), 'compact' (compact swimlanes), or 'detail' (full boxed swimlanes).",
        }),
      ),
      dock: Type.Optional(
        Type.Union([Type.Literal("auto"), Type.Literal("right"), Type.Literal("top"), Type.Literal("bottom")], {
          description: "Panel placement: 'auto' (right on landscape, top on portrait terminals), 'right', 'top', or 'bottom'.",
        }),
      ),
      widthPercent: Type.Optional(
        Type.Number({ description: "Panel size percentage (20-75; width in right dock, height in top/bottom dock)." }),
      ),
      close: Type.Optional(Type.Boolean({ description: "Set true to close the BPMN right-side view." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      activeCtx = ctx;
      if (params.close) {
        stopWatching();
        manager.close();
        return {
          content: [{ type: "text", text: "Closed the BPMN right-side view." }],
          details: { open: false },
        };
      }

      if (!params.path && !params.xml) {
        return {
          content: [{ type: "text", text: "Provide either `path` or `xml` (or set `close: true`)." }],
          isError: true,
          details: {},
        };
      }

      if (params.path) {
        const res = loadFile(params.path, ctx, {
          title: params.title,
          orientation: params.layout,
          zoom: params.zoom,
          dock: params.dock,
          widthPercent: params.widthPercent,
          focus: false,
          notify: false,
        });
        if (res.error || !res.model) {
          return {
            content: [{ type: "text", text: res.error ?? "Failed to load BPMN file." }],
            isError: true,
            details: {},
          };
        }
        return {
          content: [
            {
              type: "text",
              text: summarizeModel(
                res.model,
                currentSourceLabel,
                manager.getPane().getOrientation(),
                manager.isOpen(),
              ),
            },
          ],
          details: {
            open: manager.isOpen(),
            title: res.model.title,
            nodes: res.model.nodes.length,
            flows: res.model.flows.length,
            diagnostics: res.model.diagnostics,
          },
        };
      }

      const model = loadXml(params.xml!, params.title || "inline.bpmn", ctx, {
        title: params.title,
        orientation: params.layout,
        zoom: params.zoom,
        dock: params.dock,
        widthPercent: params.widthPercent,
        filePath: null,
        focus: false,
      });
      return {
        content: [
          {
            type: "text",
            text: summarizeModel(
              model,
              currentSourceLabel,
              manager.getPane().getOrientation(),
              manager.isOpen(),
            ),
          },
        ],
        details: {
          open: manager.isOpen(),
          title: model.title,
          nodes: model.nodes.length,
          flows: model.flows.length,
          diagnostics: model.diagnostics,
        },
      };
    },
  });
}

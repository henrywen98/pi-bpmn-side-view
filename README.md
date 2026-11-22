# pi-bpmn-side-view

Display interactive BPMN 2.0 diagrams in a resizable right-side panel inside Pi without leaving the terminal or blocking chat input.

## Features

- **True side-by-side split view** in Pi fullscreen mode (`tuiMode: "fullscreen"`): chat and editor stay on the left, BPMN renders on the right with zero overlap.
- **Auto-Fit full diagram (`FIT`, default)** + **3 zoom levels (`+` / `-` / `f`)**: adapts to your right-side pane dimensions so the whole BPMN flow (all lanes, branches, rework loops, message flows) fits on screen without scrolling; zoom in to `CMP` (compact swimlanes) or `DET` (full boxed swimlanes) anytime.
- **Auto landscape / portrait docking (`auto`, default)**: uses a **right-side split (`HStack`)** on landscape terminals and automatically switches to a **top-bottom split (`VStack`, BPMN full-width on top, chat on bottom)** on portrait/vertical monitors! Override anytime with `v`, clicking `[A:R]`/`[A:T]`, or `/bpmn dock auto|right|top|bottom`.
- **Drag-to-resize divider**: drag the vertical `│` border left/right (right dock) or the horizontal `─── drag to resize ───` border up/down (top/bottom dock) with your trackpad/mouse (`20%`–`75%`), or press `[` / `]` / `/bpmn size <20-75>` — and `FIT` reflows live!
- **Regular mode fallback**: right-anchored `nonCapturing` overlay so you can still type in the editor.
- **Native Unicode/ANSI renderer**: crisp CJK + English labels, pools, swimlanes, events, tasks, gateways, sequence flows, dashed message flows, rework loops, and annotations — works natively in tmux and over SSH.
- **Interactive controls**: `Alt+G` or click to focus the right pane, `+`/`-` to zoom, `f` to auto-fit, `o` to switch `TB` ↔ `LR`, `hjkl`/arrows or mouse wheel to pan, `Tab`/`Shift+Tab` or click to inspect nodes, `i` for model summary inspector, `Esc` to return focus to chat, `q` to close.
- **Live file watching & auto-detect**: watches opened `.bpmn` files on disk for automatic reload, detects fenced ```bpmn``` blocks in assistant replies, and registers a `show_bpmn` tool for the agent.

## Commands

- `/bpmn <file.bpmn>` — Open and live-watch a BPMN 2.0 XML file in the right side view.
- `/bpmn demo` — Open the built-in purchase approval BPMN 2.0 demo.
- `/bpmn fit` — Switch to auto-fit full-diagram mode.
- `/bpmn zoom fit|compact|detail` — Choose zoom/density level.
- `/bpmn layout tb|lr` — Switch between vertical (`tb`) and horizontal (`lr`) swimlanes.
- `/bpmn dock auto|right|top|bottom` — Set panel placement (`auto` switches right ↔ top for landscape vs portrait terminals).
- `/bpmn size <20-75>` (or `/bpmn width <20-75>`) — Set panel size percentage (or drag the divider border).
- `/bpmn list` — Pick a `.bpmn` file from the current workspace.
- `/bpmn focus` — Focus the right pane for keyboard navigation (or press `Alt+G`).
- `/bpmn modal` — Open the diagram in a full-screen overlay (useful on terminals narrower than 72 cols).
- `/bpmn auto on|off` — Toggle auto-display for fenced BPMN blocks in assistant replies.
- `/bpmn close` — Close the side view.

## Testing

```bash
npm run typecheck
npm test
/usr/bin/python3 test/tui-e2e.py --out evidence
```

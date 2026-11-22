# Changelog

All notable changes to `pi-bpmn-side-view` are documented in this file.

## [0.1.0] - 2026-11-23

### Added
- True side-by-side split view in Pi fullscreen mode (`HStack`) and automatic top-bottom split (`VStack`) on portrait terminals, with non-capturing right-overlay fallback in regular mode.
- Zero-dependency BPMN 2.0 XML parser supporting pools, swimlanes, start/intermediate/boundary/end events with markers, activities, gateways, sequence flows, dashed message flows, rework loops, and annotations.
- Native Unicode/ANSI terminal renderer with full CJK double-width alignment (works in tmux and over SSH without terminal image protocols).
- Three zoom/density levels: `FIT` (auto-fit full diagram, default), `CMP` (compact swimlanes), and `DET` (full boxed swimlanes), plus `TB` / `LR` orientation switching.
- Trackpad and mouse support: drag the divider border to resize (20%–75%), grab-and-drag 2D canvas panning, vertical and horizontal (SGR 66/67) scroll, and click-to-inspect nodes.
- Slash commands (`/bpmn`), `Alt+G` focus toggle, live file watcher, auto-detection of fenced ```bpmn``` replies, and `show_bpmn` LLM tool.

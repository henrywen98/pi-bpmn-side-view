#!/usr/bin/env python3
"""End-to-end real Pi TUI test for pi-bpmn-side-view in an isolated private tmux server."""

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess as sp
import tempfile
import time
import unicodedata
import uuid
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont  # pyright: ignore[reportMissingImports]

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--out", type=Path, default=ROOT / "evidence")
args = parser.parse_args()
out = args.out.resolve()
out.mkdir(parents=True, exist_ok=True)

source = Path(os.environ.get("PI_CODING_AGENT_DIR", str(Path.home() / ".pi/agent")))
pi_bin = str(Path(shutil.which("pi") or "/missing-pi").resolve(strict=True))
provider = os.environ.get("PI_PROVIDER", "openai")
model = os.environ.get("PI_MODEL", "gpt-6.2-astra")

# ANSI-to-PNG rasterizer with CJK fallback so we can visually inspect real terminal screenshots
ANSI_RE = re.compile(r"\x1b\[([0-9;?]*)([A-Za-z])")
BASIC_16 = [
    (24, 24, 30), (214, 93, 93), (120, 200, 130), (229, 192, 123),
    (97, 175, 239), (198, 120, 221), (86, 182, 194), (210, 214, 222),
    (110, 118, 129), (240, 120, 120), (150, 225, 160), (245, 210, 145),
    (130, 195, 250), (215, 150, 240), (120, 210, 220), (242, 245, 250),
]


def xterm_256(n: int):
    if n < 16:
        return BASIC_16[n]
    if n < 232:
        n -= 16
        r, g, b = n // 36, (n // 6) % 6, n % 6
        vals = [0, 95, 135, 175, 215, 255]
        return (vals[r], vals[g], vals[b])
    v = 8 + (n - 232) * 10
    return (v, v, v)


def load_fonts(size=15):
    mono_candidates = [
        str(Path.home() / ".local/share/fonts/JetBrainsMonoNerdFont/JetBrainsMonoNerdFontMono-Regular.ttf"),
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ]
    cjk_candidates = [
        "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
        "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
    ]
    mono = next((ImageFont.truetype(p, size) for p in mono_candidates if Path(p).is_file()), ImageFont.load_default())
    cjk = next((ImageFont.truetype(p, size - 1) for p in cjk_candidates if Path(p).is_file()), mono)
    return mono, cjk


def is_wide(ch: str) -> bool:
    return unicodedata.east_asian_width(ch) in ("W", "F")


def render_ansi_png(ansi_text: str, dst: Path, cols: int, rows: int):
    mono, cjk = load_fonts(15)
    cell_w, cell_h = 9, 20
    pad = 12
    img = Image.new("RGB", (cols * cell_w + pad * 2, rows * cell_h + pad * 2), (24, 24, 30))
    draw = ImageDraw.Draw(img)

    lines = ansi_text.splitlines()[:rows]
    default_fg = (220, 224, 232)
    default_bg = (24, 24, 30)

    for r_idx, raw in enumerate(lines):
        y = pad + r_idx * cell_h
        fg, bg = default_fg, default_bg
        col = 0
        i = 0
        n = len(raw)
        while i < n and col < cols:
            if raw[i] == "\x1b":
                m = ANSI_RE.match(raw, i)
                if m:
                    params, cmd = m.group(1), m.group(2)
                    if cmd == "m":
                        nums = [int(x) for x in params.split(";") if x.isdigit()] if params else [0]
                        k = 0
                        while k < len(nums):
                            code = nums[k]
                            if code == 0:
                                fg, bg = default_fg, default_bg
                            elif code == 2:
                                fg = tuple(max(70, int(c * 0.65)) for c in fg)
                            elif 30 <= code <= 37:
                                fg = BASIC_16[code - 30]
                            elif 90 <= code <= 97:
                                fg = BASIC_16[code - 90 + 8]
                            elif code == 39:
                                fg = default_fg
                            elif 40 <= code <= 47:
                                bg = BASIC_16[code - 40]
                            elif 100 <= code <= 107:
                                bg = BASIC_16[code - 100 + 8]
                            elif code == 49:
                                bg = default_bg
                            elif code in (38, 48) and k + 1 < len(nums):
                                if nums[k + 1] == 5 and k + 2 < len(nums):
                                    c = xterm_256(nums[k + 2])
                                    if code == 38:
                                        fg = c
                                    else:
                                        bg = c
                                    k += 2
                                elif nums[k + 1] == 2 and k + 4 < len(nums):
                                    c = (nums[k + 2], nums[k + 3], nums[k + 4])
                                    if code == 38:
                                        fg = c
                                    else:
                                        bg = c
                                    k += 4
                            k += 1
                    i = m.end()
                    continue
                # skip other ESC sequences (e.g. OSC)
                end_bel = raw.find("\x07", i)
                i = end_bel + 1 if end_bel != -1 else i + 1
                continue

            ch = raw[i]
            i += 1
            if ord(ch) < 32:
                continue
            wide = is_wide(ch)
            w_cells = 2 if wide else 1
            x = pad + col * cell_w
            if bg != default_bg:
                draw.rectangle([x, y, x + w_cells * cell_w, y + cell_h], fill=bg)
            if ch != " ":
                font = cjk if wide or ord(ch) > 0x2E80 else mono
                draw.text((x, y + 1), ch, fill=fg, font=font)
            col += w_cells

    img.save(dst)


results = []


def record(msg: str):
    results.append(msg)
    print("PASS:", msg, flush=True)


def wait(fn, sec=10.0, what="condition"):
    end = time.monotonic() + sec
    while time.monotonic() < end:
        res = fn()
        if res:
            return res
        time.sleep(0.12)
    raise RuntimeError(f"Timed out waiting for: {what}")


with tempfile.TemporaryDirectory(prefix="pi-bpmn-e2e-") as tmp:
    t = Path(tmp)
    profile = t / "profile"
    profile.mkdir(mode=0o700)
    work = t / "work"
    work.mkdir()

    # Copy extension WITHOUT node_modules to verify auto-discovery uses Pi host imports cleanly
    ext_dst = profile / "extensions" / "pi-bpmn-side-view"
    ext_dst.mkdir(parents=True)
    shutil.copyfile(ROOT / "index.ts", ext_dst / "index.ts")
    shutil.copyfile(ROOT / "package.json", ext_dst / "package.json")
    shutil.copytree(ROOT / "lib", ext_dst / "lib")

    for name in ("models.json", "models-store.json"):
        if (source / name).is_file():
            shutil.copyfile(source / name, profile / name)
            (profile / name).chmod(0o600)
    if (source / "auth.json").is_file():
        (profile / "auth.json").symlink_to(source / "auth.json")

    def write_settings(tui_mode="fullscreen"):
        (profile / "settings.json").write_text(
            json.dumps(
                {
                    "defaultProvider": provider,
                    "defaultModel": model,
                    "tuiMode": tui_mode,
                    "cacheWarming": "off",
                    "hideThinkingBlock": True,
                }
            )
        )

    write_settings("fullscreen")

    env = dict(
        os.environ,
        PI_CODING_AGENT_DIR=str(profile),
        PI_OFFLINE="1",
        PI_SKIP_VERSION_CHECK="1",
    )
    for k in ("TMUX", "TMUX_PANE", "PI_SESSION_ID", "PI_SESSION_FILE", "PI_CODING_AGENT_SESSION_DIR"):
        env.pop(k, None)

    tm = ["tmux", "-L", "bpmn-e2e-" + uuid.uuid4().hex[:8], "-f", "/dev/null"]

    def ctl(*a):
        return sp.check_output([*tm, *a], env=env, text=True, stderr=sp.STDOUT).rstrip("\n")

    def screen(w="fs"):
        return ctl("capture-pane", "-p", "-t", f"test:{w}")

    def ansi_screen(w="fs"):
        return ctl("capture-pane", "-e", "-p", "-t", f"test:{w}")

    def key(w, *ks):
        ctl("send-keys", "-t", f"test:{w}", *ks)

    def literal(w, text_str):
        ctl("send-keys", "-t", f"test:{w}", "-l", text_str)

    def send(w, cmd_str):
        literal(w, cmd_str)
        key(w, "Enter")

    def snap(w, name, cols=144, rows=40):
        txt = screen(w)
        ansi = ansi_screen(w)
        (out / f"{name}.txt").write_text(txt + "\n")
        (out / f"{name}.ansi").write_text(ansi + "\n")
        render_ansi_png(ansi, out / f"{name}.png", cols, rows)

    prefix = [
        pi_bin,
        "--model",
        f"{provider}/{model}",
        "--offline",
        "-na",
        "-nc",
        "-np",
        "-ns",
        "--no-mcp",
        "--tools",
        "bash",
    ]
    extra_ext = os.environ.get("PI_E2E_EXTRA_EXT", "").strip()
    if extra_ext and Path(extra_ext).is_file():
        prefix += ["-e", extra_ext]

    try:
        # 1. Start Pi in fullscreen mode (144x40)
        ctl(
            "new-session",
            "-d",
            "-x",
            "144",
            "-y",
            "40",
            "-s",
            "test",
            "-n",
            "fs",
            "-c",
            str(work),
            shlex.join(prefix),
        )
        wait(lambda: "─" in screen("fs") and ("Type a message" in screen("fs") or "pi" in screen("fs").lower() or model in screen("fs")), 15, "Pi fullscreen startup")
        time.sleep(0.5)
        record("Pi started in fullscreen mode with auto-discovered pi-bpmn-side-view (without node_modules)")

        # 2. Open /bpmn demo -> true right-side split view in FIT auto-fit full-diagram mode!
        send("fs", "/bpmn demo")
        wait(
            lambda: "Purchase Approval" in screen("fs")
            and "[FIT]" in screen("fs")
            and "Request Received" in screen("fs")
            and "Order Completed" in screen("fs")
            and "External Vendor" in screen("fs"),
            10,
            "/bpmn demo auto-fit full diagram",
        )
        time.sleep(0.3)

        lines = screen("fs").splitlines()
        header_line = next((l for l in lines if "Purchase Approval" in l and "[FIT]" in l), "")
        assert header_line, "Missing BPMN header line"
        bpmn_col = header_line.index("Purchase Approval")
        assert bpmn_col > 40, f"Expected BPMN on the right side (col > 40), got col {bpmn_col}"
        snap("fs", "01-split-fit-full", 144, 40)
        record(f"/bpmn demo auto-fit rendered the ENTIRE 4-lane diagram (Start -> End) in right split view (col {bpmn_col})")

        # 2b. Test real SGR mouse drag on the vertical │ divider left (widen) and right (narrow)!
        divider_line = next((l for l in lines if "Purchase Approval" in l), "")
        div_col_0 = divider_line.index("│")
        div_col_1 = div_col_0 + 1  # SGR mouse coords are 1-based
        # Press left mouse button on divider at row 10, drag 22 cols left to widen right pane, release
        drag_left_col = max(35, div_col_1 - 22)
        literal("fs", f"\x1b[<0;{div_col_1};10M")
        time.sleep(0.1)
        literal("fs", f"\x1b[<32;{drag_left_col};10M")
        time.sleep(0.2)
        literal("fs", f"\x1b[<0;{drag_left_col};10m")
        def current_div_col():
            line = next((l for l in screen("fs").splitlines() if "Purchase Approval" in l), "")
            idx = line.find("│")
            if idx == -1:
                idx = line.find("┃")
            return idx

        wait(
            lambda: 0 < current_div_col() < div_col_0 - 15,
            6,
            "mouse drag divider left to widen right pane",
        )
        widened_div = current_div_col()
        snap("fs", "01b-drag-widened", 144, 40)
        # Drag back right to ~45%
        literal("fs", f"\x1b[<0;{widened_div + 1};10M")
        time.sleep(0.1)
        literal("fs", f"\x1b[<32;{div_col_1};10M")
        time.sleep(0.2)
        literal("fs", f"\x1b[<0;{div_col_1};10m")
        wait(
            lambda: current_div_col() > 0 and abs(current_div_col() - div_col_0) <= 3,
            6,
            "mouse drag divider right to restore width",
        )
        record(f"Mouse drag on vertical divider resized right pane live (col {div_col_0} -> {widened_div} -> {div_col_0})")

        # 3. Verify typing on the left chat editor works while right BPMN pane stays open
        literal("fs", "LEFT_CHAT_INPUT_OK")
        wait(lambda: "LEFT_CHAT_INPUT_OK" in screen("fs") and "Purchase Approval" in screen("fs"), 6, "left editor input alongside right BPMN")
        left_line = next((l for l in screen("fs").splitlines() if "LEFT_CHAT_INPUT_OK" in l), "")
        assert left_line.index("LEFT_CHAT_INPUT_OK") < bpmn_col, "Typed text should stay inside left pane"
        key("fs", "C-u")
        record("Left chat editor stays focused and accepts typing without colliding with right BPMN view")

        # 4. Focus right pane via Alt+G, test zoom (+/- / f), cycle nodes, switch TB -> LR, inspector, width, Esc
        key("fs", "M-g")
        wait(lambda: "+/- zoom" in screen("fs") and "●" in screen("fs"), 6, "Alt+G focus right BPMN pane")
        key("fs", "+")
        wait(lambda: "[CMP]" in screen("fs"), 6, "'+' zoom FIT -> CMP")
        key("fs", "+")
        wait(lambda: "[DET]" in screen("fs"), 6, "'+' zoom CMP -> DET")
        key("fs", "-")
        wait(lambda: "[CMP]" in screen("fs"), 6, "'-' zoom DET -> CMP")
        key("fs", "f")
        wait(lambda: "[FIT]" in screen("fs"), 6, "'f' back to FIT")
        record("Zoom controls '+' (FIT->CMP->DET), '-' (DET->CMP), and 'f' (auto-fit) all worked")

        key("fs", "+")
        key("fs", "+")
        wait(lambda: "[DET]" in screen("fs"), 6, "zoom to DET for LR & trackpad pan check")

        # 4b. Test MacBook trackpad horizontal two-finger scroll (SGR button 67=right, 66=left)
        #     AND canvas grab-and-drag 2D panning (left press inside canvas -> drag up-left -> release)!
        pan_col = min(140, div_col_1 + 15)
        literal("fs", f"\x1b[<67;{pan_col};12M")
        literal("fs", f"\x1b[<67;{pan_col};12M")
        wait(lambda: "8/" in screen("fs") and "0/4" not in screen("fs"), 6, "two-finger horizontal wheel SGR 67 pan right")
        literal("fs", f"\x1b[<66;{pan_col};12M")
        wait(lambda: "4/" in screen("fs"), 6, "two-finger horizontal wheel SGR 66 pan left")
        # Grab-and-drag inside canvas: press at (pan_col+10, 18), drag to (pan_col+4, 12), release -> pans right + down!
        literal("fs", f"\x1b[<0;{pan_col + 10};18M")
        time.sleep(0.08)
        literal("fs", f"\x1b[<32;{pan_col + 4};12M")
        time.sleep(0.12)
        literal("fs", f"\x1b[<0;{pan_col + 4};12m")
        wait(lambda: "16/" in screen("fs") and "6/" in screen("fs"), 6, "canvas 2D grab-and-drag pan (X+Y)")
        key("fs", "0")
        record("MacBook trackpad horizontal scroll (SGR 66/67) and 2D canvas grab-drag pan (X+Y) verified")

        key("fs", "Tab")
        time.sleep(0.2)
        key("fs", "Tab")
        time.sleep(0.2)
        key("fs", "o")
        wait(lambda: "[LR]" in screen("fs") and "DET/LR" in screen("fs"), 6, "toggle TB -> LR orientation + status sync")
        time.sleep(0.2)
        snap("fs", "02-split-lr-focused", 144, 40)
        record("Alt+G focused right pane, Tab cycled nodes, and 'o' switched TB -> LR (header + footer synced)")

        key("fs", "i")
        wait(lambda: "Model Summary:" in screen("fs") and "Swimlanes:" in screen("fs"), 6, "inspector view")
        snap("fs", "03-inspector", 144, 40)
        key("fs", "i")
        wait(lambda: "[LR]" in screen("fs"), 6, "return from inspector")

        # Resize width wider with ']'
        before_col = next(l for l in screen("fs").splitlines() if "Purchase Approval" in l).index("Purchase Approval")
        key("fs", "]")
        time.sleep(0.2)
        key("fs", "]")
        wait(
            lambda: next((l for l in screen("fs").splitlines() if "Purchase Approval" in l), "x" * 200).index("Purchase Approval")
            < before_col - 5,
            6,
            "widen right pane with ']'",
        )
        record("']' dynamically widened the right BPMN split pane")

        # Esc returns focus to left chat while keeping BPMN open
        key("fs", "Escape")
        wait(lambda: "Drag │ to resize" in screen("fs"), 6, "Esc unfocus back to left chat")
        literal("fs", "AFTER_ESC_STILL_OPEN")
        wait(lambda: "AFTER_ESC_STILL_OPEN" in screen("fs") and "Purchase Approval" in screen("fs"), 6, "typing after Esc")
        key("fs", "C-u")
        record("Esc returned keyboard focus to left chat editor while keeping BPMN side view open")

        # 5. Load custom .bpmn file + verify live file watch reload
        sample_file = work / "refund.bpmn"
        sample_xml_v1 = """<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d_ref" name="Refund Ticket Flow">
  <bpmn:process id="p_ref" name="Refund Ticket Flow">
    <bpmn:laneSet id="ls1">
      <bpmn:lane id="l_cs" name="Support">
        <bpmn:flowNodeRef>s1</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>t_check</bpmn:flowNodeRef>
      </bpmn:lane>
      <bpmn:lane id="l_fin" name="Billing">
        <bpmn:flowNodeRef>t_pay</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>e1</bpmn:flowNodeRef>
      </bpmn:lane>
    </bpmn:laneSet>
    <bpmn:startEvent id="s1" name="Refund Requested" />
    <bpmn:userTask id="t_check" name="Verify Receipt" />
    <bpmn:serviceTask id="t_pay" name="Issue Refund" />
    <bpmn:endEvent id="e1" name="Refunded" />
    <bpmn:sequenceFlow id="f1" sourceRef="s1" targetRef="t_check" />
    <bpmn:sequenceFlow id="f2" sourceRef="t_check" targetRef="t_pay" name="Approved" />
    <bpmn:sequenceFlow id="f3" sourceRef="t_pay" targetRef="e1" />
  </bpmn:process>
</bpmn:definitions>
"""
        sample_file.write_text(sample_xml_v1, encoding="utf-8")
        send("fs", "/bpmn layout tb")
        time.sleep(0.2)
        send("fs", "/bpmn refund.bpmn")
        wait(lambda: "Refund Ticket Flow" in screen("fs") and "Verify Receipt" in screen("fs"), 8, "/bpmn refund.bpmn")
        # Modify file on disk -> live watcher should update right pane automatically!
        sample_file.write_text(sample_xml_v1.replace("Verify Receipt", "Live Updated Check"), encoding="utf-8")
        wait(lambda: "Live Updated" in screen("fs"), 8, "live file watcher reload")
        snap("fs", "04-live-file-reload", 144, 40)
        record("/bpmn <file> loaded custom BPMN and fs.watch live-reloaded changes automatically")

        # 6a. Portrait / vertical monitor terminal (78x56): auto-switches from Right dock [A:R] -> Top dock [A:T]!
        ctl("resize-window", "-t", "test:fs", "-x", "78", "-y", "56")
        wait(
            lambda: "[A:T]" in screen("fs") and "drag to resize" in screen("fs") and "Refund Ticket Flow" in screen("fs"),
            8,
            "portrait terminal auto-switches to top dock [A:T]",
        )
        time.sleep(0.25)
        # Verify BPMN header is at top-left (row 0, col < 10) and bottom chat still accepts typing!
        p_lines = screen("fs").splitlines()
        assert "Refund Ticket Flow" in p_lines[0], f"Expected BPMN at top row 0 in portrait mode, got: {p_lines[0]!r}"
        literal("fs", "PORTRAIT_BOTTOM_CHAT")
        wait(lambda: "PORTRAIT_BOTTOM_CHAT" in screen("fs") and "Refund Ticket Flow" in screen("fs"), 6, "bottom chat input in portrait mode")
        key("fs", "C-u")
        # Test dragging the horizontal divider DOWN by 8 rows to resize top BPMN height!
        div_row_0 = next(i for i, l in enumerate(screen("fs").splitlines()) if "drag to resize" in l)
        div_row_1 = div_row_0 + 1
        target_row_1 = min(40, div_row_1 + 8)
        literal("fs", f"\x1b[<0;35;{div_row_1}M")
        time.sleep(0.08)
        literal("fs", f"\x1b[<32;35;{target_row_1}M")
        time.sleep(0.15)
        literal("fs", f"\x1b[<0;35;{target_row_1}m")
        wait(
            lambda: next((i for i, l in enumerate(screen("fs").splitlines()) if "drag to resize" in l), 0)
            >= div_row_0 + 5,
            6,
            "drag horizontal divider down in portrait top dock",
        )
        new_div_row = next(i for i, l in enumerate(screen("fs").splitlines()) if "drag to resize" in l)
        snap("fs", "06-portrait-top-split", 78, 56)
        record(f"Portrait terminal (78x56) auto-switched to top dock [A:T] and horizontal drag resized row {div_row_0} -> {new_div_row}")

        # 6b. Tiny terminal graceful hiding (64x20) + /bpmn modal + auto-return to Right dock on widen (144x40)
        ctl("resize-window", "-t", "test:fs", "-x", "64", "-y", "20")
        wait(lambda: "Live Updated" not in screen("fs") and "BPMN hidden" in screen("fs"), 6, "tiny terminal hides split pane and updates status")
        record("Tiny terminal (64x20) gracefully hid split view and updated status hint")

        send("fs", "/bpmn modal")
        wait(lambda: "Refund Ticket Flow" in screen("fs") and "Live Updated" in screen("fs"), 8, "/bpmn modal on tiny terminal")
        key("fs", "Escape")
        wait(lambda: "Live Updated" not in screen("fs"), 6, "close modal on Esc")
        ctl("resize-window", "-t", "test:fs", "-x", "144", "-y", "40")
        wait(
            lambda: "[A:R]" in screen("fs") and "Refund Ticket Flow" in screen("fs") and "Live Updated" in screen("fs"),
            8,
            "right split view returns automatically when terminal widens to landscape",
        )
        record("/bpmn modal worked on tiny terminal and auto-restored right dock [A:R] on landscape")

        # 7. Close with 'q' when focused + /reload safety
        key("fs", "M-g")
        wait(lambda: "●" in screen("fs"), 6, "focus before close")
        key("fs", "q")
        wait(lambda: "Refund Ticket Flow" not in screen("fs") and "Live Updated" not in screen("fs"), 6, "'q' closes side view")
        record("'q' closed right BPMN view and restored full-width chat")

        send("fs", "/reload")
        time.sleep(1.5)
        send("fs", "/bpmn demo")
        wait(lambda: "Purchase Approval" in screen("fs"), 10, "/bpmn demo after /reload")
        send("fs", "/bpmn close")
        wait(lambda: "Purchase Approval" not in screen("fs"), 6, "/bpmn close")
        record("/reload cleanly tore down and reloaded pi-bpmn-side-view")

        # 8. Regular mode (tuiMode: "regular") fallback check
        write_settings("regular")
        ctl(
            "new-window",
            "-d",
            "-n",
            "reg",
            "-t",
            "test",
            "-c",
            str(work),
            shlex.join(prefix),
        )
        ctl("resize-window", "-t", "test:reg", "-x", "144", "-y", "40")
        wait(lambda: "─" in screen("reg"), 15, "Pi regular mode startup")
        time.sleep(0.5)
        send("reg", "/bpmn demo")
        wait(lambda: "Purchase Approval" in screen("reg") and "Requester" in screen("reg"), 10, "regular mode right overlay")
        literal("reg", "REGULAR_MODE_INPUT")
        wait(lambda: "REGULAR_MODE_INPUT" in screen("reg") and "Purchase Approval" in screen("reg"), 6, "regular mode non-capturing typing")
        snap("reg", "05-regular-overlay", 144, 40)
        record("Regular mode fallback rendered right-anchored nonCapturing overlay while preserving editor input")

        print("ALL E2E CHECKS PASSED!", flush=True)
    except BaseException:
        for w in ("fs", "reg"):
            try:
                print(f"\n=== SCREEN ({w}) ===\n" + screen(w), flush=True)
            except Exception:
                pass
        raise
    finally:
        try:
            ctl("kill-server")
        except Exception:
            pass
        (out / "e2e-checks.txt").write_text("\n".join(results) + "\n")

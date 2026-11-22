import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { layoutAndRenderBpmn } from "../lib/bpmn-layout.ts";
import { DEMO_BPMN_XML, parseBpmnXml } from "../lib/bpmn-parser.ts";
import { resolveDock } from "../lib/side-view.ts";

describe("layoutAndRenderBpmn", () => {
  const demoModel = parseBpmnXml(DEMO_BPMN_XML);

  it("auto-fits the entire 4-lane demo BPMN within a 60x32 side pane with zero horizontal overflow", () => {
    const rendered = layoutAndRenderBpmn(demoModel, {
      orientation: "tb",
      zoom: "fit",
      availableWidth: 60,
      availableHeight: 32,
      selectedNodeId: "GW_Approve",
    });
    assert.equal(rendered.hitRects.length, demoModel.nodes.length);
    assert.ok(rendered.width <= 60, `Expected width <= 60, got ${rendered.width}`);
    assert.ok(rendered.height <= 32, `Expected height <= 32, got ${rendered.height}`);
    const lines = rendered.canvas.renderPlainSlice(0, 0, 60, rendered.height);
    const joined = lines.join("\n");
    assert.ok(joined.includes("Request Received"));
    assert.ok(joined.includes("Order Completed"));
    assert.ok(joined.includes("Approved?"));
    assert.ok(joined.includes("External Vendor"));
    assert.ok(joined.includes("«"));
  });

  for (const orientation of ["tb", "lr"] as const) {
    it(`renders demo BPMN cleanly in ${orientation.toUpperCase()} detail mode without overlapping nodes`, () => {
      const rendered = layoutAndRenderBpmn(demoModel, {
        orientation,
        zoom: "detail",
        selectedNodeId: "GW_Approve",
      });

      assert.equal(rendered.hitRects.length, demoModel.nodes.length);
      assert.ok(rendered.width > 30);
      assert.ok(rendered.height > 10);

      // Verify zero pairwise overlap between rendered node hit rectangles
      for (let i = 0; i < rendered.hitRects.length; i++) {
        const a = rendered.hitRects[i]!;
        for (let j = i + 1; j < rendered.hitRects.length; j++) {
          const b = rendered.hitRects[j]!;
          const overlapX = a.x < b.x + b.width && a.x + a.width > b.x;
          const overlapY = a.y < b.y + b.height && a.y + a.height > b.y;
          assert.equal(
            overlapX && overlapY,
            false,
            `Nodes ${a.nodeId} and ${b.nodeId} overlap in ${orientation}`,
          );
        }
      }

      // Check key labels & swimlanes appear in rendered output
      const fullLines = rendered.canvas.renderPlainSlice(0, 0, rendered.width, rendered.height);
      const joined = fullLines.join("\n");
      assert.ok(joined.includes("Requester"));
      assert.ok(joined.includes("Manager"));
      assert.ok(joined.includes("Finance"));
      assert.ok(joined.includes("External Vendor"));
      assert.ok(joined.includes("Approved?"));
      assert.ok(joined.includes("◇×"));
      assert.ok(joined.includes("◇+"));
      assert.ok(joined.includes("«")); // rework back-edge marker
    });

    it(`guarantees exact viewport width across CJK boundaries when scrolled in ${orientation.toUpperCase()}`, () => {
      const rendered = layoutAndRenderBpmn(demoModel, { orientation, zoom: "detail" });
      for (const viewW of [30, 41, 55, 80]) {
        for (const scrollX of [0, 1, 2, 7, 15, 31]) {
          const lines = rendered.canvas.renderPlainSlice(scrollX, 0, viewW, 20);
          assert.equal(lines.length, 20);
          for (const line of lines) {
            const w = visibleWidth(line);
            assert.ok(
              w <= viewW,
              `Line overflowed viewW=${viewW} (got ${w}) at scrollX=${scrollX}: ${JSON.stringify(line)}`,
            );
          }
        }
      }
    });
  }

  it("handles cyclic BPMN processes without infinite loops", () => {
    const cyclic = parseBpmnXml(`<definitions>
      <process id="p">
        <startEvent id="s" name="Start"/>
        <task id="a" name="Step A"/>
        <task id="b" name="Step B"/>
        <sequenceFlow id="f1" sourceRef="s" targetRef="a"/>
        <sequenceFlow id="f2" sourceRef="a" targetRef="b"/>
        <sequenceFlow id="f3" sourceRef="b" targetRef="a" name="Retry"/>
      </process>
    </definitions>`);
    const rendered = layoutAndRenderBpmn(cyclic, { orientation: "tb" });
    assert.equal(rendered.hitRects.length, 3);
  });

  it("auto-selects right dock on landscape terminals and top dock on portrait terminals", () => {
    assert.equal(resolveDock("auto", 144, 40), "right");
    assert.equal(resolveDock("auto", 80, 60), "top");
    assert.equal(resolveDock("auto", 64, 42), "top");
    assert.equal(resolveDock("auto", 64, 20), null);
    assert.equal(resolveDock("bottom", 144, 40), "bottom");
    assert.equal(resolveDock("top", 144, 40), "top");
  });
});

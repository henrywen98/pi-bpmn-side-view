import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEMO_BPMN_XML, extractBpmnFromMarkdown, parseBpmnXml } from "../lib/bpmn-parser.ts";

describe("parseBpmnXml", () => {
  it("parses pools, lanes, events, tasks, gateways, sequence flows, message flows, and annotations", () => {
    const model = parseBpmnXml(DEMO_BPMN_XML);
    assert.equal(model.diagnostics.length, 0);
    assert.equal(model.title, "Purchase Approval");
    assert.equal(model.pools.length, 2);
    assert.equal(model.lanes.length, 3);
    assert.ok(model.nodes.length >= 13); // 12 internal + 1 black-box vendor pool

    const start = model.nodes.find((n) => n.id === "Start_1");
    assert.equal(start?.kind, "startEvent");
    assert.equal(start?.laneId, "Lane_Requester");
    assert.equal(start?.documentation, "A department submits a new equipment or service purchase request.");

    const waitEvent = model.nodes.find((n) => n.id === "Event_WaitShip");
    assert.equal(waitEvent?.kind, "intermediateCatchEvent");
    assert.equal(waitEvent?.eventMarker, "timer");

    const endCancelled = model.nodes.find((n) => n.id === "End_Cancelled");
    assert.equal(endCancelled?.eventMarker, "terminate");

    const rejectFlow = model.flows.find((f) => f.id === "Flow_Reject");
    assert.equal(rejectFlow?.isDefault, true);
    assert.equal(rejectFlow?.name, "Reject");

    const msgFlows = model.flows.filter((f) => f.kind === "messageFlow");
    assert.equal(msgFlows.length, 2);

    assert.equal(model.annotations.length, 1);
    assert.deepEqual(model.annotations[0]?.targetIds, ["Task_Budget"]);
  });

  it("handles unprefixed BPMN XML, entities, CDATA, and boundary events", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <definitions id="d1" name="Order &amp; Pay">
      <process id="p1">
        <startEvent id="s1" name="Start" />
        <userTask id="t1" name="Check &lt;Order&gt;">
          <documentation><![CDATA[Must finish < 24h]]></documentation>
        </userTask>
        <boundaryEvent id="b1" name="Timeout" attachedToRef="t1">
          <timerEventDefinition />
        </boundaryEvent>
        <endEvent id="e1" name="Done" />
        <sequenceFlow id="f1" sourceRef="s1" targetRef="t1" />
        <sequenceFlow id="f2" sourceRef="t1" targetRef="e1" />
        <sequenceFlow id="f3" sourceRef="b1" targetRef="e1" name="SLA Breached" />
      </process>
    </definitions>`;

    const model = parseBpmnXml(xml);
    assert.equal(model.diagnostics.length, 0);
    assert.equal(model.title, "Order & Pay");
    const task = model.nodes.find((n) => n.id === "t1");
    assert.equal(task?.name, "Check <Order>");
    assert.equal(task?.documentation, "Must finish < 24h");
    const boundary = model.nodes.find((n) => n.id === "b1");
    assert.equal(boundary?.attachedToRef, "t1");
    assert.equal(boundary?.eventMarker, "timer");
  });

  it("reports clear error diagnostics on malformed XML", () => {
    const model = parseBpmnXml("<definitions><process></definitions>");
    assert.equal(model.nodes.length, 0);
    assert.ok(model.diagnostics.some((d) => d.level === "error"));
  });

  it("extracts fenced BPMN XML from markdown", () => {
    const md = [
      "Here is the process:",
      "```bpmn",
      "<bpmn:definitions><bpmn:process id='p1'><bpmn:startEvent id='s1'/></bpmn:process></bpmn:definitions>",
      "```",
    ].join("\n");
    const extracted = extractBpmnFromMarkdown(md);
    assert.ok(extracted?.includes("<bpmn:startEvent"));
    assert.equal(extractBpmnFromMarkdown("```xml\n<notBpmn/>\n```"), null);
  });
});

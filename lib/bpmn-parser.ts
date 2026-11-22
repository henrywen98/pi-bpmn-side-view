import type {
  BpmnAnnotation,
  BpmnBounds,
  BpmnDiagnostic,
  BpmnEventMarker,
  BpmnFlow,
  BpmnLane,
  BpmnModel,
  BpmnNode,
  BpmnNodeKind,
  BpmnPool,
} from "./types.ts";

interface XmlNode {
  tag: string;
  localName: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const NODE_KINDS = new Set<BpmnNodeKind>([
  "startEvent",
  "endEvent",
  "intermediateCatchEvent",
  "intermediateThrowEvent",
  "boundaryEvent",
  "task",
  "userTask",
  "serviceTask",
  "scriptTask",
  "manualTask",
  "businessRuleTask",
  "sendTask",
  "receiveTask",
  "callActivity",
  "subProcess",
  "exclusiveGateway",
  "parallelGateway",
  "inclusiveGateway",
  "eventBasedGateway",
  "complexGateway",
  "dataObjectReference",
  "dataStoreReference",
]);

function stripNs(name: string): string {
  const idx = name.indexOf(":");
  return idx === -1 ? name : name.slice(idx + 1);
}

function decodeEntities(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, code: string) => {
    if (code === "amp") return "&";
    if (code === "lt") return "<";
    if (code === "gt") return ">";
    if (code === "quot") return '"';
    if (code === "apos") return "'";
    if (code.startsWith("#x")) {
      const n = Number.parseInt(code.slice(2), 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    if (code.startsWith("#")) {
      const n = Number.parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return m;
  });
}

function normalizeLabel(raw: string | undefined): string {
  if (!raw) return "";
  return raw.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();
}

export function parseXml(input: string): { root: XmlNode | null; error?: string } {
  const s = input.replace(/^\uFEFF/, "");
  const len = s.length;
  let pos = 0;
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;

  const skipWs = () => {
    while (pos < len && /\s/.test(s[pos]!)) pos++;
  };

  while (pos < len) {
    const lt = s.indexOf("<", pos);
    if (lt === -1) {
      if (stack.length > 0) {
        stack[stack.length - 1]!.text += decodeEntities(s.slice(pos));
      }
      break;
    }
    if (lt > pos && stack.length > 0) {
      stack[stack.length - 1]!.text += decodeEntities(s.slice(pos, lt));
    }
    pos = lt;

    // Comment
    if (s.startsWith("<!--", pos)) {
      const end = s.indexOf("-->", pos + 4);
      if (end === -1) return { root: null, error: "Unterminated XML comment" };
      pos = end + 3;
      continue;
    }

    // CDATA
    if (s.startsWith("<![CDATA[", pos)) {
      const end = s.indexOf("]]>", pos + 9);
      if (end === -1) return { root: null, error: "Unterminated CDATA section" };
      if (stack.length > 0) {
        stack[stack.length - 1]!.text += s.slice(pos + 9, end);
      }
      pos = end + 3;
      continue;
    }

    // Processing instruction
    if (s.startsWith("<?", pos)) {
      const end = s.indexOf("?>", pos + 2);
      if (end === -1) return { root: null, error: "Unterminated XML processing instruction" };
      pos = end + 2;
      continue;
    }

    // DOCTYPE or other declaration
    if (s.startsWith("<!", pos)) {
      let depth = 1;
      pos += 2;
      while (pos < len && depth > 0) {
        if (s[pos] === "<") depth++;
        else if (s[pos] === ">") depth--;
        pos++;
      }
      continue;
    }

    // Closing tag
    if (s.startsWith("</", pos)) {
      pos += 2;
      const gt = s.indexOf(">", pos);
      if (gt === -1) return { root: null, error: "Unterminated closing tag" };
      const closeTag = s.slice(pos, gt).trim();
      pos = gt + 1;
      const top = stack.pop();
      if (!top) return { root: null, error: `Unexpected closing tag </${closeTag}>` };
      if (top.tag !== closeTag && top.localName !== stripNs(closeTag)) {
        return { root: null, error: `Mismatched closing tag </${closeTag}> for <${top.tag}>` };
      }
      continue;
    }

    // Opening tag
    pos += 1;
    const tagStart = pos;
    while (pos < len && !/[\s/>]/.test(s[pos]!)) pos++;
    const tag = s.slice(tagStart, pos);
    if (!tag) return { root: null, error: `Invalid tag at offset ${tagStart}` };

    const attrs: Record<string, string> = {};
    let selfClosing = false;

    while (pos < len) {
      skipWs();
      if (pos >= len) return { root: null, error: `Unterminated opening tag <${tag}>` };
      if (s[pos] === ">") {
        pos += 1;
        break;
      }
      if (s[pos] === "/" && s[pos + 1] === ">") {
        selfClosing = true;
        pos += 2;
        break;
      }
      const attrStart = pos;
      while (pos < len && !/[\s=/>]/.test(s[pos]!)) pos++;
      const attrName = s.slice(attrStart, pos);
      skipWs();
      let attrVal = "";
      if (s[pos] === "=") {
        pos += 1;
        skipWs();
        const quote = s[pos];
        if (quote === '"' || quote === "'") {
          pos += 1;
          const valStart = pos;
          const valEnd = s.indexOf(quote, valStart);
          if (valEnd === -1) {
            return { root: null, error: `Unterminated attribute "${attrName}" on <${tag}>` };
          }
          attrVal = decodeEntities(s.slice(valStart, valEnd));
          pos = valEnd + 1;
        } else {
          const valStart = pos;
          while (pos < len && !/[\s/>]/.test(s[pos]!)) pos++;
          attrVal = decodeEntities(s.slice(valStart, pos));
        }
      }
      if (attrName) {
        attrs[attrName] = attrVal;
        const localAttr = stripNs(attrName);
        if (!(localAttr in attrs)) attrs[localAttr] = attrVal;
      }
    }

    const node: XmlNode = {
      tag,
      localName: stripNs(tag),
      attrs,
      children: [],
      text: "",
    };

    if (stack.length > 0) {
      stack[stack.length - 1]!.children.push(node);
    } else if (!root) {
      root = node;
    }

    if (!selfClosing) {
      stack.push(node);
    }
  }

  if (stack.length > 0) {
    return { root: null, error: `Unclosed XML element <${stack[stack.length - 1]!.tag}>` };
  }
  return { root };
}

function detectEventMarker(node: XmlNode): BpmnEventMarker {
  for (const child of node.children) {
    switch (child.localName) {
      case "timerEventDefinition":
        return "timer";
      case "messageEventDefinition":
        return "message";
      case "errorEventDefinition":
        return "error";
      case "signalEventDefinition":
        return "signal";
      case "terminateEventDefinition":
        return "terminate";
      case "escalationEventDefinition":
        return "escalation";
      case "conditionalEventDefinition":
        return "conditional";
    }
  }
  return "none";
}

function getChildText(node: XmlNode, localName: string): string | undefined {
  const child = node.children.find((c) => c.localName === localName);
  if (!child) return undefined;
  const text = normalizeLabel(child.text);
  return text || undefined;
}

function collectBounds(root: XmlNode): Map<string, BpmnBounds> {
  const map = new Map<string, BpmnBounds>();
  const walk = (n: XmlNode) => {
    if (n.localName === "BPMNShape") {
      const ref = n.attrs["bpmnElement"];
      const b = n.children.find((c) => c.localName === "Bounds");
      if (ref && b) {
        const x = Number.parseFloat(b.attrs["x"] ?? "");
        const y = Number.parseFloat(b.attrs["y"] ?? "");
        const width = Number.parseFloat(b.attrs["width"] ?? "");
        const height = Number.parseFloat(b.attrs["height"] ?? "");
        if ([x, y, width, height].every(Number.isFinite)) {
          map.set(ref, { x, y, width, height });
        }
      }
    }
    for (const c of n.children) walk(c);
  };
  walk(root);
  return map;
}

export function parseBpmnXml(xml: string, fallbackTitle = "BPMN Diagram"): BpmnModel {
  const diagnostics: BpmnDiagnostic[] = [];
  const { root, error } = parseXml(xml);
  if (error || !root) {
    return {
      title: fallbackTitle,
      pools: [],
      lanes: [],
      nodes: [],
      flows: [],
      annotations: [],
      diagnostics: [{ level: "error", message: error ?? "Empty XML input" }],
    };
  }

  const boundsById = collectBounds(root);
  const pools: BpmnPool[] = [];
  const poolByProcess = new Map<string, BpmnPool>();
  const lanes: BpmnLane[] = [];
  const laneByNode = new Map<string, string>();
  const nodes: BpmnNode[] = [];
  const nodeById = new Map<string, BpmnNode>();
  const flows: BpmnFlow[] = [];
  const defaultFlowIds = new Set<string>();
  const annotationsById = new Map<string, BpmnAnnotation>();
  const rawAssociations: Array<{ id: string; sourceRef: string; targetRef: string }> = [];

  let autoId = 1;
  const ensureId = (raw: string | undefined, prefix: string): string => {
    if (raw && raw.trim()) return raw.trim();
    return `${prefix}_${autoId++}`;
  };

  // 1. Collaborations (Pools + Message Flows)
  const collaborations: XmlNode[] = [];
  const processes: XmlNode[] = [];

  const scanTop = (n: XmlNode) => {
    if (n.localName === "collaboration") {
      collaborations.push(n);
      return;
    }
    if (n.localName === "process") {
      processes.push(n);
      return;
    }
    for (const c of n.children) scanTop(c);
  };
  scanTop(root);

  for (const collab of collaborations) {
    for (const child of collab.children) {
      if (child.localName === "participant") {
        const id = ensureId(child.attrs["id"], "pool");
        const name = normalizeLabel(child.attrs["name"]) || id;
        const processRef = child.attrs["processRef"]?.trim() || undefined;
        const pool: BpmnPool = { id, name, processRef };
        pools.push(pool);
        if (processRef) poolByProcess.set(processRef, pool);
      } else if (child.localName === "messageFlow") {
        const id = ensureId(child.attrs["id"], "msg");
        const sourceRef = child.attrs["sourceRef"]?.trim() ?? "";
        const targetRef = child.attrs["targetRef"]?.trim() ?? "";
        if (sourceRef && targetRef) {
          flows.push({
            id,
            name: normalizeLabel(child.attrs["name"]),
            kind: "messageFlow",
            sourceRef,
            targetRef,
          });
        }
      } else if (child.localName === "textAnnotation") {
        const id = ensureId(child.attrs["id"], "note");
        const text = getChildText(child, "text") ?? normalizeLabel(child.text);
        if (text) annotationsById.set(id, { id, text, targetIds: [] });
      } else if (child.localName === "association") {
        const id = ensureId(child.attrs["id"], "assoc");
        const sourceRef = child.attrs["sourceRef"]?.trim() ?? "";
        const targetRef = child.attrs["targetRef"]?.trim() ?? "";
        if (sourceRef && targetRef) rawAssociations.push({ id, sourceRef, targetRef });
      }
    }
  }

  // 2. Processes (Lanes + Flow Nodes + Sequence Flows)
  const extractLanes = (laneSetNode: XmlNode, processId: string, poolId: string | undefined) => {
    for (const child of laneSetNode.children) {
      if (child.localName !== "lane") continue;
      const laneId = ensureId(child.attrs["id"], "lane");
      const laneName = normalizeLabel(child.attrs["name"]) || laneId;
      const nodeIds: string[] = [];
      for (const grand of child.children) {
        if (grand.localName === "flowNodeRef") {
          const ref = grand.text.trim();
          if (ref) {
            nodeIds.push(ref);
            laneByNode.set(ref, laneId);
          }
        } else if (grand.localName === "childLaneSet") {
          extractLanes(grand, processId, poolId);
        }
      }
      lanes.push({ id: laneId, name: laneName, processId, poolId, nodeIds });
    }
  };

  const extractProcessContainer = (
    container: XmlNode,
    processId: string,
    poolId: string | undefined,
  ) => {
    for (const child of container.children) {
      const local = child.localName;
      if (local === "laneSet") {
        extractLanes(child, processId, poolId);
        continue;
      }
      if (local === "sequenceFlow") {
        const id = ensureId(child.attrs["id"], "flow");
        const sourceRef = child.attrs["sourceRef"]?.trim() ?? "";
        const targetRef = child.attrs["targetRef"]?.trim() ?? "";
        const condition = getChildText(child, "conditionExpression");
        if (sourceRef && targetRef) {
          flows.push({
            id,
            name: normalizeLabel(child.attrs["name"]),
            kind: "sequenceFlow",
            sourceRef,
            targetRef,
            condition,
          });
        } else {
          diagnostics.push({
            level: "warning",
            message: `Sequence flow "${id}" is missing sourceRef or targetRef`,
          });
        }
        continue;
      }
      if (local === "textAnnotation") {
        const id = ensureId(child.attrs["id"], "note");
        const text = getChildText(child, "text") ?? normalizeLabel(child.text);
        if (text) annotationsById.set(id, { id, text, targetIds: [] });
        continue;
      }
      if (local === "association") {
        const id = ensureId(child.attrs["id"], "assoc");
        const sourceRef = child.attrs["sourceRef"]?.trim() ?? "";
        const targetRef = child.attrs["targetRef"]?.trim() ?? "";
        if (sourceRef && targetRef) rawAssociations.push({ id, sourceRef, targetRef });
        continue;
      }
      if (NODE_KINDS.has(local as BpmnNodeKind)) {
        const id = ensureId(child.attrs["id"], local);
        const kind = local as BpmnNodeKind;
        const name = normalizeLabel(child.attrs["name"]);
        const defFlow = child.attrs["default"]?.trim();
        if (defFlow) defaultFlowIds.add(defFlow);
        const node: BpmnNode = {
          id,
          name,
          kind,
          eventMarker: detectEventMarker(child),
          processId,
          poolId,
          laneId: laneByNode.get(id),
          attachedToRef: child.attrs["attachedToRef"]?.trim() || undefined,
          documentation: getChildText(child, "documentation"),
          bounds: boundsById.get(id),
        };
        if (nodeById.has(id)) {
          diagnostics.push({ level: "warning", message: `Duplicate element id "${id}"` });
        } else {
          nodeById.set(id, node);
          nodes.push(node);
        }
        // If this is an expanded subProcess with internal nodes, also check if it has inner flows.
        // We keep the subProcess as a single clear activity node unless it has no name and we annotate count.
        if (kind === "subProcess") {
          const innerCount = child.children.filter((c) => NODE_KINDS.has(c.localName as BpmnNodeKind)).length;
          if (innerCount > 0 && !node.documentation) {
            node.documentation = `Sub-process containing ${innerCount} inner element(s).`;
          }
        }
      }
    }
  };

  for (const proc of processes) {
    const processId = ensureId(proc.attrs["id"], "process");
    const pool = poolByProcess.get(processId);
    extractProcessContainer(proc, processId, pool?.id);
  }

  // Assign laneId for nodes whose laneSet appeared after nodes in XML
  for (const node of nodes) {
    if (!node.laneId && laneByNode.has(node.id)) {
      node.laneId = laneByNode.get(node.id);
    }
    // Boundary events inherit the lane of their host activity
    if (node.kind === "boundaryEvent" && !node.laneId && node.attachedToRef) {
      const host = nodeById.get(node.attachedToRef);
      if (host?.laneId) node.laneId = host.laneId;
    }
  }

  // Mark default flows
  for (const flow of flows) {
    if (defaultFlowIds.has(flow.id)) flow.isDefault = true;
  }

  // Resolve annotations
  for (const assoc of rawAssociations) {
    const srcNote = annotationsById.get(assoc.sourceRef);
    const dstNote = annotationsById.get(assoc.targetRef);
    if (srcNote && nodeById.has(assoc.targetRef)) {
      srcNote.targetIds.push(assoc.targetRef);
    } else if (dstNote && nodeById.has(assoc.sourceRef)) {
      dstNote.targetIds.push(assoc.sourceRef);
    }
  }

  // Handle black-box pools (participants without a processRef that participate in messageFlows)
  for (const pool of pools) {
    const hasNodes = nodes.some((n) => n.poolId === pool.id);
    const referencedInMsg = flows.some(
      (f) => f.kind === "messageFlow" && (f.sourceRef === pool.id || f.targetRef === pool.id),
    );
    if (!hasNodes && referencedInMsg && !nodeById.has(pool.id)) {
      const proxy: BpmnNode = {
        id: pool.id,
        name: pool.name,
        kind: "callActivity",
        eventMarker: "message",
        processId: pool.processRef ?? pool.id,
        poolId: pool.id,
        documentation: "External participant (black-box pool)",
        bounds: boundsById.get(pool.id),
      };
      nodeById.set(proxy.id, proxy);
      nodes.push(proxy);
    }
  }

  // Validate flow endpoints
  for (const flow of flows) {
    if (!nodeById.has(flow.sourceRef)) {
      // Check if sourceRef is a pool ID
      const pool = pools.find((p) => p.id === flow.sourceRef);
      if (!pool) {
        diagnostics.push({
          level: "warning",
          message: `Flow "${flow.id}" references unknown source "${flow.sourceRef}"`,
        });
      }
    }
    if (!nodeById.has(flow.targetRef)) {
      const pool = pools.find((p) => p.id === flow.targetRef);
      if (!pool) {
        diagnostics.push({
          level: "warning",
          message: `Flow "${flow.id}" references unknown target "${flow.targetRef}"`,
        });
      }
    }
  }

  if (nodes.length === 0) {
    diagnostics.push({
      level: "warning",
      message: "No BPMN flow elements found in XML",
    });
  }

  // Determine diagram title
  const firstNamedProcess = processes.find((p) => normalizeLabel(p.attrs["name"]));
  const firstNamedPool = pools.find((p) => p.name && p.name !== p.id);
  const rootName = normalizeLabel(root.attrs["name"]);
  const title =
    rootName ||
    normalizeLabel(firstNamedProcess?.attrs["name"]) ||
    firstNamedPool?.name ||
    fallbackTitle;

  return {
    title,
    pools,
    lanes,
    nodes,
    flows,
    annotations: [...annotationsById.values()],
    diagnostics,
  };
}

export function extractBpmnFromMarkdown(markdown: string): string | null {
  const fenceRe = /```(?:bpmn|bpmn2|xml)?[ \t]*\r?\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  let lastFound: string | null = null;
  while ((match = fenceRe.exec(markdown)) !== null) {
    const body = match[1]?.trim() ?? "";
    if (/<(?:[a-zA-Z0-9_-]+:)?definitions\b/.test(body) && /<(?:[a-zA-Z0-9_-]+:)?process\b/.test(body)) {
      lastFound = body;
    }
  }
  return lastFound;
}

export const DEMO_BPMN_XML = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  id="Defs_PurchaseApproval"
                  name="采购审批流程 (Purchase Approval)"
                  targetNamespace="http://example.com/bpmn">
  <bpmn:collaboration id="Collab_1">
    <bpmn:participant id="Pool_Company" name="公司内部采购" processRef="Proc_Purchase" />
    <bpmn:participant id="Pool_Vendor" name="外部供应商" />
    <bpmn:messageFlow id="MF_1" name="发送采购单" sourceRef="Task_SendPO" targetRef="Pool_Vendor" />
    <bpmn:messageFlow id="MF_2" name="回传发货单" sourceRef="Pool_Vendor" targetRef="Event_WaitShip" />
  </bpmn:collaboration>

  <bpmn:process id="Proc_Purchase" name="采购审批流程 (Purchase Approval)" isExecutable="false">
    <bpmn:laneSet id="LaneSet_1">
      <bpmn:lane id="Lane_Requester" name="申请人">
        <bpmn:flowNodeRef>Start_1</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Task_Draft</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Task_Revise</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Event_WaitShip</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>End_Done</bpmn:flowNodeRef>
      </bpmn:lane>
      <bpmn:lane id="Lane_Manager" name="部门审批">
        <bpmn:flowNodeRef>Task_Review</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>GW_Approve</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>GW_Fork</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Task_SendPO</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>GW_Join</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>End_Cancelled</bpmn:flowNodeRef>
      </bpmn:lane>
      <bpmn:lane id="Lane_Finance" name="财务复核">
        <bpmn:flowNodeRef>Task_Budget</bpmn:flowNodeRef>
      </bpmn:lane>
    </bpmn:laneSet>

    <bpmn:startEvent id="Start_1" name="收到采购需求">
      <bpmn:documentation>业务部门提出新设备或服务采购申请。</bpmn:documentation>
    </bpmn:startEvent>
    <bpmn:userTask id="Task_Draft" name="填写采购申请单">
      <bpmn:documentation>录入物品清单、预算金额与交付日期。</bpmn:documentation>
    </bpmn:userTask>
    <bpmn:userTask id="Task_Review" name="审核需求与预算" />
    <bpmn:exclusiveGateway id="GW_Approve" name="审批结果?" default="Flow_Reject" />
    <bpmn:userTask id="Task_Revise" name="补充材料并重提" />
    <bpmn:endEvent id="End_Cancelled" name="申请已终止">
      <bpmn:terminateEventDefinition />
    </bpmn:endEvent>
    <bpmn:parallelGateway id="GW_Fork" name="并行执行" />
    <bpmn:sendTask id="Task_SendPO" name="下发正式采购单" />
    <bpmn:serviceTask id="Task_Budget" name="冻结预算并入账" />
    <bpmn:parallelGateway id="GW_Join" name="等待全部完成" />
    <bpmn:intermediateCatchEvent id="Event_WaitShip" name="等待供应商发货">
      <bpmn:timerEventDefinition />
    </bpmn:intermediateCatchEvent>
    <bpmn:endEvent id="End_Done" name="采购已完成" />

    <bpmn:sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_Draft" />
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Task_Draft" targetRef="Task_Review" />
    <bpmn:sequenceFlow id="Flow_3" sourceRef="Task_Review" targetRef="GW_Approve" />
    <bpmn:sequenceFlow id="Flow_Pass" name="通过" sourceRef="GW_Approve" targetRef="GW_Fork" />
    <bpmn:sequenceFlow id="Flow_Revise" name="需补充" sourceRef="GW_Approve" targetRef="Task_Revise" />
    <bpmn:sequenceFlow id="Flow_Reject" name="拒绝" sourceRef="GW_Approve" targetRef="End_Cancelled" />
    <bpmn:sequenceFlow id="Flow_Loop" name="重新提交" sourceRef="Task_Revise" targetRef="Task_Review" />
    <bpmn:sequenceFlow id="Flow_P1" sourceRef="GW_Fork" targetRef="Task_SendPO" />
    <bpmn:sequenceFlow id="Flow_P2" sourceRef="GW_Fork" targetRef="Task_Budget" />
    <bpmn:sequenceFlow id="Flow_J1" sourceRef="Task_SendPO" targetRef="GW_Join" />
    <bpmn:sequenceFlow id="Flow_J2" sourceRef="Task_Budget" targetRef="GW_Join" />
    <bpmn:sequenceFlow id="Flow_Wait" sourceRef="GW_Join" targetRef="Event_WaitShip" />
    <bpmn:sequenceFlow id="Flow_End" sourceRef="Event_WaitShip" targetRef="End_Done" />

    <bpmn:textAnnotation id="Note_1">
      <bpmn:text>超过 5 万元须追加财务总监审批</bpmn:text>
    </bpmn:textAnnotation>
    <bpmn:association id="Assoc_1" sourceRef="Task_Budget" targetRef="Note_1" />
  </bpmn:process>
</bpmn:definitions>
`;

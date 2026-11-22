export type BpmnNodeKind =
  | "startEvent"
  | "endEvent"
  | "intermediateCatchEvent"
  | "intermediateThrowEvent"
  | "boundaryEvent"
  | "task"
  | "userTask"
  | "serviceTask"
  | "scriptTask"
  | "manualTask"
  | "businessRuleTask"
  | "sendTask"
  | "receiveTask"
  | "callActivity"
  | "subProcess"
  | "exclusiveGateway"
  | "parallelGateway"
  | "inclusiveGateway"
  | "eventBasedGateway"
  | "complexGateway"
  | "dataObjectReference"
  | "dataStoreReference";

export type BpmnEventMarker =
  | "none"
  | "timer"
  | "message"
  | "error"
  | "signal"
  | "terminate"
  | "escalation"
  | "conditional";

export interface BpmnBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BpmnNode {
  id: string;
  name: string;
  kind: BpmnNodeKind;
  eventMarker: BpmnEventMarker;
  processId: string;
  poolId?: string;
  laneId?: string;
  attachedToRef?: string;
  documentation?: string;
  bounds?: BpmnBounds;
}

export interface BpmnFlow {
  id: string;
  name: string;
  kind: "sequenceFlow" | "messageFlow" | "association";
  sourceRef: string;
  targetRef: string;
  condition?: string;
  isDefault?: boolean;
}

export interface BpmnLane {
  id: string;
  name: string;
  processId: string;
  poolId?: string;
  nodeIds: string[];
}

export interface BpmnPool {
  id: string;
  name: string;
  processRef?: string;
}

export interface BpmnAnnotation {
  id: string;
  text: string;
  targetIds: string[];
}

export interface BpmnDiagnostic {
  level: "warning" | "error";
  message: string;
}

export interface BpmnModel {
  title: string;
  pools: BpmnPool[];
  lanes: BpmnLane[];
  nodes: BpmnNode[];
  flows: BpmnFlow[];
  annotations: BpmnAnnotation[];
  diagnostics: BpmnDiagnostic[];
}

export type LayoutOrientation = "tb" | "lr";

export type ZoomLevel = "fit" | "compact" | "detail";

export type DockPreference = "auto" | "right" | "top" | "bottom";
export type ResolvedDock = "right" | "top" | "bottom";

export interface NodeHitRect {
  nodeId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

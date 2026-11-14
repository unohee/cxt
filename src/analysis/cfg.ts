import type { AstLanguage } from '../frontend/types.js';
import type { DataflowFacts } from './dataflowTypes.js';

export interface SourceSpan {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  startOffset: number;
  endOffset: number;
}
export type CfgEdgeKind = 'normal' | 'true' | 'false' | 'back' | 'return' | 'throw' | 'exception' | 'break' | 'continue' | 'suspend' | 'resume';
export interface CfgNode {
  id: number;
  kind: 'entry' | 'exit' | 'exception-exit' | 'suspend-exit' | 'suspend' | 'operation' | 'condition' | 'return' | 'throw' | 'break' | 'continue' | 'join' | 'cleanup';
  astType: string;
  text: string;
  span: SourceSpan;
  /** 분기에서 선택된 값의 원본. 없으면 이 노드 자체의 AST를 평가한다. */
  valueSource?: SourceSpan;
  /** Python with cleanup이 enter에서 평가한 manager identity를 다시 참조한다. */
  resourceSource?: SourceSpan;
  constantValue?: 'undefined' | 'unit';
  binding?: 'parameter-default' | 'iteration' | 'exception' | 'exception-clear' | 'resource-enter';
}
export interface CfgEdge { from: number; to: number; kind: CfgEdgeKind }
export interface BasicBlock { id: number; nodes: number[] }
export interface CfgDiagnostic {
  code: 'unsupported-control' | 'invalid-jump' | 'budget-exceeded';
  message: string;
  span: SourceSpan;
}
export interface ControlFlowGraph {
  version: 1;
  filePath: string;
  owner: string;
  language: AstLanguage;
  executionKind?: 'sync' | 'async' | 'generator';
  entry: number;
  exit: number;
  exceptionExit: number;
  suspensionExit?: number;
  implicitReturnSource?: SourceSpan;
  nodes: CfgNode[];
  edges: CfgEdge[];
  blocks: BasicBlock[];
  blockEdges: CfgEdge[];
  completeness: 'complete' | 'partial';
  diagnostics: CfgDiagnostic[];
  /** 명시적 분기 수 + 1. 암묵적 예외 경로와 finally 복제는 중복 계산하지 않는다. */
  structuralComplexity: number;
  dataflow?: DataflowFacts;
}

/** 단일 normal 전이만 합친다. 분기·예외·루프 경계와 도달 불가능한 노드도 유지한다. */
export function buildBasicBlocks(graph: Pick<ControlFlowGraph, 'nodes' | 'edges' | 'entry'>): { blocks: BasicBlock[]; blockEdges: CfgEdge[] } {
  const incoming = new Map<number, CfgEdge[]>(), outgoing = new Map<number, CfgEdge[]>();
  for (const edge of graph.edges) {
    incoming.set(edge.to, [...incoming.get(edge.to) ?? [], edge]);
    outgoing.set(edge.from, [...outgoing.get(edge.from) ?? [], edge]);
  }
  const heads = new Set(graph.nodes.filter(node => {
    const predecessors = incoming.get(node.id) ?? [];
    return node.id === graph.entry || predecessors.length !== 1 || predecessors[0].kind !== 'normal'
      || (outgoing.get(predecessors[0].from)?.length ?? 0) !== 1;
  }).map(node => node.id));
  const blocks: BasicBlock[] = [];
  const membership = new Map<number, number>();
  const ordered = [...graph.nodes.filter(node => heads.has(node.id)), ...graph.nodes.filter(node => !heads.has(node.id))];
  for (const start of ordered) {
    if (membership.has(start.id)) continue;
    const block: BasicBlock = { id: blocks.length, nodes: [] };
    let current = start.id;
    while (true) {
      membership.set(current, block.id); block.nodes.push(current);
      const successors = outgoing.get(current) ?? [];
      if (successors.length !== 1 || successors[0].kind !== 'normal' || heads.has(successors[0].to) || membership.has(successors[0].to)) break;
      current = successors[0].to;
    }
    blocks.push(block);
  }
  const blockEdges: CfgEdge[] = [];
  const keys = new Set<string>();
  for (const edge of graph.edges) {
    const from = membership.get(edge.from)!, to = membership.get(edge.to)!;
    if (from === to && edge.kind === 'normal' && blocks[from].nodes.indexOf(edge.to) === blocks[from].nodes.indexOf(edge.from) + 1) continue;
    const key = `${from}:${to}:${edge.kind}`;
    if (!keys.has(key)) { keys.add(key); blockEdges.push({ from, to, kind: edge.kind }); }
  }
  return { blocks, blockEdges };
}

export function reachableNodes(graph: ControlFlowGraph, start = graph.entry): Set<number> {
  const outgoing = new Map<number, number[]>();
  for (const edge of graph.edges) outgoing.set(edge.from, [...outgoing.get(edge.from) ?? [], edge.to]);
  const seen = new Set<number>([start]);
  const queue = [start];
  for (let index = 0; index < queue.length; index++) for (const next of outgoing.get(queue[index]) ?? []) {
    if (!seen.has(next)) { seen.add(next); queue.push(next); }
  }
  return seen;
}

import { extractFile } from '../registry/entityScanner.js';
import type { AstLanguage } from '../frontend/types.js';
import { analyzeDataflow } from './dataflow.js';
import { analyzeAstRules, type StructuralFinding } from './astRules.js';
import { builtInRules, type RuleConfig } from './rulePack.js';

export interface RuleAnalysis {
  findings: StructuralFinding[];
  completeness: 'complete' | 'partial';
  diagnostics: Array<{ filePath: string; owner: string; code: string; message: string }>;
}

/** 현재 소스의 facts만 사용하며 partial flow를 결함 부재의 근거로 삼지 않는다. */
export function analyzeSemanticRules(content: string, filePath: string, language: AstLanguage, config?: RuleConfig, checkDeadline?: () => void): RuleAnalysis {
  const findings: StructuralFinding[] = [];
  const result: RuleAnalysis = { findings, completeness: 'complete', diagnostics: [] };
  const extracted = extractFile(content, filePath, language, 'ast');
  const rule = builtInRules.find(rule => rule.id === 'cxt/uninitialized-read')!;
  for (const graph of extracted.controlFlow ?? []) {
    checkDeadline?.();
    // 확정 진단을 낼 수 없는 CFG는 고비용 solver를 돌리기 전에 경계를 기록한다.
    // 이전에도 이 함수의 모든 finding을 버렸으므로 진단 범위를 줄이지 않는다.
    if (graph.completeness === 'partial' || !graph.dataflow || graph.dataflow.diagnostics.length) {
      result.completeness = 'partial';
      result.diagnostics.push(...(graph.dataflow?.diagnostics ?? []).map(diagnostic => ({ filePath, owner: graph.owner, code: diagnostic.code, message: diagnostic.message })));
      if (graph.completeness === 'partial' || !graph.dataflow) result.diagnostics.push({ filePath, owner: graph.owner, code: 'partial-cfg', message: 'Incomplete CFG/dataflow facts prevent definite-read diagnosis' });
      continue;
    }
    const flow = analyzeDataflow(graph);
    if (flow.completeness === 'partial') {
      result.completeness = 'partial';
      result.diagnostics.push(...flow.diagnostics.map(diagnostic => ({ filePath, owner: graph.owner, code: diagnostic.code, message: diagnostic.message })));
      continue;
    }
    for (const use of flow.uses) {
      if (use.value.atoms.length !== 1 || use.value.atoms[0] !== 'uninitialized') continue;
      const node = graph.nodes[use.node];
      const definitions = flow.definitions.filter(definition => use.definitions.includes(definition.id));
      findings.push({ rule, span: node.span, matchedText: node.text.slice(0, 80),
        flow: { owner: graph.owner, definitions: use.definitions, steps: [...new Set(definitions.map(definition => definition.node))]
          .map(id => graph.nodes[id].span).concat(node.span) } });
    }
  }
  // finally의 복제 CFG 노드는 같은 소스 읽기를 여러 번 표현한다.
  checkDeadline?.();
  result.findings = analyzeAstRules(content, filePath, language, config, findings);
  return result;
}

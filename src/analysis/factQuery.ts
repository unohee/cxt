import { z } from 'zod';

export const factViews = {
  entities: ['qualified_name', 'name', 'file_path', 'kind', 'status', 'risk_level', 'has_tests', 'line_start', 'line_end'],
  calls: ['file_path', 'line', 'column_number', 'caller', 'target', 'resolution', 'reason', 'confidence'],
  cfg: ['owner', 'file_path', 'completeness', 'node_count', 'edge_count', 'structural_complexity'],
  flows: ['owner', 'file_path', 'completeness', 'iterations', 'unknown_effect_count', 'definition_count'],
  summaries: ['owner', 'file_path', 'completeness', 'may_return', 'may_throw', 'return_parameters', 'return_atoms'],
} as const;
export const factQuerySchema = z.object({
  view: z.enum(['entities', 'calls', 'cfg', 'flows', 'summaries']),
  where: z.array(z.object({ column: z.string().min(1).max(64), op: z.enum(['eq', 'prefix']),
    value: z.union([z.string().max(512), z.number().finite(), z.boolean(), z.null()]) }).strict()).max(16).default([]),
  orderBy: z.string().max(64).optional(), direction: z.enum(['asc', 'desc']).default('asc'),
  limit: z.number().int().min(1).max(500).default(100), offset: z.number().int().min(0).max(100_000).default(0),
}).strict();
export type FactQuery = z.input<typeof factQuerySchema>;

/** SQL 식은 받지 않고, 허용된 view/column과 바인딩된 값만 조합한다. */
export function compileFactQuery(projectId: string, input: FactQuery): { sql: string; parameters: Array<string | number | null> } {
  if (!projectId || projectId.length > 512) throw new Error('Project ID is required and bounded');
  const query = factQuerySchema.parse(input), columns: readonly string[] = factViews[query.view];
  const column = (name: string): string => {
    if (!columns.includes(name)) throw new Error(`Unsupported ${query.view} column: ${name}`);
    return name;
  };
  const conditions = ['project_id = ?'], parameters: Array<string | number | null> = [projectId];
  for (const filter of query.where) {
    const name = column(filter.column);
    if (filter.op === 'prefix') {
      if (typeof filter.value !== 'string') throw new Error('Prefix filters require a string');
      conditions.push(`${name} LIKE ? ESCAPE '!'`); parameters.push(filter.value.replaceAll(/[!%_]/g, value => `!${value}`) + '%');
    } else if (filter.value === null) conditions.push(`${name} IS NULL`);
    else { conditions.push(`${name} = ?`); parameters.push(typeof filter.value === 'boolean' ? Number(filter.value) : filter.value); }
  }
  // 정렬 동률도 column 전체를 tie-break로 고정하여 pagination을 재현한다.
  const order = [...new Set([column(query.orderBy ?? columns[0]), ...columns])].map(name => `${name} ${query.direction}`).join(', ');
  parameters.push(query.limit, query.offset);
  return { sql: `SELECT ${columns.join(', ')} FROM cxt_query_${query.view} WHERE ${conditions.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`, parameters };
}

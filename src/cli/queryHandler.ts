import { getRegistryStore, closeRegistryStore } from '../registry/sqliteStore.js';
import { factQuerySchema } from '../analysis/factQuery.js';
import { resolveProjectId } from './checkHandler.js';
import { escapeTerminal } from './outputSafety.js';

export function handleQuery(view: string, opts: { project?: string; where?: string; orderBy?: string; descending?: boolean; limit?: string; offset?: string; json?: boolean }): void {
  const projectId = opts.project ?? resolveProjectId(process.cwd());
  const query = factQuerySchema.parse({ view, where: opts.where ? JSON.parse(opts.where) as unknown : [], orderBy: opts.orderBy,
    direction: opts.descending ? 'desc' : 'asc', limit: opts.limit === undefined ? undefined : Number(opts.limit), offset: opts.offset === undefined ? undefined : Number(opts.offset) });
  try {
    const rows = getRegistryStore().queryFacts(projectId, query);
    const result = { project: projectId, view, source: 'persisted-snapshot', freshness: 'not-verified', rows, limit: query.limit, offset: query.offset };
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`${escapeTerminal(projectId)} / ${view}: ${rows.length} stored rows (source freshness not verified)`);
      for (const row of rows) console.log(Object.entries(row).map(([key, value]) => `${key}=${escapeTerminal(value)}`).join('  '));
    }
  } finally { closeRegistryStore(); }
}

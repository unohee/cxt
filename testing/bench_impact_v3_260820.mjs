// Created: 2026-08-20
// Purpose: INT-3881 DoD measurement — impact query p95, v2 baseline (JS BFS, no
//          reverse index) vs v3 (recursive CTE + idx_cer_target), 1000-entity fixture.
// Dependencies: better-sqlite3 (repo devDep)
// Test Status: measurement script, not part of the vitest suite
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const LAYERS = 10, PER_LAYER = 100, CALLS_PER_NODE = 3, ITERS = 50, MAX_DEPTH = 9;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildDb(path, { withIndex }) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE code_entities (id TEXT PRIMARY KEY, name TEXT NOT NULL, file_path TEXT NOT NULL);
    CREATE TABLE code_entity_relations (
      source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation_type TEXT NOT NULL,
      PRIMARY KEY (source_id, target_id, relation_type)
    );
  `);
  if (withIndex) {
    db.exec('CREATE INDEX idx_cer_target ON code_entity_relations(target_id, relation_type);');
  }
  const rng = mulberry32(42);
  const insE = db.prepare('INSERT INTO code_entities VALUES (?, ?, ?)');
  const insR = db.prepare('INSERT OR IGNORE INTO code_entity_relations VALUES (?, ?, ?)');
  const ids = [];
  db.transaction(() => {
    for (let l = 0; l < LAYERS; l++) {
      for (let i = 0; i < PER_LAYER; i++) {
        const id = `n-${l}-${i}`;
        ids.push(id);
        insE.run(id, `fn_${l}_${i}`, `src/l${l}/f${i}.ts`);
        if (l > 0) {
          // each node calls CALLS_PER_NODE random nodes in the previous layer
          for (let c = 0; c < CALLS_PER_NODE; c++) {
            insR.run(id, `n-${l - 1}-${Math.floor(rng() * PER_LAYER)}`, 'calls');
          }
        }
      }
    }
  })();
  return db;
}

// pre-v3 implementation replica (sqliteStore.ts getImpactSet before INT-3881)
function jsBfs(db, rootId, maxDepth) {
  const visited = new Set([rootId]);
  const result = [];
  let frontier = [rootId];
  const stmt = db.prepare(`
    SELECT DISTINCT r.source_id, e.name, e.file_path
    FROM code_entity_relations r JOIN code_entities e ON e.id = r.source_id
    WHERE r.target_id = ?`);
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next = [];
    for (const id of frontier) {
      for (const c of stmt.all(id)) {
        if (visited.has(c.source_id)) continue;
        visited.add(c.source_id);
        result.push({ id: c.source_id, depth });
        next.push(c.source_id);
      }
    }
    frontier = next;
  }
  return result;
}

// v3 implementation replica
function cteImpact(db, rootId, maxDepth) {
  return db.prepare(`
    WITH RECURSIVE impact(id, depth) AS (
      SELECT ?, 0
      UNION
      SELECT r.source_id, i.depth + 1
      FROM code_entity_relations r JOIN impact i ON r.target_id = i.id
      WHERE i.depth < ?
    )
    SELECT i.id, e.name, e.file_path, MIN(i.depth) AS depth
    FROM impact i JOIN code_entities e ON e.id = i.id
    WHERE i.id != ?
    GROUP BY i.id ORDER BY depth ASC, e.name ASC
  `).all(rootId, maxDepth, rootId);
}

function bench(label, fn) {
  fn(); fn(); // warmup
  const times = [];
  for (let i = 0; i < ITERS; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(ITERS * 0.5)];
  const p95 = times[Math.floor(ITERS * 0.95)];
  console.log(`${label.padEnd(34)} p50=${p50.toFixed(2)}ms  p95=${p95.toFixed(2)}ms`);
  return { p50, p95 };
}

const dir = mkdtempSync(join(tmpdir(), 'cxt-bench-'));
const root = 'n-0-0'; // layer-0 node: every upper layer transitively reaches it
try {
  const dbOld = buildDb(join(dir, 'v2.db'), { withIndex: false });
  const dbNew = buildDb(join(dir, 'v3.db'), { withIndex: true });

  const sizeCheck = cteImpact(dbNew, root, MAX_DEPTH).length;
  const bfsCheck = jsBfs(dbOld, root, MAX_DEPTH).length;
  console.log(`fixture: ${LAYERS * PER_LAYER} entities, impact(|set|) BFS=${bfsCheck} CTE=${sizeCheck}\n`);
  if (sizeCheck !== bfsCheck) throw new Error('result size mismatch — implementations diverge');

  const a = bench('v2  (JS BFS, no reverse index)', () => jsBfs(dbOld, root, MAX_DEPTH));
  const b = bench('v3  (recursive CTE + index)', () => cteImpact(dbNew, root, MAX_DEPTH));
  // 참고용 교차 조건
  bench('ref (JS BFS + index)', () => jsBfs(dbNew, root, MAX_DEPTH));
  bench('ref (CTE, no index)', () => cteImpact(dbOld, root, MAX_DEPTH));

  const speedup = a.p95 / b.p95;
  const pass = speedup >= 5;
  console.log(`\nspeedup p95: ${speedup.toFixed(1)}x  (DoD gate: >= 5x) — ${pass ? 'PASS' : 'FAIL'}`);
  // 게이트 집행: 선언만 하고 통과시키면 DoD 근거가 못 된다 (PR #7 리뷰 r3).
  process.exitCode = pass ? 0 : 1;
  dbOld.close(); dbNew.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

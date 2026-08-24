// Created: 2026-08-20
// Purpose: INT-3881 DoD measurement — impact query p95, v2 baseline (JS BFS, no
//          reverse index) vs v3 (JS BFS + idx_cer_target), 1000-entity fixture.
//          Also demonstrates WHY the recursive-CTE variant was rejected: on a
//          cyclic dense graph at --depth 100 the CTE degrades to O(E x depth)
//          (review finding #5) while BFS stays O(V+E).
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

// getImpactSet implementation replica — identical algorithm before and after
// INT-3881; the v3 win comes from idx_cer_target serving the per-hop lookup.
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

// Rejected alternative kept for the record: recursive CTE. Dedups (id, depth)
// tuples, not visited ids — cyclic graphs re-expand nodes once per depth.
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

const CYC_NODES = 2000;
// Dense cyclic graph (8 seeded-random callees per node -> strongly connected,
// high fan-in): every node is re-reachable at many distinct depths, so the CTE
// materializes ~(edges x depth) tuples before GROUP BY collapses them.
function buildCyclicDb(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE code_entities (id TEXT PRIMARY KEY, name TEXT NOT NULL, file_path TEXT NOT NULL);
    CREATE TABLE code_entity_relations (
      source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation_type TEXT NOT NULL,
      PRIMARY KEY (source_id, target_id, relation_type)
    );
    CREATE INDEX idx_cer_target ON code_entity_relations(target_id, relation_type);
  `);
  const insE = db.prepare('INSERT INTO code_entities VALUES (?, ?, ?)');
  const insR = db.prepare('INSERT OR IGNORE INTO code_entity_relations VALUES (?, ?, ?)');
  db.transaction(() => {
    for (let i = 0; i < CYC_NODES; i++) insE.run(`c-${i}`, `cfn_${i}`, `src/c${i}.ts`);
    const rngC = mulberry32(7);
    for (let i = 0; i < CYC_NODES; i++) {
      insR.run(`c-${i}`, `c-${(i + 1) % CYC_NODES}`, 'calls'); // guaranteed cycle
      for (let k = 0; k < 7; k++) {
        insR.run(`c-${i}`, `c-${Math.floor(rngC() * CYC_NODES)}`, 'calls');
      }
    }
  })();
  return db;
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
  const b = bench('v3  (JS BFS + index) [shipped]', () => jsBfs(dbNew, root, MAX_DEPTH));
  // cross-condition references (CTE = rejected alternative)
  bench('ref (CTE + index)', () => cteImpact(dbNew, root, MAX_DEPTH));
  bench('ref (CTE, no index)', () => cteImpact(dbOld, root, MAX_DEPTH));

  // Why the CTE was rejected: cyclic dense graph, user-reachable --depth 100.
  const dbCyc = buildCyclicDb(join(dir, 'cyc.db'));
  const t0 = performance.now();
  const bfsCyc = jsBfs(dbCyc, 'c-0', 100).length;
  const bfsCycMs = performance.now() - t0;
  const t1 = performance.now();
  const cteCyc = cteImpact(dbCyc, 'c-0', 100).length;
  const cteCycMs = performance.now() - t1;
  console.log(`\ncyclic worst case (${CYC_NODES} nodes, depth 100): BFS=${bfsCycMs.toFixed(0)}ms  CTE=${cteCycMs.toFixed(0)}ms  (|set| ${bfsCyc}/${cteCyc})`);
  dbCyc.close();

  const speedup = a.p95 / b.p95;
  const pass = speedup >= 5;
  console.log(`\nspeedup p95: ${speedup.toFixed(1)}x  (DoD gate: >= 5x) — ${pass ? 'PASS' : 'FAIL'}`);
  // Enforce the gate: a declared-but-unenforced gate is not DoD evidence (PR #7 review r3).
  process.exitCode = pass ? 0 : 1;
  dbOld.close(); dbNew.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

import { z } from 'zod';
import type { t } from '../i18n.js';
import type { BsSeverity } from '../registry/bsDetector.js';

export type PathRole = 'production' | 'test' | 'fixture' | 'tooling' | 'configuration';
export interface RuleDefinition {
  id: string;
  version: string;
  category: string;
  severity: BsSeverity;
  languages: string[];
  messageKey: keyof ReturnType<typeof t>;
  rationale: string;
  precision: 'high' | 'medium' | 'low';
  precisionBasis: 'policy-estimate';
  ignoredRoles: PathRole[];
  fixtures: { positive: string; negative: string };
}
const all = ['typescript', 'python', 'rust'];
const ts = ['typescript'];
function rule(name: string, category: string, severity: BsSeverity, messageKey: RuleDefinition['messageKey'], languages: string[],
  rationale: string, precision: RuleDefinition['precision'] = 'medium', ignoredRoles: PathRole[] = ['test']): RuleDefinition {
  return { id: `cxt/${name}`, version: '1.0.0', category, severity, messageKey, languages, rationale, precision,
    precisionBasis: 'policy-estimate', ignoredRoles, fixtures: { positive: `${name}-positive`, negative: `${name}-negative` } };
}
/** 각 구형 패턴에 안정된 ID를 부여한다. precision은 측정 확률이 아니다. */
export const builtInRules: RuleDefinition[] = [
  rule('bare-except-pass', 'exception_hiding', 'critical', 'bsExceptPass', ['python'], 'Bare exception handler discards all failures.', 'high', []),
  rule('typed-except-pass', 'exception_hiding', 'critical', 'bsExceptExceptionPass', ['python'], 'Typed exception handler discards the captured failure.', 'high', []),
  rule('marked-success-return', 'fake_execution', 'critical', 'bsFakeReturn', all, 'Success literal is paired with an explicit placeholder marker.'),
  rule('hardcoded-secret', 'hardcoded_secret', 'critical', 'bsHardcodedSecret', all, 'Credential-shaped literal enters source history.', 'medium', ['test', 'fixture']),
  rule('debugger-statement', 'debug_leftover', 'critical', 'bsDebugger', ts, 'Debugger statement can interrupt execution.', 'high', []),
  rule('rust-unwrap', 'panic_risk', 'critical', 'bsRustUnwrap', ['rust'], 'Unchecked unwrap/expect can panic.', 'medium', ['test', 'fixture', 'tooling']),
  rule('rust-incomplete', 'incomplete', 'critical', 'bsRustTodo', ['rust'], 'Placeholder macro reaches panic when executed.', 'high', ['test', 'fixture', 'tooling']),
  rule('success-log', 'fake_execution', 'critical', 'bsFakeSuccess', ['typescript', 'python'], 'Success log is a review candidate; the statement alone does not prove successful work.', 'low', ['test', 'tooling']),
  rule('python-fake-data', 'fake_data', 'critical', 'bsFakeData', ['python'], 'Synthetic data generator occurs in a production path.', 'low', ['test', 'fixture']),
  rule('todo-comment', 'incomplete', 'warning', 'bsTodoFixme', all, 'Source comment records unfinished work.', 'high', []),
  rule('console-log', 'debug_leftover', 'warning', 'bsConsoleLog', ts, 'Console output occurs outside a declared tooling path.', 'low', ['test', 'tooling']),
  rule('as-any', 'type_safety', 'warning', 'bsAsAny', ts, 'Assertion bypasses static type checking.'),
  rule('any-type', 'type_safety', 'warning', 'bsAnyType', ts, 'Explicit any removes type checking for this value.'),
  rule('non-null-assertion', 'type_safety', 'warning', 'bsNonNullAssertion', ts, 'Non-null assertion suppresses nullable type evidence.'),
  rule('eval-call', 'security', 'warning', 'bsEval', ['typescript', 'python'], 'Dynamic evaluation requires review; spelling does not prove builtin identity.'),
  rule('rust-discard-error', 'error_swallow', 'warning', 'bsRustSilentError', ['rust'], 'Discarded call/ok result may discard an error; return type remains unproven.', 'low', ['test', 'fixture', 'tooling']),
  rule('placeholder-url', 'fake_data', 'warning', 'bsFakeUrl', all, 'Placeholder endpoint literal occurs outside configuration.', 'medium', ['test', 'fixture', 'configuration']),
  rule('magic-number', 'magic_number', 'minor', 'bsMagicNumber', all, 'Unnamed numeric literal has no recognized domain context.', 'low'),
  rule('long-line', 'readability', 'minor', 'bsLongLine', all, 'Long code line increases reading cost.', 'high', []),
  rule('catch-swallow', 'exception_hiding', 'warning', 'bsCatchSwallow', ts, 'Catch handler has a path without explicit failure propagation.', 'medium'),
  rule('uninitialized-read', 'correctness', 'warning', 'bsUninitializedRead', all, 'Every value reaching this read is uninitialized in the completed local dataflow model.', 'high', []),
];

export const rulePackSchema = z.object({
  id: z.string().min(1).max(128), version: z.string().regex(/^\d+\.\d+\.\d+$/),
  rules: z.array(z.object({
    id: z.string().regex(/^cxt\/[a-z][a-z0-9-]+$/), version: z.string().regex(/^\d+\.\d+\.\d+$/),
    category: z.string().regex(/^[a-z_]+$/), severity: z.enum(['critical', 'warning', 'minor']),
    languages: z.array(z.enum(['typescript', 'python', 'rust'])).min(1), messageKey: z.string().min(1),
    rationale: z.string().min(10), precision: z.enum(['high', 'medium', 'low']), precisionBasis: z.literal('policy-estimate'),
    ignoredRoles: z.array(z.enum(['production', 'test', 'fixture', 'tooling', 'configuration'])),
    fixtures: z.object({ positive: z.string().min(1), negative: z.string().min(1) }).strict(),
  }).strict()).min(1).max(1000),
}).strict().superRefine((pack, context) => {
  if (new Set(pack.rules.map(rule => rule.id)).size !== pack.rules.length) context.addIssue({ code: 'custom', message: 'Duplicate rule ID' });
});
export const builtInRulePack = rulePackSchema.parse({ id: 'cxt.core', version: '1.0.0', rules: builtInRules });

export const ruleConfigSchema = z.object({ schemaVersion: z.literal(1),
  roles: z.array(z.object({ prefix: z.string().min(1).max(256).refine(path => !path.startsWith('/') && !path.includes('\\') && !path.split('/').some(part => ['.', '..', ''].includes(part))),
    role: z.enum(['production', 'test', 'fixture', 'tooling', 'configuration']) }).strict()).max(256).default([]),
}).strict().superRefine((config, context) => {
  if (new Set(config.roles.map(entry => entry.prefix)).size !== config.roles.length) context.addIssue({ code: 'custom', message: 'Duplicate path-role prefix' });
});
export type RuleConfig = z.infer<typeof ruleConfigSchema>;
export function pathRole(filePath: string, config?: RuleConfig): PathRole {
  const path = filePath.replaceAll('\\', '/').replace(/^\.\//, '');
  const explicit = config?.roles.filter(entry => path === entry.prefix || path.startsWith(`${entry.prefix}/`)).sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (explicit) return explicit.role;
  if (/(^|\/)(tests?|__tests__)\/|\.test\.|\.spec\.|(^|\/)test_|_test\./.test(path)) return 'test';
  if (/(^|\/)(fixtures?|mocks?|examples?|samples?|benches)\/|\.(example|sample)\./.test(path)) return 'fixture';
  if (/(^|\/)(scripts|cli|runners|bin)\/|(^|\/)cli\.[cm]?[jt]s$|(^|\/)build\.rs$/.test(path)) return 'tooling';
  if (/(^|\/)(config|defaults?|settings)(\/|\.)/.test(path)) return 'configuration';
  return 'production';
}

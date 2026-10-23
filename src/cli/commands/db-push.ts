import * as fs from 'node:fs';
import { parseArgs } from 'node:util';
import type { Driver } from 'neo4j-driver';
import type { VectorIndexCreationConfig } from '../../schema/index-statements';
import {
  applyUpstreamNodeLabels,
  hasCustomNodeLabels,
} from '../../schema/labels';
import { parseSchema } from '../../schema/parser';
import {
  loadConfigFile,
  resolveConnection,
  resolveSchemaPath,
} from '../config';
import { safeDisplay } from '../display';
import { createDriver } from '../driver';
import { CliError } from '../errors';
import { fetchLiveSchema } from '../introspect';
import { planSchemaSync, type PushPlan } from '../push-planner';
import type { CliIO } from '../types';

interface DbPushFlags {
  schema?: string;
  uri?: string;
  username?: string;
  database?: string;
  'dry-run'?: boolean;
  'force-drop'?: boolean;
  yes?: boolean;
  debug?: boolean;
  strict?: boolean;
}

function parseDbPushFlags(argv: string[]): DbPushFlags {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        schema: { type: 'string' },
        uri: { type: 'string' },
        username: { type: 'string' },
        database: { type: 'string' },
        'dry-run': { type: 'boolean' },
        'force-drop': { type: 'boolean' },
        yes: { type: 'boolean' },
        debug: { type: 'boolean' },
        strict: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    });
    return values as DbPushFlags;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`db push: ${message}`);
  }
}

/**
 * Print the FULL diff — including the destructive part. Under `--force-drop`
 * the orphan section shows the exact drop Cypher; otherwise it reports the
 * orphans as kept. Rendering the drops here (not in the confirmation step) is
 * what makes `--dry-run --force-drop` preview the drops instead of hiding
 * them — dry-run is exactly when you need to see what would be removed.
 */
function renderPlan(plan: PushPlan, io: CliIO, willDrop: boolean): void {
  if (plan.create.length === 0)
    if (
      plan.orphans.length === 0 &&
      plan.changed.length === 0 &&
      plan.blocked.length === 0
    )
      // Only claim a clean "in sync" when there is genuinely nothing to do —
      // outstanding orphans or changed definitions mean it is not in sync.
      io.out('✓ No changes — constraints and indexes are in sync');
    else io.out('No constraints or indexes to create.');
  else {
    io.out(
      `Plan — ${plan.create.length} to create, ${plan.inSync.length} in sync:`,
    );
    for (const statement of plan.create) {
      io.out(`  + ${statement.name}`);
      io.out(`      ${statement.cypher}`);
    }
  }

  // v2.4.8 — an equivalent constraint under another name satisfies the SDL;
  // say which one, instead of "creating" it on every run.
  for (const cover of plan.covered)
    io.out(
      `  = ${cover.statement.name} covered by ${safeDisplay(cover.by)} (equivalent constraint)`,
    );

  // v2.4.8 — a changed definition used to be reported "in sync". Under
  // --force-drop it is dropped and recreated; otherwise it is left alone
  // and the output says plainly that the schema is NOT in sync.
  if (plan.changed.length > 0) {
    if (willDrop)
      io.out(
        `Changed — ${plan.changed.length} index definition(s) differ from the SDL; eligible to recreate (--force-drop):`,
      );
    else
      io.out(
        `Changed — ${plan.changed.length} index definition(s) differ from the SDL — schema is NOT in sync (kept as-is; use --force-drop to recreate):`,
      );
    for (const change of plan.changed) {
      io.out(`  ~ ${change.statement.name}`);
      for (const diff of change.differences) io.out(`      ${diff}`);
      if (willDrop) {
        io.out(`      ${change.dropCypher}`);
        io.out(`      ${change.statement.cypher}`);
      }
    }
  }

  if (plan.orphans.length > 0)
    if (willDrop) {
      // "eligible to drop" — this is the plan; consent is resolved afterward.
      io.out(
        `Orphans — ${plan.orphans.length} eligible to drop (--force-drop):`,
      );
      for (const orphan of plan.orphans) io.out(`  - ${orphan.dropCypher}`);
    } else {
      io.out(
        `Orphans — ${plan.orphans.length} kept (use --force-drop to remove):`,
      );
      for (const orphan of plan.orphans)
        io.out(`  - ${safeDisplay(orphan.name)}`);
    }

  // v1.13.0 — unmanaged names come from live introspection and are exactly
  // the ones that FAILED identifier validation: sanitize before printing.
  if (plan.unmanaged.length > 0)
    io.out(
      `Unmanaged — ${plan.unmanaged.length} ignored: ${plan.unmanaged.map(safeDisplay).join(', ')}`,
    );
}

/**
 * Resolve consent for the destructive drops (cli-db-push spec). The drop list
 * is already shown by `renderPlan`; this only decides consent:
 *  - `granted`  — `--yes`, or an interactive "yes" → drop.
 *  - `declined` — an interactive "no" → keep orphans, exit 0.
 *  - `blocked`  — non-interactive with no `--yes` → error (require `--yes`).
 */
type DropConsent = 'granted' | 'declined' | 'blocked';

async function resolveDropConsent(
  plan: PushPlan,
  io: CliIO,
  yes: boolean,
): Promise<DropConsent> {
  if (yes) return 'granted';
  if (io.interactive && io.confirm)
    // Strict `=== true`: only an explicit boolean true consents, so a
    // misbehaving embedder returning a truthy non-boolean can't authorize a drop.
    return (await io.confirm(
      `Drop the ${plan.orphans.length + plan.changed.length} item(s) listed above?`,
    )) === true
      ? 'granted'
      : 'declined';
  return 'blocked';
}

async function applyCreates(
  driver: Driver,
  database: string | undefined,
  plan: PushPlan,
  io: CliIO,
): Promise<void> {
  if (plan.create.length === 0) return;
  const session = driver.session(database ? { database } : undefined);
  try {
    for (const statement of plan.create) {
      let result: Awaited<ReturnType<typeof session.run>>;
      try {
        result = await session.run(statement.cypher);
      } catch (error) {
        // v2.4.8 — an existing schema rule the plan could not see (a race,
        // or a server that hides definition columns) used to crash the
        // whole push with exit 1. Report it and carry on with the rest.
        if (!isSchemaAlreadyExists(error)) throw error;
        io.err(
          `warning: ${statement.name} not created — ${safeDisplay((error as Error).message)}`,
        );
        continue;
      }
      // v2.4.8 — `IF NOT EXISTS` is a silent no-op when an equivalent rule
      // exists; only claim "created" when Neo4j says something was added.
      const updates = result?.summary?.counters?.updates?.();
      if (
        updates &&
        (updates.constraintsAdded ?? 0) + (updates.indexesAdded ?? 0) === 0
      )
        io.out(
          `= ${statement.name} not created — Neo4j reports an equivalent constraint or index already exists`,
        );
      else io.out(`✓ created ${statement.name}`);
    }
  } finally {
    await session.close();
  }
}

/** `Neo.ClientError.Schema.*AlreadyExists` (index / constraint / equivalent rule). */
function isSchemaAlreadyExists(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    typeof code === 'string' &&
    /^Neo\.ClientError\.Schema\.\w*AlreadyExists$/.test(code)
  );
}

async function applyDrops(
  driver: Driver,
  database: string | undefined,
  plan: PushPlan,
  io: CliIO,
): Promise<void> {
  if (plan.orphans.length === 0 && plan.changed.length === 0) return;
  const session = driver.session(database ? { database } : undefined);
  try {
    // Drop + create, in that order: `CREATE … IF NOT EXISTS` would be a
    // no-op while the old definition still holds the name.
    for (const change of plan.changed) {
      await session.run(change.dropCypher);
      const result = await session.run(change.statement.cypher);
      // v2.5.1 — never claim "recreated" when the CREATE was a no-op.
      const updates = result?.summary?.counters?.updates?.();
      if (updates && (updates.indexesAdded ?? 0) === 0)
        io.err(
          `error: ${change.statement.name} was dropped but NOT recreated — Neo4j reports ` +
            `an equivalent index already exists. Schema is NOT in sync.`,
        );
      else io.out(`✓ recreated ${change.statement.name}`);
    }
    for (const orphan of plan.orphans) {
      await session.run(orphan.dropCypher);
      io.out(`✓ dropped ${safeDisplay(orphan.name)}`);
    }
  } finally {
    await session.close();
  }
}

export async function runDbPush(argv: string[], io: CliIO): Promise<number> {
  const flags = parseDbPushFlags(argv);
  const { config } = await loadConfigFile(io.cwd);
  const schemaPath = resolveSchemaPath(flags, config, io.cwd);
  const typeDefs = fs.readFileSync(schemaPath, 'utf-8');
  const strict = flags.strict === true || config.strict === true;
  // v2.17.0 — strict items 27–30: malformed SDL throws under strict (as the
  // app's strict OGM would at construction); default mode prints a warning.
  const schema = parseSchema(typeDefs, {
    strict,
    onWarning: (w) =>
      io.err(
        `warning: ${w.problem} Set strict: true in grafeo.config or pass --strict to ${w.fix}.`,
      ),
  });
  // v2.11.0 — strict item 23: plan constraints / indexes on the labels
  // the app's OGM uses (`strict` in grafeo.config or `--strict`).
  if (strict) applyUpstreamNodeLabels(schema);
  else
    for (const node of schema.nodes.values())
      if (hasCustomNodeLabels(node))
        io.err(
          `warning: ${node.typeName} has @node(labels: [${node.labels.map((l) => `"${l}"`).join(', ')}]) — ` +
            `planning its constraints and indexes on :${node.typeName} (2.x). An OGM with strict: true ` +
            `(and @neo4j/graphql) uses :${node.labels[0]}; set strict: true in grafeo.config or pass --strict to match it.`,
        );
  const connection = resolveConnection(flags, config, io.env);

  // GrafeoVectorIndexConfig is structurally a VectorIndexCreationConfig.
  const vectorConfig = config.vectorIndexes as
    | Record<string, VectorIndexCreationConfig>
    | undefined;

  const dryRun = flags['dry-run'] === true;
  const forceDrop = flags['force-drop'] === true;

  const driver = createDriver(io, connection);
  try {
    const live = await fetchLiveSchema(driver, connection.database);
    const plan = planSchemaSync(schema, live, vectorConfig);
    const willDrop =
      forceDrop && (plan.orphans.length > 0 || plan.changed.length > 0);

    renderPlan(plan, io, willDrop);

    // `@vector` indexes without dimensions are reported, never silently
    // skipped, and never block the rest of the plan.
    // v2.4.8 — Neo4j refuses a unique constraint over a property a plain
    // RANGE index already covers. Report it (the index is not grafeo's to
    // drop) instead of letting the CREATE crash the whole push.
    // v2.5.1 — same for a fulltext/vector index whose definition another
    // index already holds under a different name.
    // v2.12.5 — and for a name the SDL declares twice: Neo4j keeps the
    // first, so the later declaration is never created.
    for (const block of plan.blocked)
      io.err(
        block.reason === 'range-index'
          ? `warning: ${block.statement.name} not created — index "${safeDisplay(block.by)}" ` +
              `already covers the same label and property, and Neo4j will not add a ` +
              `unique constraint until that index is dropped. Schema is NOT in sync.`
          : block.reason === 'name-collision'
            ? `warning: ${block.statement.name} is declared more than once in the SDL ` +
              `(first by ${block.by}); only that one is created, so this is skipped: ` +
              `${block.statement.cypher}. Rename one of them. Schema is NOT in sync.`
            : `warning: ${block.statement.name} not created or updated — index "${safeDisplay(block.by)}" ` +
              `already has the SDL definition, and Neo4j will not create an equivalent ` +
              `index under another name. Drop it, or name the SDL index after it. Schema is NOT in sync.`,
      );

    for (const needs of plan.needsConfig)
      io.err(
        `warning: vector index "${needs.indexName}" ` +
          `(${needs.typeName}.${needs.embeddingProperty}) skipped — set ` +
          `vectorIndexes['${needs.indexName}'].dimensions in grafeo.config.ts to create it`,
      );

    if (plan.changed.length > 0 && !forceDrop)
      io.err(
        `warning: ${plan.changed.length} index definition(s) differ from the SDL and were NOT applied ` +
          `(${plan.changed.map((c) => c.statement.name).join(', ')}) — re-run with --force-drop to drop and recreate them`,
      );

    // Nothing to create and nothing to drop → no writes (idempotent re-run).
    if (plan.create.length === 0 && !willDrop) return 0;

    if (dryRun) {
      io.out('');
      io.out('Dry run — no changes applied.');
      return 0;
    }

    // Resolve drop consent FIRST, so a hard block (non-interactive, no --yes)
    // aborts cleanly without having applied anything. An interactive decline,
    // by contrast, still lets the additive creates proceed.
    let consent: DropConsent | undefined;
    if (willDrop) {
      consent = await resolveDropConsent(plan, io, flags.yes === true);
      if (consent === 'blocked')
        throw new CliError(
          'Destructive changes (--force-drop) require --yes in a non-interactive session.',
        );
    }

    // Additive creates are never gated.
    await applyCreates(driver, connection.database, plan, io);

    if (consent === 'granted')
      await applyDrops(driver, connection.database, plan, io);
    else if (consent === 'declined')
      io.out('Drop declined — orphans and changed definitions kept.');
    return 0;
  } finally {
    await driver.close();
  }
}

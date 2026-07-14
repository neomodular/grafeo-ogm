import * as fs from 'node:fs';
import { parseArgs } from 'node:util';
import type { Driver } from 'neo4j-driver';
import type { VectorIndexCreationConfig } from '../../schema/index-statements';
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
    if (plan.orphans.length === 0)
      // Only claim a clean "in sync" when there is genuinely nothing to do —
      // outstanding orphans mean the schema is not in sync.
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
      `Drop the ${plan.orphans.length} item(s) listed above?`,
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
      await session.run(statement.cypher);
      io.out(`✓ created ${statement.name}`);
    }
  } finally {
    await session.close();
  }
}

async function applyDrops(
  driver: Driver,
  database: string | undefined,
  plan: PushPlan,
  io: CliIO,
): Promise<void> {
  if (plan.orphans.length === 0) return;
  const session = driver.session(database ? { database } : undefined);
  try {
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
  const schema = parseSchema(typeDefs);
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
    const willDrop = forceDrop && plan.orphans.length > 0;

    renderPlan(plan, io, willDrop);

    // `@vector` indexes without dimensions are reported, never silently
    // skipped, and never block the rest of the plan.
    for (const needs of plan.needsConfig)
      io.err(
        `warning: vector index "${needs.indexName}" ` +
          `(${needs.typeName}.${needs.embeddingProperty}) skipped — set ` +
          `vectorIndexes['${needs.indexName}'].dimensions in grafeo.config.ts to create it`,
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
    else if (consent === 'declined') io.out('Drop declined — orphans kept.');
    return 0;
  } finally {
    await driver.close();
  }
}

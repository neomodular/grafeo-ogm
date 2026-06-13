import {
  buildNodeFulltextStatements,
  buildRelationshipFulltextStatements,
  buildUniqueConstraintStatements,
  buildVectorIndexStatements,
  SchemaStatement,
  VectorIndexCreationConfig,
  VectorIndexNeedingConfig,
} from '../schema/index-statements';
import type { SchemaMetadata } from '../schema/types';
import { assertSafeIdentifier } from '../utils/validation';

/**
 * Non-throwing safe-identifier check, reusing the canonical validator. The
 * orphan `DROP CONSTRAINT` interpolates a name that comes from LIVE database
 * introspection (not the SDL), so it must be re-validated before it enters
 * Cypher. A name that does not pass is treated as `unmanaged` and never
 * dropped — this closes the only injection sink in the CLI.
 */
function isSafeIdentifier(name: string): boolean {
  try {
    assertSafeIdentifier(name, 'orphan constraint name');
    return true;
  } catch {
    return false;
  }
}

/** Normalized row from SHOW CONSTRAINTS / SHOW INDEXES. */
export interface LiveSchemaItem {
  name: string;
  /**
   * SHOW type column — UNIQUENESS for constraints; RANGE / FULLTEXT /
   * VECTOR / TEXT / POINT / LOOKUP for indexes.
   */
  type: string;
}

export interface LiveSchema {
  constraints: LiveSchemaItem[];
  indexes: LiveSchemaItem[];
}

export interface PushPlanOrphan {
  name: string;
  dropCypher: string;
}

export interface PushPlan {
  /** Declared in SDL, missing in the database. */
  create: SchemaStatement[];
  /** Declared in SDL and already present. */
  inSync: SchemaStatement[];
  /**
   * Present in the database, attributable to grafeo by naming convention
   * (`{Label}_{prop}_unique` over a label the schema still defines), but
   * no longer declared. Reported always; dropped only under --force-drop.
   */
  orphans: PushPlanOrphan[];
  /** Present in the database, NOT grafeo-attributable — never touched. */
  unmanaged: string[];
  /** `@vector` indexes that cannot be created without config dimensions. */
  needsConfig: VectorIndexNeedingConfig[];
}

/**
 * Pure diff between the SDL-declared schema artifacts and the live
 * database state (cli-db-push spec). No driver, no I/O — callers feed it
 * normalized SHOW output, tests feed it fixtures.
 *
 * Matching is BY NAME: grafeo names unique constraints itself, and
 * fulltext/vector index names come verbatim from the SDL directives.
 *
 * Orphan scoping (design decision): SDL index names are user-chosen, so a
 * live index absent from the SDL cannot be attributed to grafeo — those
 * are always `unmanaged`. Only `{Label}_{prop}_unique` constraints over a
 * label the current schema defines are safe to call orphans. LOOKUP
 * indexes are Neo4j system infrastructure and are excluded from the
 * report entirely.
 */
export function planSchemaSync(
  schema: SchemaMetadata,
  live: LiveSchema,
  vectorConfig?: Record<string, VectorIndexCreationConfig>,
): PushPlan {
  const vector = buildVectorIndexStatements(schema, vectorConfig);
  const desired: SchemaStatement[] = [
    ...buildUniqueConstraintStatements(schema),
    ...buildNodeFulltextStatements(schema),
    ...buildRelationshipFulltextStatements(schema),
    ...vector.ready,
  ];

  const liveConstraintNames = new Set(live.constraints.map((c) => c.name));
  const liveIndexNames = new Set(live.indexes.map((i) => i.name));

  const create: SchemaStatement[] = [];
  const inSync: SchemaStatement[] = [];
  for (const statement of desired) {
    const present =
      statement.kind === 'unique-constraint'
        ? liveConstraintNames.has(statement.name)
        : liveIndexNames.has(statement.name);
    (present ? inSync : create).push(statement);
  }

  const desiredConstraintNames = new Set(
    desired.filter((s) => s.kind === 'unique-constraint').map((s) => s.name),
  );
  const desiredIndexNames = new Set(
    desired.filter((s) => s.kind !== 'unique-constraint').map((s) => s.name),
  );

  const knownLabels = new Set<string>();
  for (const [, nodeDef] of schema.nodes) {
    knownLabels.add(nodeDef.label);
    for (const label of nodeDef.labels) knownLabels.add(label);
  }

  const orphans: PushPlanOrphan[] = [];
  const unmanaged: string[] = [];

  for (const constraint of live.constraints) {
    if (desiredConstraintNames.has(constraint.name)) continue;
    // Grafeo-attributable AND a safe identifier → droppable orphan. A name
    // that matches the convention shape but carries unsafe characters (a
    // hostile live constraint) is demoted to `unmanaged`, never dropped.
    if (
      isGrafeoConstraintName(constraint.name, knownLabels) &&
      isSafeIdentifier(constraint.name)
    )
      orphans.push({
        name: constraint.name,
        dropCypher: `DROP CONSTRAINT ${constraint.name} IF EXISTS`,
      });
    else unmanaged.push(constraint.name);
  }

  for (const index of live.indexes) {
    if (desiredIndexNames.has(index.name)) continue;
    if (index.type === 'LOOKUP') continue;
    unmanaged.push(index.name);
  }

  return {
    create,
    inSync,
    orphans,
    // Dedup: a name can surface in both SHOW CONSTRAINTS and SHOW INDEXES.
    unmanaged: Array.from(new Set(unmanaged)),
    needsConfig: vector.needsConfig,
  };
}

/**
 * Does `name` match `{Label}_{prop}_unique` for a label the schema knows?
 * Labels may themselves contain underscores, so instead of one ambiguous
 * regex we test each known label as a prefix.
 */
function isGrafeoConstraintName(
  name: string,
  knownLabels: ReadonlySet<string>,
): boolean {
  if (!name.endsWith('_unique')) return false;
  for (const label of knownLabels) {
    const prefix = `${label}_`;
    if (!name.startsWith(prefix)) continue;
    const prop = name.slice(prefix.length, -'_unique'.length);
    if (prop.length > 0 && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(prop)) return true;
  }
  return false;
}

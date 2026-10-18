import {
  buildNodeFulltextStatements,
  buildRelationshipFulltextStatements,
  buildUniqueConstraintStatements,
  buildVectorIndexStatements,
  SchemaStatement,
  uniqueConstraintName,
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
  /** SHOW `labelsOrTypes` column, when the server exposes it. */
  labelsOrTypes?: string[];
  /** SHOW `properties` column, when the server exposes it. */
  properties?: string[];
  /**
   * SHOW INDEXES `owningConstraint` column — set on the index that backs a
   * constraint. Such a row is part of the constraint, not an index of its
   * own (v2.4.8).
   */
  owningConstraint?: string;
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
      isGrafeoConstraint(constraint, knownLabels) &&
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
    // v2.4.8 — a constraint's backing index is reported by SHOW INDEXES
    // too. It is accounted for with its constraint (in sync, orphan or
    // unmanaged), so listing it again made every in-sync grafeo constraint
    // show up as "Unmanaged — ignored" on rerun. Matching the live
    // constraint name covers servers without `owningConstraint`.
    if (index.owningConstraint || liveConstraintNames.has(index.name)) continue;
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
 * Is this live constraint one grafeo itself would have created — i.e. a
 * single-label, single-property UNIQUENESS constraint on a label the schema
 * knows, named exactly `uniqueConstraintName(label, prop)`?
 *
 * Decided from the constraint's DEFINITION, not its name alone. Pre-2.4.7
 * any name starting with a known label passed (`Book_Archive_code_unique`
 * looked like `Book` + prop `Archive_code`), so `--force-drop` could drop a
 * constraint on a label grafeo doesn't manage — or a NODE KEY / existence
 * constraint that merely shared the naming shape. Without the definition
 * columns it is never treated as droppable: a missed orphan is harmless, a
 * wrong drop is not.
 */
function isGrafeoConstraint(
  constraint: LiveSchemaItem,
  knownLabels: ReadonlySet<string>,
): boolean {
  if (constraint.type && constraint.type !== 'UNIQUENESS') return false;
  const labels = constraint.labelsOrTypes;
  const props = constraint.properties;
  if (!labels || !props || labels.length !== 1 || props.length !== 1)
    return false;
  const [label] = labels;
  const [prop] = props;
  return (
    knownLabels.has(label) &&
    constraint.name === uniqueConstraintName(label, prop)
  );
}

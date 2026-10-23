import {
  buildNodeFulltextStatements,
  buildRelationshipFulltextStatements,
  buildUniqueConstraintStatements,
  buildVectorIndexStatements,
  resolveRelTypeForProps,
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
  /** SHOW `entityType` column (NODE / RELATIONSHIP), when exposed. */
  entityType?: string;
  /**
   * SHOW INDEXES `options.indexConfig`, with integer values as JS numbers
   * (v2.4.8). Used to compare vector dimensions / similarity.
   */
  indexConfig?: Record<string, unknown>;
}

export interface LiveSchema {
  constraints: LiveSchemaItem[];
  indexes: LiveSchemaItem[];
}

export interface PushPlanOrphan {
  name: string;
  dropCypher: string;
}

/**
 * An index present under the SDL name whose live definition differs from
 * the SDL (v2.4.8). `CREATE … IF NOT EXISTS` is a silent no-op on an
 * existing name, so the only way to apply it is drop + create — which
 * `db push` does only under `--force-drop` with its consent rules.
 */
export interface PushPlanChange {
  statement: SchemaStatement;
  /** Human-readable `what: live → SDL` lines. */
  differences: string[];
  dropCypher: string;
}

/**
 * A desired unique constraint satisfied by an equivalent live constraint
 * under another name (v2.4.8) — e.g. a DBA's `sx_dba_isbn` on
 * `(:Book).isbn`. Neo4j treats `CREATE CONSTRAINT Book_isbn_unique IF NOT
 * EXISTS` as a no-op then, so it is in sync, not something to create.
 */
export interface PushPlanCovered {
  statement: SchemaStatement;
  /** Live constraint name (from introspection — sanitize before printing). */
  by: string;
}

/**
 * A desired unique constraint Neo4j will refuse to create because a plain
 * index already covers the same label + property (v2.4.8). grafeo never
 * drops an index it does not manage, so it is reported, not attempted.
 */
export interface PushPlanBlocked {
  statement: SchemaStatement;
  /** Live index name (from introspection — sanitize before printing). */
  by: string;
  /**
   * `range-index` — a plain RANGE index blocks a unique constraint.
   * `equivalent-index` — a fulltext/vector index with the same definition
   * exists under another name, so Neo4j will not create the SDL-named one.
   */
  reason: 'range-index' | 'equivalent-index';
}

export interface PushPlan {
  /** Declared in SDL, missing in the database. */
  create: SchemaStatement[];
  /** Declared in SDL and already present with the declared definition. */
  inSync: SchemaStatement[];
  /** Declared in SDL, present by name, but with a different definition. */
  changed: PushPlanChange[];
  /** Subset of `inSync` satisfied by an equivalent item under another name. */
  covered: PushPlanCovered[];
  /** Declared in SDL, missing, and not creatable as the database stands. */
  blocked: PushPlanBlocked[];
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
 * fulltext/vector index names come verbatim from the SDL directives. Since
 * v2.4.8 a name match is then checked against the live DEFINITION (labels,
 * properties, index type, vector dimensions / similarity) when the server
 * reports it; a mismatch is `changed`, not `inSync`.
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

  const definitions = describeDesired(schema, vectorConfig);
  const liveIndexesByName = new Map(live.indexes.map((i) => [i.name, i]));

  const create: SchemaStatement[] = [];
  const inSync: SchemaStatement[] = [];
  const changed: PushPlanChange[] = [];
  const covered: PushPlanCovered[] = [];
  const blocked: PushPlanBlocked[] = [];
  const equivalentIndex = (name: string, definition: DesiredDefinition) =>
    live.indexes.find(
      (i) =>
        i.name !== name &&
        !i.owningConstraint &&
        i.type === definition.type &&
        sameSchema(definition, i, definition.unorderedProperties),
    );
  for (const statement of desired) {
    const isConstraint = statement.kind === 'unique-constraint';
    const present = isConstraint
      ? liveConstraintNames.has(statement.name)
      : liveIndexNames.has(statement.name);
    if (!present) {
      const definition = definitions.get(statement.name);
      if (isConstraint && definition) {
        // v2.4.8 — match by definition, not only by name.
        const equivalent = live.constraints.find(
          (c) => c.type === 'UNIQUENESS' && sameSchema(definition, c),
        );
        if (equivalent) {
          inSync.push(statement);
          covered.push({ statement, by: equivalent.name });
          continue;
        }
        const blocker = live.indexes.find(
          (i) =>
            i.type === 'RANGE' &&
            !i.owningConstraint &&
            !liveConstraintNames.has(i.name) &&
            sameSchema(definition, i),
        );
        if (blocker) {
          blocked.push({ statement, by: blocker.name, reason: 'range-index' });
          continue;
        }
      }
      const twin =
        !isConstraint &&
        definition &&
        equivalentIndex(statement.name, definition);
      if (twin) {
        blocked.push({ statement, by: twin.name, reason: 'equivalent-index' });
        continue;
      }
      create.push(statement);
      continue;
    }
    // Constraints stay name-matched: grafeo names them `{Label}_{prop}_unique`
    // itself, and a same-named constraint with another definition is not
    // provably grafeo's, so it must never become a drop (v2.4.7 rule).
    const definition = isConstraint
      ? undefined
      : definitions.get(statement.name);
    const liveItem = liveIndexesByName.get(statement.name);
    const differences =
      liveItem && definition ? diffDefinition(definition, liveItem) : [];
    if (differences.length === 0) {
      inSync.push(statement);
      continue;
    }
    // v2.5.1 — Neo4j will not create a fulltext/vector index equivalent to
    // one that exists under another name, so a drop + recreate would leave
    // the SDL name missing (and fulltext queries address it by that name).
    const twin = definition && equivalentIndex(statement.name, definition);
    if (twin)
      blocked.push({ statement, by: twin.name, reason: 'equivalent-index' });
    else
      changed.push({
        statement,
        differences,
        // The name is SDL-derived and already passed assertSafeIdentifier
        // in the statement builders.
        dropCypher: `DROP INDEX ${statement.name} IF EXISTS`,
      });
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
    // v2.11.0 — strict item 23 moves a custom `@node(labels)` type's
    // constraints to labels[0]; the one 2.x put on the type name stays
    // grafeo's (an orphan, dropped only with --force-drop). A no-op in
    // default mode, where `label` is the type name.
    knownLabels.add(nodeDef.typeName);
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
    changed,
    covered,
    blocked,
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

/** What a desired SDL statement should look like in SHOW output. */
interface DesiredDefinition {
  type: 'UNIQUENESS' | 'FULLTEXT' | 'VECTOR';
  entityType: 'NODE' | 'RELATIONSHIP';
  labelsOrTypes: string[];
  properties: string[];
  /** Fulltext `ON EACH [...]` order carries no meaning. */
  unorderedProperties?: boolean;
  vector?: { dimensions: number; similarity: string };
}

/**
 * Definition of every desired statement, keyed by statement name. Walks
 * the same schema metadata the statement builders in
 * `schema/index-statements.ts` walk (and is fed the same vector config),
 * so names and definitions line up one-to-one with `desired`.
 */
function describeDesired(
  schema: SchemaMetadata,
  vectorConfig: Record<string, VectorIndexCreationConfig> | undefined,
): Map<string, DesiredDefinition> {
  const defs = new Map<string, DesiredDefinition>();
  for (const [, nodeDef] of schema.nodes) {
    for (const [, prop] of nodeDef.properties)
      if (prop.isUnique)
        defs.set(uniqueConstraintName(nodeDef.label, prop.name), {
          type: 'UNIQUENESS',
          entityType: 'NODE',
          labelsOrTypes: [nodeDef.label],
          properties: [prop.name],
        });
    for (const ftIndex of nodeDef.fulltextIndexes)
      if (ftIndex.fields.length > 0)
        defs.set(ftIndex.name, {
          type: 'FULLTEXT',
          entityType: 'NODE',
          labelsOrTypes: [nodeDef.label],
          properties: [...ftIndex.fields],
          unorderedProperties: true,
        });
    for (const vIndex of nodeDef.vectorIndexes ?? []) {
      const cfg = vectorConfig?.[vIndex.indexName];
      if (!cfg) continue;
      defs.set(vIndex.indexName, {
        type: 'VECTOR',
        entityType: 'NODE',
        labelsOrTypes: [nodeDef.label],
        properties: [vIndex.embeddingProperty],
        vector: {
          dimensions: cfg.dimensions,
          similarity: cfg.similarity ?? 'cosine',
        },
      });
    }
  }
  for (const [, relPropsDef] of schema.relationshipProperties)
    for (const ftIndex of relPropsDef.fulltextIndexes ?? [])
      defs.set(ftIndex.name, {
        type: 'FULLTEXT',
        entityType: 'RELATIONSHIP',
        labelsOrTypes: [resolveRelTypeForProps(schema, relPropsDef.typeName)],
        properties: [...ftIndex.fields],
        unorderedProperties: true,
      });
  return defs;
}

const fmt = (list: readonly string[]) => `[${list.join(', ')}]`;

/**
 * Compare a desired definition with the live row. Only columns the server
 * actually reported are compared — a server (or fixture) without them
 * keeps the pre-2.4.8 name-only behaviour, never a false "changed".
 */
function diffDefinition(
  want: DesiredDefinition,
  live: LiveSchemaItem,
): string[] {
  const diffs: string[] = [];
  if (live.type && live.type !== want.type)
    diffs.push(`type: ${live.type} → ${want.type}`);
  if (live.entityType && live.entityType !== want.entityType)
    diffs.push(`entity: ${live.entityType} → ${want.entityType}`);
  if (live.labelsOrTypes && !sameList(live.labelsOrTypes, want.labelsOrTypes))
    diffs.push(
      `labels: ${fmt(live.labelsOrTypes)} → ${fmt(want.labelsOrTypes)}`,
    );
  if (
    live.properties &&
    !sameList(live.properties, want.properties, want.unorderedProperties)
  )
    diffs.push(`properties: ${fmt(live.properties)} → ${fmt(want.properties)}`);
  if (want.vector && live.indexConfig) {
    const dims = live.indexConfig['vector.dimensions'];
    if (typeof dims === 'number' && dims !== want.vector.dimensions)
      diffs.push(`dimensions: ${dims} → ${want.vector.dimensions}`);
    const sim = live.indexConfig['vector.similarity_function'];
    if (
      typeof sim === 'string' &&
      sim.toLowerCase() !== want.vector.similarity.toLowerCase()
    )
      diffs.push(
        `similarity: ${sim.toLowerCase()} → ${want.vector.similarity.toLowerCase()}`,
      );
  }
  return diffs;
}

/**
 * Same entity, labels and properties? Requires the live row to report its
 * definition columns — without them nothing is ever called equivalent.
 */
function sameSchema(
  want: DesiredDefinition,
  live: LiveSchemaItem,
  unorderedProperties = false,
): boolean {
  if (!live.labelsOrTypes || !live.properties) return false;
  if (live.entityType && live.entityType !== want.entityType) return false;
  return (
    sameList(live.labelsOrTypes, want.labelsOrTypes, unorderedProperties) &&
    sameList(live.properties, want.properties, unorderedProperties)
  );
}

function sameList(
  a: readonly string[],
  b: readonly string[],
  unordered = false,
): boolean {
  if (a.length !== b.length) return false;
  const x = unordered ? [...a].sort() : a;
  const y = unordered ? [...b].sort() : b;
  return x.every((v, i) => v === y[i]);
}

import { OGMError } from '../errors';
import { assertSafeIdentifier, assertSafeLabel } from '../utils/validation';
import type { SchemaMetadata } from './types';

/**
 * Single source of truth for the Cypher that materializes SDL-declared
 * constraints and indexes. Consumed by BOTH `OGM.assertIndexesAndConstraints`
 * (create-only, backwards-compatible behavior) and the CLI's `db push`
 * planner — so the two can never drift on statement shape or naming.
 *
 * Statement text for unique constraints and fulltext indexes is
 * byte-identical to what `assertIndexesAndConstraints` emitted before the
 * extraction (v1.9.0). Vector-index statements are new and used only by
 * `db push` (the SDL `@vector` directive carries no dimensions, so creation
 * needs per-index config).
 */
export interface SchemaStatement {
  kind:
    | 'unique-constraint'
    | 'fulltext-index'
    | 'relationship-fulltext-index'
    | 'vector-index';
  /** Constraint or index name as it appears in SHOW CONSTRAINTS/INDEXES. */
  name: string;
  cypher: string;
}

/** Vector index awaiting creation config (dimensions are not in the SDL). */
export interface VectorIndexNeedingConfig {
  indexName: string;
  typeName: string;
  embeddingProperty: string;
}

export interface VectorIndexCreationConfig {
  dimensions: number;
  similarity?: 'cosine' | 'euclidean';
}

/** Grafeo's unique-constraint naming convention: `{Label}_{prop}_unique`. */
export function uniqueConstraintName(label: string, prop: string): string {
  return `${label}_${prop}_unique`;
}

export function buildUniqueConstraintStatements(
  schema: SchemaMetadata,
): SchemaStatement[] {
  const statements: SchemaStatement[] = [];
  for (const [, nodeDef] of schema.nodes)
    for (const [, prop] of nodeDef.properties)
      if (prop.isUnique) {
        assertSafeLabel(nodeDef.label);
        assertSafeIdentifier(prop.name, 'property name');
        const constraintName = uniqueConstraintName(nodeDef.label, prop.name);
        assertSafeIdentifier(constraintName, 'constraint name');
        statements.push({
          kind: 'unique-constraint',
          name: constraintName,
          cypher: `CREATE CONSTRAINT ${constraintName} IF NOT EXISTS FOR (n:${nodeDef.label}) REQUIRE n.${prop.name} IS UNIQUE`,
        });
      }
  return statements;
}

export function buildNodeFulltextStatements(
  schema: SchemaMetadata,
): SchemaStatement[] {
  const statements: SchemaStatement[] = [];
  for (const [, nodeDef] of schema.nodes)
    for (const ftIndex of nodeDef.fulltextIndexes)
      if (ftIndex.fields.length > 0) {
        assertSafeLabel(nodeDef.label);
        assertSafeIdentifier(ftIndex.name, 'fulltext index name');
        for (const f of ftIndex.fields)
          assertSafeIdentifier(f, 'fulltext index field');
        const fieldsStr = ftIndex.fields.map((f) => `n.${f}`).join(', ');
        statements.push({
          kind: 'fulltext-index',
          name: ftIndex.name,
          cypher: `CREATE FULLTEXT INDEX ${ftIndex.name} IF NOT EXISTS FOR (n:${nodeDef.label}) ON EACH [${fieldsStr}]`,
        });
      }
  return statements;
}

/**
 * Resolve which relationship type carries a given `@relationshipProperties`
 * type. Mirrors `OGM.relPropsToRelType` (first relationship wins) but is
 * derived from the schema metadata alone, so callers without an OGM
 * instance (the CLI) get the identical mapping.
 */
export function resolveRelTypeForProps(
  schema: SchemaMetadata,
  propsTypeName: string,
): string {
  for (const [, nodeDef] of schema.nodes)
    for (const [, relDef] of nodeDef.relationships)
      if (relDef.properties === propsTypeName) return relDef.type;

  // Message preserved verbatim from the pre-extraction
  // `OGM.findRelTypeForProps` — it is pinned by existing tests.
  throw new OGMError(
    `No relationship found using properties type "${propsTypeName}"`,
  );
}

export function buildRelationshipFulltextStatements(
  schema: SchemaMetadata,
): SchemaStatement[] {
  const statements: SchemaStatement[] = [];
  for (const [, relPropsDef] of schema.relationshipProperties)
    for (const ftIndex of relPropsDef.fulltextIndexes ?? []) {
      assertSafeIdentifier(ftIndex.name, 'fulltext index name');
      for (const f of ftIndex.fields)
        assertSafeIdentifier(f, 'fulltext index field');
      const relType = resolveRelTypeForProps(schema, relPropsDef.typeName);
      assertSafeIdentifier(relType, 'relationship type');
      const fieldsStr = ftIndex.fields.map((f) => `r.${f}`).join(', ');
      statements.push({
        kind: 'relationship-fulltext-index',
        name: ftIndex.name,
        cypher: `CREATE FULLTEXT INDEX ${ftIndex.name} IF NOT EXISTS FOR ()-[r:${relType}]-() ON EACH [${fieldsStr}]`,
      });
    }
  return statements;
}

/**
 * Vector indexes split two ways: those with creation config provided
 * (ready statements) and those without (reported, never silently skipped).
 */
export function buildVectorIndexStatements(
  schema: SchemaMetadata,
  vectorConfig: Record<string, VectorIndexCreationConfig> | undefined,
): { ready: SchemaStatement[]; needsConfig: VectorIndexNeedingConfig[] } {
  const ready: SchemaStatement[] = [];
  const needsConfig: VectorIndexNeedingConfig[] = [];

  for (const [, nodeDef] of schema.nodes)
    for (const vIndex of nodeDef.vectorIndexes ?? []) {
      assertSafeLabel(nodeDef.label);
      assertSafeIdentifier(vIndex.indexName, 'vector index name');
      assertSafeIdentifier(vIndex.embeddingProperty, 'embedding property');

      const cfg = vectorConfig?.[vIndex.indexName];
      if (!cfg || !Number.isInteger(cfg.dimensions) || cfg.dimensions <= 0) {
        needsConfig.push({
          indexName: vIndex.indexName,
          typeName: nodeDef.typeName,
          embeddingProperty: vIndex.embeddingProperty,
        });
        continue;
      }

      const similarity = cfg.similarity ?? 'cosine';
      if (similarity !== 'cosine' && similarity !== 'euclidean')
        throw new OGMError(
          `Invalid similarity "${String(similarity)}" for vector index ${vIndex.indexName}. Must be "cosine" or "euclidean".`,
        );

      ready.push({
        kind: 'vector-index',
        name: vIndex.indexName,
        cypher:
          `CREATE VECTOR INDEX ${vIndex.indexName} IF NOT EXISTS ` +
          `FOR (n:${nodeDef.label}) ON (n.${vIndex.embeddingProperty}) ` +
          `OPTIONS {indexConfig: {\`vector.dimensions\`: ${cfg.dimensions}, \`vector.similarity_function\`: '${similarity}'}}`,
      });
    }

  return { ready, needsConfig };
}

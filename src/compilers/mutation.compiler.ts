import { OGMError } from '../errors';
import {
  NodeDefinition,
  RelationshipDefinition,
  SchemaMetadata,
} from '../schema/types';
import {
  buildRelPattern,
  getTargetLabelString,
  resolveTargetDef,
} from '../schema/utils';
import {
  assertSafeIdentifier,
  assertSafeLabel,
  escapeIdentifier,
  mergeParams,
} from '../utils/validation';

/**
 * Relationship filter suffixes that require EXISTS subquery patterns.
 * These match related nodes via relationship traversal rather than scalar property comparison.
 */
const RELATIONSHIP_SUFFIXES = ['_SOME', '_NONE', '_ALL', '_SINGLE'] as const;
type RelationshipSuffix = (typeof RELATIONSHIP_SUFFIXES)[number];

export interface MutationResult {
  cypher: string;
  params: Record<string, unknown>;
}

/**
 * Compiles create, update, delete, and label mutations into Cypher + params.
 */
export class MutationCompiler {
  /**
   * Cache of computed label strings per type name.
   * Bounded by the number of node types in the schema (~50-100 entries).
   */
  private labelCache = new Map<string, string>();

  constructor(private schema: SchemaMetadata) {}

  /** Clear internal caches. Useful in tests to prevent cross-test pollution. */
  clearCaches(): void {
    this.labelCache.clear();
  }

  private getCachedLabelString(nodeDef: NodeDefinition): string {
    const cached = this.labelCache.get(nodeDef.typeName);
    if (cached) return cached;
    const labelStr = getTargetLabelString(nodeDef);
    this.labelCache.set(nodeDef.typeName, labelStr);
    return labelStr;
  }

  /**
   * Generate CREATE Cypher for one or more nodes.
   * Handles scalar properties, nested relationship creates, and connects.
   */
  compileCreate(
    inputs: Record<string, unknown>[],
    nodeDef: NodeDefinition,
    labels?: string[],
  ): MutationResult {
    this.relFilterCounter = 0;
    const lines: string[] = [];
    const params: Record<string, unknown> = {};
    const createdVars: string[] = [];

    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      const prefix = `create${i}`;
      const nodeVar = i === 0 ? 'n' : `n_${i}`;

      const { propString, propParams } = this.buildCreateProperties(
        input,
        nodeDef,
        prefix,
      );

      const labelStr = this.getCachedLabelString(nodeDef);

      lines.push(`CREATE (${nodeVar}:${labelStr} { ${propString} })`);
      mergeParams(params, propParams);

      createdVars.push(nodeVar);

      // Process relationship operations (nested create / connect)
      // Pass all previously created node vars as ancestors so WITH clauses
      // don't drop them from scope (needed for RETURN n at the end)
      const relLines = this.buildCreateRelationships(
        input,
        nodeDef,
        nodeVar,
        prefix,
        params,
        createdVars.slice(0, -1), // ancestors = all vars before current
      );
      lines.push(...relLines);
    }

    // Add extra labels to all created nodes
    if (labels && labels.length > 0) {
      const validatedLabels = labels.map((l) => assertSafeLabel(l)).join(':');
      for (const nodeVar of createdVars)
        lines.push(`SET ${nodeVar}:${validatedLabels}`);
    }

    lines.push('RETURN n');

    return { cypher: lines.join('\n'), params };
  }

  /**
   * Generate UPDATE Cypher (SET properties + connect/disconnect).
   */
  compileUpdate(
    _where: Record<string, unknown>,
    update: Record<string, unknown> | undefined,
    connect: Record<string, unknown> | undefined,
    disconnect: Record<string, unknown> | undefined,
    nodeDef: NodeDefinition,
    whereResult: {
      cypher: string;
      params: Record<string, unknown>;
      preludes?: string[];
    },
    labels?: string[],
    returnMode: 'node' | 'count' = 'node',
  ): MutationResult {
    this.relFilterCounter = 0;
    const labelStr = this.getCachedLabelString(nodeDef);

    const lines: string[] = [];
    const params: Record<string, unknown> = { ...whereResult.params };

    // Apply runtime labels to MATCH pattern (same as find())
    if (labels && labels.length > 0) {
      const extraLabels = labels.map((l) => assertSafeLabel(l)).join(':');
      lines.push(`MATCH (n:${labelStr}:${extraLabels})`);
    } else lines.push(`MATCH (n:${labelStr})`);

    // CALL preludes for `@cypher` fields referenced in the WHERE — must be
    // emitted between MATCH and WHERE so the projected aliases are in scope.
    if (whereResult.preludes && whereResult.preludes.length > 0)
      lines.push(...whereResult.preludes);

    if (whereResult.cypher) lines.push(`WHERE ${whereResult.cypher}`);

    // SET properties
    if (update && Object.keys(update).length > 0) {
      const setClauses: string[] = [];
      for (const [key, value] of Object.entries(update)) {
        // Skip relationship fields — handled separately below
        if (nodeDef.relationships.has(key)) continue;
        if (value === undefined) continue;
        assertSafeIdentifier(key, 'update property');
        const paramName = `update_${key}`;
        setClauses.push(`n.${escapeIdentifier(key)} = $${paramName}`);
        params[paramName] = value;
      }
      if (setClauses.length > 0) lines.push(`SET ${setClauses.join(', ')}`);

      // Process nested relationship operations within update body
      const relLines = this.buildUpdateRelationships(
        update,
        nodeDef,
        'n',
        'update',
        params,
      );
      lines.push(...relLines);
    }

    // Disconnect relationships (top-level) — must run before connects
    // so that blanket disconnects don't remove newly-connected relationships.
    if (disconnect) {
      const disconnectLines = this.buildDisconnects(
        disconnect,
        nodeDef,
        params,
      );
      lines.push(...disconnectLines);
    }

    // Connect relationships (top-level)
    if (connect) {
      const connectLines = this.buildConnects(connect, nodeDef, params);
      lines.push(...connectLines);
    }

    lines.push(
      returnMode === 'count' ? 'RETURN count(n) AS count' : 'RETURN n',
    );

    return { cypher: lines.join('\n'), params };
  }

  /**
   * Generate DELETE Cypher with optional cascade.
   */
  compileDelete(
    nodeDef: NodeDefinition,
    whereResult: {
      cypher: string;
      params: Record<string, unknown>;
      preludes?: string[];
    },
    deleteInput?: Record<string, unknown>,
  ): MutationResult {
    const labelStr = this.getCachedLabelString(nodeDef);

    const lines: string[] = [];
    const params: Record<string, unknown> = { ...whereResult.params };

    lines.push(`MATCH (n:${labelStr})`);
    if (whereResult.preludes && whereResult.preludes.length > 0)
      lines.push(...whereResult.preludes);
    if (whereResult.cypher) lines.push(`WHERE ${whereResult.cypher}`);

    if (deleteInput && Object.keys(deleteInput).length > 0) {
      const deleteVars: string[] = [];
      let varCounter = 0;

      for (const [fieldName] of Object.entries(deleteInput)) {
        const relDef = nodeDef.relationships.get(fieldName);
        if (!relDef) continue;

        const cascadeVar = `cascade_${varCounter}`;
        varCounter++;

        const pattern = buildRelPattern({
          sourceVar: 'n',
          relDef,
          targetVar: cascadeVar,
          targetLabel: relDef.target,
        });
        lines.push(`OPTIONAL MATCH ${pattern}`);
        deleteVars.push(cascadeVar);
      }

      lines.push(`DETACH DELETE ${[...deleteVars, 'n'].join(', ')}`);
    } else lines.push('DETACH DELETE n');

    return { cypher: lines.join('\n'), params };
  }

  /**
   * Generate MERGE (upsert) Cypher with ON CREATE SET / ON MATCH SET.
   * Scalar properties only — nested relationship ops are not supported.
   */
  compileMerge(
    where: Record<string, unknown>,
    create: Record<string, unknown>,
    update: Record<string, unknown>,
    nodeDef: NodeDefinition,
    labels?: string[],
  ): MutationResult {
    const labelStr = this.getCachedLabelString(nodeDef);
    const lines: string[] = [];
    const params: Record<string, unknown> = {};

    // Build MERGE key properties from where clause (scalar only)
    const mergeProps: string[] = [];
    const mergeKeyNames: string[] = [];
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined || value === null) continue;
      // Skip relationship suffixes and operators
      if (key === 'AND' || key === 'OR' || key === 'NOT') continue;
      if (key.includes('_') && !nodeDef.properties.has(key)) continue;
      assertSafeIdentifier(key, 'merge key');
      const paramName = `merge_${key}`;
      mergeProps.push(`${escapeIdentifier(key)}: $${paramName}`);
      mergeKeyNames.push(key);
      params[paramName] = value;
    }

    if (mergeProps.length === 0)
      throw new OGMError(
        'upsert requires at least one scalar property in "where" for MERGE key',
      );

    // Validate that the MERGE key set contains at least one `@unique` or
    // `@id` property. Pre-1.7.4 we accepted any key set, so:
    //   - A typo in `where` (e.g. `usernme`) became a phantom MERGE
    //     property — Neo4j happily created a node with that mis-named
    //     attribute on first use.
    //   - A non-unique `where` (e.g. `where: { country: 'AR' }`) matched
    //     multiple existing nodes; MERGE then fans out across all of
    //     them, applying ON MATCH SET to every match. Almost always a
    //     bug, never the developer's intent.
    // Requiring at least one unique/id key forces MERGE to target at
    // most one row.
    const hasUniqueOrId = mergeKeyNames.some((name) => {
      const prop = nodeDef.properties.get(name);
      // `isGenerated` is the parser's flag for the `@id` directive;
      // `isUnique` is the flag for `@unique`. Either is sufficient
      // to guarantee the MERGE pattern targets at most one row.
      return prop !== undefined && (prop.isUnique || prop.isGenerated);
    });
    if (!hasUniqueOrId)
      throw new OGMError(
        `upsert "where" must contain at least one property marked with @id or @unique. ` +
          `Got [${mergeKeyNames.map((n) => `"${n}"`).join(', ')}] — none of these are unique on ${nodeDef.typeName}. ` +
          `Without a unique key, MERGE can fan out across multiple existing nodes (applying ON MATCH SET to each) ` +
          `or create phantom properties on typo. If you really want a non-unique merge, use create() + update().`,
      );

    lines.push(`MERGE (n:${labelStr} { ${mergeProps.join(', ')} })`);

    // ON CREATE SET — all properties from create input (scalar only)
    const createSets: string[] = [];
    for (const [key, value] of Object.entries(create)) {
      if (value === undefined) continue;
      if (nodeDef.relationships.has(key)) continue;
      assertSafeIdentifier(key, 'create property');
      const paramName = `onCreate_${key}`;
      createSets.push(`n.${escapeIdentifier(key)} = $${paramName}`);
      params[paramName] = value;
    }
    if (createSets.length > 0)
      lines.push(`ON CREATE SET ${createSets.join(', ')}`);

    // ON MATCH SET — all properties from update input (scalar only)
    const updateSets: string[] = [];
    for (const [key, value] of Object.entries(update)) {
      if (value === undefined) continue;
      if (nodeDef.relationships.has(key)) continue;
      assertSafeIdentifier(key, 'update property');
      const paramName = `onMatch_${key}`;
      updateSets.push(`n.${escapeIdentifier(key)} = $${paramName}`);
      params[paramName] = value;
    }
    if (updateSets.length > 0)
      lines.push(`ON MATCH SET ${updateSets.join(', ')}`);

    // Extra labels
    if (labels && labels.length > 0) {
      const validatedLabels = labels.map((l) => assertSafeLabel(l)).join(':');
      lines.push(`SET n:${validatedLabels}`);
    }

    lines.push('RETURN n');

    return { cypher: lines.join('\n'), params };
  }

  /**
   * Generate SET/REMOVE labels Cypher.
   */
  compileSetLabels(
    nodeDef: NodeDefinition,
    whereResult: {
      cypher: string;
      params: Record<string, unknown>;
      preludes?: string[];
    },
    addLabels?: string[],
    removeLabels?: string[],
  ): MutationResult {
    const labelStr = this.getCachedLabelString(nodeDef);

    const lines: string[] = [];
    const params: Record<string, unknown> = { ...whereResult.params };

    lines.push(`MATCH (n:${labelStr})`);
    if (whereResult.preludes && whereResult.preludes.length > 0)
      lines.push(...whereResult.preludes);
    if (whereResult.cypher) lines.push(`WHERE ${whereResult.cypher}`);

    // Reject overlap between add and remove. Cypher executes
    // `SET n:Foo` then `REMOVE n:Foo` left-to-right, so the final state
    // is REMOVED — almost certainly not what the caller intended.
    // Throwing here prevents silent state divergence.
    if (
      addLabels &&
      addLabels.length > 0 &&
      removeLabels &&
      removeLabels.length > 0
    ) {
      const addSet = new Set(addLabels);
      const overlap = removeLabels.filter((l) => addSet.has(l));
      if (overlap.length > 0)
        throw new OGMError(
          `setLabels: addLabels and removeLabels overlap on [${overlap
            .map((l) => `"${l}"`)
            .join(', ')}]. ` +
            `Cypher executes SET then REMOVE left-to-right so the final state would be REMOVED. ` +
            `Pass each label in only one of the two arrays.`,
        );
    }

    if (addLabels && addLabels.length > 0)
      lines.push(`SET n:${addLabels.map((l) => assertSafeLabel(l)).join(':')}`);

    if (removeLabels && removeLabels.length > 0)
      for (const label of removeLabels)
        lines.push(`REMOVE n:${assertSafeLabel(label)}`);

    return { cypher: lines.join('\n'), params };
  }

  /**
   * Generate batch CREATE (or MERGE for skipDuplicates) Cypher via UNWIND.
   * Scalar properties only — no nested relationship operations.
   * Returns count of created nodes.
   */
  compileCreateMany(
    data: Record<string, unknown>[],
    nodeDef: NodeDefinition,
    skipDuplicates?: boolean,
    labels?: string[],
  ): MutationResult {
    if (data.length === 0) return { cypher: 'RETURN 0 AS count', params: {} };

    const labelStr = this.getCachedLabelString(nodeDef);
    const lines: string[] = [];
    const params: Record<string, unknown> = {};

    // Validate and sanitize: only scalar properties allowed
    const scalarKeys: string[] = [];
    for (const key of Object.keys(data[0])) {
      if (nodeDef.relationships.has(key))
        throw new OGMError(
          `createMany does not support relationship fields. Found: "${key}". Use create() for nested operations.`,
        );
      assertSafeIdentifier(key, 'createMany property');
      scalarKeys.push(key);
    }

    // Identify @id (generated) fields that are NOT provided in data
    const generatedFields: string[] = [];
    for (const [, propDef] of nodeDef.properties)
      if (propDef.isGenerated && !scalarKeys.includes(propDef.name))
        generatedFields.push(propDef.name);

    // Build sanitized items (strip undefined values)
    const sanitizedItems = data.map((item) => {
      const sanitized: Record<string, unknown> = {};
      for (const key of scalarKeys)
        if (item[key] !== undefined) sanitized[key] = item[key];
      return sanitized;
    });
    params.items = sanitizedItems;

    lines.push('UNWIND $items AS item');

    if (skipDuplicates) {
      // Find unique/id fields present in data for MERGE key
      const mergeKeys: string[] = [];
      for (const key of scalarKeys) {
        const propDef = nodeDef.properties.get(key);
        if (propDef && (propDef.isUnique || propDef.isGenerated))
          mergeKeys.push(key);
      }

      if (mergeKeys.length === 0)
        throw new OGMError(
          'createMany with skipDuplicates requires at least one @id or @unique field in data',
        );

      // MERGE on unique key(s)
      const mergeProps = mergeKeys
        .map((k) => `${escapeIdentifier(k)}: item.${escapeIdentifier(k)}`)
        .join(', ');
      lines.push(`MERGE (n:${labelStr} { ${mergeProps} })`);

      // ON CREATE SET — remaining fields + generated IDs
      const onCreateSets: string[] = [];
      for (const key of scalarKeys)
        if (!mergeKeys.includes(key))
          onCreateSets.push(
            `n.${escapeIdentifier(key)} = item.${escapeIdentifier(key)}`,
          );

      for (const field of generatedFields)
        onCreateSets.push(`n.${escapeIdentifier(field)} = randomUUID()`);

      if (onCreateSets.length > 0)
        lines.push(`ON CREATE SET ${onCreateSets.join(', ')}`);
    } else {
      // CREATE with all scalar properties + generated IDs
      const propParts: string[] = [];
      for (const field of generatedFields)
        propParts.push(`${escapeIdentifier(field)}: randomUUID()`);
      for (const key of scalarKeys)
        propParts.push(
          `${escapeIdentifier(key)}: item.${escapeIdentifier(key)}`,
        );

      lines.push(`CREATE (n:${labelStr} { ${propParts.join(', ')} })`);
    }

    // Extra labels
    if (labels && labels.length > 0) {
      const validatedLabels = labels.map((l) => assertSafeLabel(l)).join(':');
      lines.push(`SET n:${validatedLabels}`);
    }

    lines.push('RETURN count(n) AS count');

    return { cypher: lines.join('\n'), params };
  }

  // ─── Private helpers ──────────────────────────────────────────────

  private buildCreateProperties(
    input: Record<string, unknown>,
    nodeDef: NodeDefinition,
    prefix: string,
  ): { propString: string; propParams: Record<string, unknown> } {
    const parts: string[] = [];
    const propParams: Record<string, unknown> = {};

    // Auto-generate ID if property has isGenerated
    for (const [, propDef] of nodeDef.properties)
      if (propDef.isGenerated)
        parts.push(`${escapeIdentifier(propDef.name)}: randomUUID()`);

    for (const [key, value] of Object.entries(input)) {
      // Skip relationship fields and undefined values
      if (nodeDef.relationships.has(key)) continue;
      if (value === undefined) continue;
      assertSafeIdentifier(key, 'create property');
      const paramName = `${prefix}_${key}`;
      parts.push(`${escapeIdentifier(key)}: $${paramName}`);
      propParams[paramName] = value;
    }

    return { propString: parts.join(', '), propParams };
  }

  private buildCreateRelationships(
    input: Record<string, unknown>,
    nodeDef: NodeDefinition,
    nodeVar: string,
    prefix: string,
    params: Record<string, unknown>,
    ancestorVars: string[] = [],
  ): string[] {
    const lines: string[] = [];
    let nestedCounter = 0;

    // WITH clause must carry all ancestors + the node being created on
    const allVars = [...new Set([...ancestorVars, nodeVar])];
    const withClause = `WITH ${allVars.join(', ')}`;

    for (const [key, value] of Object.entries(input)) {
      const relDef = nodeDef.relationships.get(key);
      if (!relDef) continue;

      const relInput = value as Record<string, unknown>;

      // Check if target is a union type — if so, relInput uses per-member keys
      // e.g., items: { Ebook: { create: [...] } }
      const isUnionTarget =
        !this.schema.nodes.has(relDef.target) &&
        this.schema.unions?.has(relDef.target);

      if (isUnionTarget) {
        const unionMembers = this.schema.unions!.get(relDef.target)!;
        for (const [memberKey, memberValue] of Object.entries(relInput)) {
          if (!unionMembers.includes(memberKey)) continue;
          const memberNodeDef = this.schema.nodes.get(memberKey);
          if (!memberNodeDef) continue;

          const memberInput = memberValue as Record<string, unknown>;
          // Process creates/connects for this union member
          const memberLines = this.buildCreateRelationshipsForTarget(
            memberInput,
            memberNodeDef,
            relDef,
            nodeVar,
            `${prefix}_${key}_${memberKey}`,
            params,
            allVars,
            withClause,
            nestedCounter,
          );
          nestedCounter += memberLines.counterUsed;
          lines.push(...memberLines.lines);
        }
        continue;
      }

      const targetNodeDef = this.schema.nodes.get(relDef.target);
      if (!targetNodeDef) continue;

      const resultLines = this.buildCreateRelationshipsForTarget(
        relInput,
        targetNodeDef,
        relDef,
        nodeVar,
        `${prefix}_${key}`,
        params,
        allVars,
        withClause,
        nestedCounter,
      );
      nestedCounter += resultLines.counterUsed;
      lines.push(...resultLines.lines);
    }

    return lines;
  }

  /**
   * Process create/connect operations for a specific target node type.
   * Used by buildCreateRelationships for both union-member and non-union targets.
   */
  private buildCreateRelationshipsForTarget(
    relInput: Record<string, unknown>,
    targetNodeDef: NodeDefinition,
    relDef: RelationshipDefinition,
    nodeVar: string,
    prefix: string,
    params: Record<string, unknown>,
    allVars: string[],
    withClause: string,
    startCounter: number,
  ): { lines: string[]; counterUsed: number } {
    const lines: string[] = [];
    let counter = 0;

    const targetLabelStr = this.getCachedLabelString(targetNodeDef);

    // --- create ---
    if (relInput.create) {
      const createItems = Array.isArray(relInput.create)
        ? (relInput.create as Record<string, unknown>[])
        : [relInput.create as Record<string, unknown>];

      for (let ci = 0; ci < createItems.length; ci++) {
        const createSpec = createItems[ci];
        const nodeSpec = (createSpec.node ?? createSpec) as Record<
          string,
          unknown
        >;

        const createVar = `${nodeVar}_c${startCounter + counter}`;
        counter++;

        const { propString, propParams } = this.buildCreateProperties(
          nodeSpec,
          targetNodeDef,
          `${prefix}_create${ci}`,
        );

        // Handle nested relationship creates within the created node
        const nestedRelLines = this.buildCreateRelationships(
          nodeSpec,
          targetNodeDef,
          createVar,
          `${prefix}_create${ci}`,
          params,
          allVars,
        );

        const propsClause =
          propString.length > 0
            ? ` { ${propString} }`
            : ` { ${this.buildGeneratedIdClause(targetNodeDef)} }`;

        const relPattern = buildRelPattern({
          sourceVar: nodeVar,
          relDef,
          targetVar: createVar,
        });

        // Handle edge properties if present in createSpec
        const edgeInput = createSpec.edge as
          | Record<string, unknown>
          | undefined;

        // Wrap in CALL subquery if there are nested ops so failed MATCHes don't kill pipeline
        const hasNestedOps = nestedRelLines.length > 0;
        if (hasNestedOps) {
          lines.push(withClause);
          lines.push(`CALL {`);
          lines.push(withClause);
        } else lines.push(withClause);

        lines.push(`CREATE (${createVar}:${targetLabelStr}${propsClause})`);
        mergeParams(params, propParams);
        lines.push(`CREATE ${relPattern}`);

        // Set edge properties if present
        if (edgeInput && Object.keys(edgeInput).length > 0) {
          const relVar = `r_edge_${startCounter + counter - 1}`;
          // Re-match the relationship to set edge props
          const relArrow = buildRelPattern({
            sourceVar: nodeVar,
            relDef,
            targetVar: createVar,
            edgeVar: relVar,
            targetLabel: 'auto',
          });
          lines.push(`WITH ${[...allVars, createVar].join(', ')}`);
          lines.push(`MATCH ${relArrow}`);
          const setItems: string[] = [];
          for (const [prop, val] of Object.entries(edgeInput)) {
            if (val === undefined) continue;
            assertSafeIdentifier(prop, 'edge property');
            const paramName = `${prefix}_create${ci}_edge_${prop}`;
            setItems.push(
              `${relVar}.${escapeIdentifier(prop)} = $${paramName}`,
            );
            params[paramName] = val;
          }
          if (setItems.length > 0) lines.push(`SET ${setItems.join(', ')}`);
        }

        if (hasNestedOps) {
          lines.push(...nestedRelLines);
          lines.push(`RETURN count(*) AS _cc_${prefix}_${ci}`);
          lines.push(`}`);
        }
      }
    }

    // --- connect ---
    if (relInput.connect) {
      const connectItems = Array.isArray(relInput.connect)
        ? (relInput.connect as Record<string, unknown>[])
        : [relInput.connect as Record<string, unknown>];

      for (let ci = 0; ci < connectItems.length; ci++) {
        const connectSpec = connectItems[ci];
        const whereSpec = connectSpec.where as
          | Record<string, unknown>
          | undefined;
        const edgeInput = connectSpec.edge as
          | Record<string, unknown>
          | undefined;

        // Wrap in CALL subquery so a failed MATCH doesn't kill the outer pipeline
        lines.push(withClause);
        lines.push(`CALL {`);
        lines.push(withClause);

        const connectVar = `${nodeVar}_cn${startCounter + counter}`;
        counter++;

        lines.push(`MATCH (${connectVar}:${targetLabelStr})`);

        const conditions = this.buildConnectionWhereConditions(
          whereSpec,
          connectVar,
          `${prefix}_conn${ci}`,
          params,
          targetNodeDef,
        );
        if (conditions.length > 0)
          lines.push(`WHERE ${conditions.join(' AND ')}`);

        if (edgeInput && Object.keys(edgeInput).length > 0) {
          // Use bare target var (no label) since connectVar is already bound by MATCH.
          // Including labels on a bound variable in MERGE causes Neo4j to reject it.
          const relVar = `r_conn_${startCounter + counter - 1}`;
          assertSafeIdentifier(relDef.type, 'relationship type');
          const escapedRelType = escapeIdentifier(relDef.type);
          const mergePattern =
            relDef.direction === 'OUT'
              ? `(${nodeVar})-[${relVar}:${escapedRelType}]->(${connectVar})`
              : `(${nodeVar})<-[${relVar}:${escapedRelType}]-(${connectVar})`;
          lines.push(`MERGE ${mergePattern}`);
          const setItems: string[] = [];
          for (const [prop, val] of Object.entries(edgeInput)) {
            if (val === undefined) continue;
            assertSafeIdentifier(prop, 'edge property');
            const paramName = `${prefix}_conn${ci}_edge_${prop}`;
            setItems.push(
              `r_conn_${startCounter + counter - 1}.${escapeIdentifier(prop)} = $${paramName}`,
            );
            params[paramName] = val;
          }
          if (setItems.length > 0) lines.push(`SET ${setItems.join(', ')}`);
        } else {
          const relPattern = buildRelPattern({
            sourceVar: nodeVar,
            relDef,
            targetVar: connectVar,
          });
          lines.push(`MERGE ${relPattern}`);
        }

        lines.push(`RETURN count(*) AS _ccn_${prefix}_${ci}`);
        lines.push(`}`);
      }
    }

    return { lines, counterUsed: counter };
  }

  private buildConnects(
    connect: Record<string, unknown>,
    nodeDef: NodeDefinition,
    params: Record<string, unknown>,
  ): string[] {
    const lines: string[] = [];

    for (const [fieldName, spec] of Object.entries(connect)) {
      const relDef = nodeDef.relationships.get(fieldName);
      if (!relDef) continue;

      const targetNodeDef = resolveTargetDef(relDef.target, this.schema);
      if (!targetNodeDef) continue;

      const targetLabelStr = this.getCachedLabelString(targetNodeDef);

      // Array connect
      if (Array.isArray(spec)) {
        if (spec.length === 0) continue; // Empty array — nothing to connect

        // Check if WHERE contains relationship filters (nested objects referencing
        // relationships on the target node). UNWIND can't handle EXISTS subqueries
        // with dynamic params, so we fall back to individual CALL subqueries.
        const hasRelFilters = this.arrayConnectHasRelationshipFilters(
          spec as Record<string, unknown>[],
          targetNodeDef,
        );

        if (hasRelFilters)
          // Fall back to individual CALL subqueries per item — these use
          // buildConnectionWhereConditions which handles relationship filters.
          for (let ci = 0; ci < spec.length; ci++) {
            const connectSpec = spec[ci] as Record<string, unknown>;
            const whereSpec = connectSpec.where as
              | Record<string, unknown>
              | undefined;
            const edgeInput = connectSpec.edge as
              | Record<string, unknown>
              | undefined;

            lines.push('WITH n');
            lines.push(`CALL {`);
            lines.push('WITH n');

            const connectVar = `target_${fieldName}_${ci}`;
            lines.push(`MATCH (${connectVar}:${targetLabelStr})`);

            const conditions = this.buildConnectionWhereConditions(
              whereSpec,
              connectVar,
              `connect_${fieldName}_${ci}`,
              params,
              targetNodeDef,
            );
            if (conditions.length > 0)
              lines.push(`WHERE ${conditions.join(' AND ')}`);

            if (edgeInput && Object.keys(edgeInput).length > 0) {
              assertSafeIdentifier(relDef.type, 'relationship type');
              const escapedRelType = escapeIdentifier(relDef.type);
              const relVar = `r_conn_${fieldName}_${ci}`;
              const mergePattern =
                relDef.direction === 'OUT'
                  ? `(n)-[${relVar}:${escapedRelType}]->(${connectVar})`
                  : `(n)<-[${relVar}:${escapedRelType}]-(${connectVar})`;
              lines.push(`MERGE ${mergePattern}`);
              const setItems: string[] = [];
              for (const [prop, val] of Object.entries(edgeInput)) {
                if (val === undefined) continue;
                assertSafeIdentifier(prop, 'edge property');
                const paramName = `connect_${fieldName}_${ci}_edge_${prop}`;
                setItems.push(
                  `${relVar}.${escapeIdentifier(prop)} = $${paramName}`,
                );
                params[paramName] = val;
              }
              if (setItems.length > 0) lines.push(`SET ${setItems.join(', ')}`);
            } else {
              const mergePattern = buildRelPattern({
                sourceVar: 'n',
                relDef,
                targetVar: connectVar,
              });
              lines.push(`MERGE ${mergePattern}`);
            }

            lines.push(`RETURN count(*) AS _ccn_${fieldName}_${ci}`);
            lines.push(`}`);
          }
        else {
          // Scalar-only WHERE — use efficient UNWIND approach
          const paramName = `connect_${fieldName}`;
          // Strip undefined values from edge objects — Neo4j driver drops undefined,
          // causing param mismatches when the Cypher references nested edge properties.
          params[paramName] = (spec as Record<string, unknown>[]).map(
            (item) => {
              const edge = item.edge as Record<string, unknown> | undefined;
              if (!edge) return item;
              const cleaned: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(edge))
                if (v !== undefined) cleaned[k] = v;

              return { ...item, edge: cleaned };
            },
          );

          lines.push('WITH n');
          lines.push(`UNWIND $${paramName} AS connItem`);
          lines.push(`MATCH (target:${targetLabelStr})`);

          // Build WHERE from the first item's structure to determine the path.
          // Pre-1.7.4 we silently used `firstItem`'s keys for ALL items —
          // if `spec[1]` had different filter keys (e.g. an extra
          // `tenantId`), those keys were silently dropped from the WHERE.
          // Validate homogeneity now and throw if items diverge so the
          // caller knows to split into separate calls or use the per-item
          // CALL fallback.
          const firstItem = spec[0] as Record<string, unknown>;
          const firstItemSig = computeConnectItemSignature(firstItem);
          for (let idx = 1; idx < spec.length; idx++) {
            const sig = computeConnectItemSignature(
              spec[idx] as Record<string, unknown>,
            );
            if (sig !== firstItemSig)
              throw new OGMError(
                `connect array items have divergent shapes — item[0] has keys "${firstItemSig}" ` +
                  `but item[${idx}] has keys "${sig}". The UNWIND fast path requires every item ` +
                  `to share the same WHERE / edge key set; otherwise the additional keys are ` +
                  `silently dropped. Split into separate connect calls, or normalise the items ` +
                  `to share the same shape.`,
              );
          }

          const whereConditions = this.extractConnectWhereConditions(
            firstItem,
            'target',
            'connItem',
          );
          if (whereConditions.length > 0)
            lines.push(`WHERE ${whereConditions.join(' AND ')}`);

          const mergePattern = buildRelPattern({
            sourceVar: 'n',
            relDef,
            targetVar: 'target',
          });
          lines.push(`MERGE ${mergePattern}`);

          // Handle edge properties from first item structure
          const edgeProps = this.extractEdgeProperties(firstItem);
          if (edgeProps.length > 0) {
            // Use bare target var (no label) since target is already bound by MATCH
            assertSafeIdentifier(relDef.type, 'relationship type');
            const escapedRelType = escapeIdentifier(relDef.type);
            const mergeWithVar =
              relDef.direction === 'OUT'
                ? `(n)-[r:${escapedRelType}]->(target)`
                : `(n)<-[r:${escapedRelType}]-(target)`;
            // Replace MERGE line with one that has a variable
            lines[lines.length - 1] = `MERGE ${mergeWithVar}`;
            // r.prop is relationship property (escape), connItem.edge.prop is parameter map (no escape)
            const setItems = edgeProps.map(
              (p) => `r.${escapeIdentifier(p)} = connItem.edge.${p}`,
            );
            lines.push(`SET ${setItems.join(', ')}`);
          }
        }
      } else {
        // Single connect
        const connectSpec = spec as Record<string, unknown>;
        const whereSpec = connectSpec.where as Record<string, unknown>;
        const edgeInput = connectSpec.edge as
          | Record<string, unknown>
          | undefined;

        lines.push('WITH n');
        lines.push(`MATCH (target:${targetLabelStr})`);

        const matchConditions = this.buildConnectionWhereConditions(
          whereSpec,
          'target',
          `connect_${fieldName}`,
          params,
          targetNodeDef,
        );

        if (matchConditions.length > 0)
          lines.push(`WHERE ${matchConditions.join(' AND ')}`);

        if (edgeInput && Object.keys(edgeInput).length > 0) {
          // Use bare target var (no label) since target is already bound by MATCH
          assertSafeIdentifier(relDef.type, 'relationship type');
          const escapedRelType = escapeIdentifier(relDef.type);
          const mergeWithVar =
            relDef.direction === 'OUT'
              ? `(n)-[r:${escapedRelType}]->(target)`
              : `(n)<-[r:${escapedRelType}]-(target)`;
          lines.push(`MERGE ${mergeWithVar}`);
          const setItems: string[] = [];
          for (const [prop, val] of Object.entries(edgeInput)) {
            if (val === undefined) continue;
            const paramName = `connect_${fieldName}_edge_${prop}`;
            setItems.push(`r.${escapeIdentifier(prop)} = $${paramName}`);
            params[paramName] = val;
          }
          if (setItems.length > 0) lines.push(`SET ${setItems.join(', ')}`);
        } else {
          const mergePattern = buildRelPattern({
            sourceVar: 'n',
            relDef,
            targetVar: 'target',
          });
          lines.push(`MERGE ${mergePattern}`);
        }
      }
    }

    return lines;
  }

  private buildDisconnects(
    disconnect: Record<string, unknown>,
    nodeDef: NodeDefinition,
    params: Record<string, unknown>,
  ): string[] {
    const lines: string[] = [];

    for (const [fieldName, spec] of Object.entries(disconnect)) {
      const relDef = nodeDef.relationships.get(fieldName);
      if (!relDef) continue;

      const targetNodeDef =
        resolveTargetDef(relDef.target, this.schema) ?? undefined;

      // Normalize spec to an array of disconnect items
      const specItems: Array<Record<string, unknown> | null | undefined> =
        Array.isArray(spec) ? spec : [spec as Record<string, unknown>];

      for (let si = 0; si < specItems.length; si++) {
        const item = specItems[si];
        const relVar = `r_${fieldName}_${si}`;

        lines.push('WITH n');

        if (
          item == null ||
          (typeof item === 'object' && Object.keys(item).length === 0)
        ) {
          // Blanket disconnect — remove all relationships of this type
          const pattern = buildRelPattern({
            sourceVar: 'n',
            relDef,
            targetVar: '',
            edgeVar: relVar,
          });
          lines.push(`OPTIONAL MATCH ${pattern}`);
          lines.push(`DELETE ${relVar}`);
        } else {
          // Specific disconnect with conditions
          const disconnectSpec = item as Record<string, unknown>;
          const whereSpec = disconnectSpec.where as
            | Record<string, unknown>
            | undefined;

          const targetVar = `target_${fieldName}_${si}`;
          const pattern = buildRelPattern({
            sourceVar: 'n',
            relDef,
            targetVar,
            edgeVar: relVar,
            targetLabel: 'auto',
          });
          lines.push(`OPTIONAL MATCH ${pattern}`);

          const conditions = this.buildConnectionWhereConditions(
            whereSpec,
            targetVar,
            `disconnect_${fieldName}_${si}`,
            params,
            targetNodeDef,
          );

          if (conditions.length > 0)
            lines.push(`WHERE ${conditions.join(' AND ')}`);

          lines.push(`DELETE ${relVar}`);
        }
      }
    }

    return lines;
  }

  /**
   * Dispatch update operations for a union-typed relationship.
   * Each member key in the input is recursed into buildUpdateRelationships
   * with a narrowed relDef pointing at the concrete member type.
   */
  private dispatchUnionUpdateOps(
    key: string,
    memberEntries: Record<string, unknown>,
    relDef: RelationshipDefinition,
    nodeDef: NodeDefinition,
    sourceVar: string,
    prefix: string,
    params: Record<string, unknown>,
    depth: number,
    ancestorVars: string[],
  ): string[] {
    const unionMembers = this.schema.unions!.get(relDef.target)!;
    const lines: string[] = [];

    for (const [memberKey, memberValue] of Object.entries(memberEntries)) {
      if (!unionMembers.includes(memberKey)) continue;
      const memberNodeDef = this.schema.nodes.get(memberKey);
      if (!memberNodeDef || memberValue == null) continue;

      const memberRelDef: RelationshipDefinition = {
        ...relDef,
        target: memberKey,
      };
      const memberItems = Array.isArray(memberValue)
        ? (memberValue as Record<string, unknown>[])
        : [memberValue as Record<string, unknown>];

      const memberNodeDef2: NodeDefinition = {
        ...nodeDef,
        relationships: new Map([[key, memberRelDef]]),
      };

      lines.push(
        ...this.buildUpdateRelationships(
          { [key]: memberItems },
          memberNodeDef2,
          sourceVar,
          `${prefix}_${key}_${memberKey}`,
          params,
          depth + 1,
          ancestorVars,
        ),
      );
    }

    return lines;
  }

  /**
   * Process nested relationship operations within an update input.
   * Handles: create, connect, disconnect, update, and arrays of these.
   */
  private buildUpdateRelationships(
    update: Record<string, unknown>,
    nodeDef: NodeDefinition,
    sourceVar: string,
    prefix: string,
    params: Record<string, unknown>,
    depth: number = 0,
    ancestorVars: string[] = [],
  ): string[] {
    if (depth > 5)
      throw new OGMError(
        `[neo4j-ogm] buildUpdateRelationships: max nesting depth (5) exceeded for prefix "${prefix}". ` +
          'Nested relationship mutations beyond depth 5 are not supported.',
      );
    const lines: string[] = [];
    let varCounter = 0;

    // All WITH clauses must carry forward ancestor vars + current source
    const allVars = [...new Set([...ancestorVars, sourceVar])];
    const withClause = `WITH ${allVars.join(', ')}`;

    for (const [key, value] of Object.entries(update)) {
      const relDef = nodeDef.relationships.get(key);
      if (!relDef || value == null) continue;

      // Union targets use per-member keys — dispatch each member recursively
      const isUnionTarget =
        !this.schema.nodes.has(relDef.target) &&
        this.schema.unions?.has(relDef.target);

      if (isUnionTarget) {
        lines.push(
          ...this.dispatchUnionUpdateOps(
            key,
            value as Record<string, unknown>,
            relDef,
            nodeDef,
            sourceVar,
            prefix,
            params,
            depth,
            ancestorVars,
          ),
        );
        continue;
      }

      const targetNodeDef = this.schema.nodes.get(relDef.target);
      if (!targetNodeDef) continue;

      const targetLabelStr = this.getCachedLabelString(targetNodeDef);
      const relPrefix = `${prefix}_${key}`;

      // Value can be an array (e.g., chapters: [{ create: ... }, { update: ... }])
      // or an object (e.g., author: { connect: ... })
      const items = Array.isArray(value)
        ? (value as Record<string, unknown>[])
        : [value as Record<string, unknown>];

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const itemPrefix = `${relPrefix}_${i}`;

        // --- delete (detach delete target nodes) ---
        // Wrapped in CALL subquery to prevent OPTIONAL MATCH from multiplying
        // pipeline rows (N existing nodes → N rows → N subsequent CREATEs).
        if (item.delete) {
          const deleteItems = Array.isArray(item.delete)
            ? (item.delete as Record<string, unknown>[])
            : [item.delete as Record<string, unknown>];

          for (let di = 0; di < deleteItems.length; di++) {
            const deleteSpec = deleteItems[di];
            const whereSpec = deleteSpec.where as
              | Record<string, unknown>
              | undefined;

            const delTarget = `${sourceVar}_del${varCounter}`;
            const delRel = `r_del_${key}_${i}_${di}`;
            varCounter++;

            lines.push(withClause);
            lines.push(`CALL {`);
            lines.push(withClause);

            const pattern = buildRelPattern({
              sourceVar,
              relDef,
              targetVar: delTarget,
              edgeVar: delRel,
              targetLabel: 'auto',
            });
            lines.push(`OPTIONAL MATCH ${pattern}`);

            if (whereSpec && Object.keys(whereSpec).length > 0) {
              const nodeWhere = (whereSpec.node ?? whereSpec) as Record<
                string,
                unknown
              >;
              // Use the same WHERE-condition builder as the disconnect /
              // connect paths so operator suffixes (_GT/_CONTAINS/_IN/etc.),
              // `NOT`, and relationship sub-filters work consistently. The
              // pre-1.7.2 inline implementation only emitted `prop = $param`
              // for every key, silently turning operator-suffixed keys
              // (`name_CONTAINS`) into property lookups against
              // non-existent fields → zero rows deleted.
              const conditions = this.buildNodeWhereConditions(
                nodeWhere,
                delTarget,
                `${itemPrefix}_del${di}`,
                params,
                targetNodeDef,
              );
              if (conditions.length > 0)
                lines.push(`WHERE ${conditions.join(' AND ')}`);
            }

            lines.push(`DETACH DELETE ${delTarget}`);
            lines.push(`RETURN count(*) AS _del_${key}_${i}_${di}`);
            lines.push(`}`);
          }
        }

        // --- create ---
        if (item.create) {
          const createItems = Array.isArray(item.create)
            ? (item.create as Record<string, unknown>[])
            : [item.create as Record<string, unknown>];

          for (let ci = 0; ci < createItems.length; ci++) {
            const createSpec = createItems[ci];
            const nodeSpec = (createSpec.node ?? createSpec) as Record<
              string,
              unknown
            >;

            const createVar = `${sourceVar}_cr${varCounter}`;
            varCounter++;

            const { propString, propParams } = this.buildCreateProperties(
              nodeSpec,
              targetNodeDef,
              `${itemPrefix}_create${ci}`,
            );

            // Handle nested relationship creates within the created node
            const nestedRelLines = this.buildCreateRelationships(
              nodeSpec,
              targetNodeDef,
              createVar,
              `${itemPrefix}_create${ci}`,
              params,
              allVars,
            );

            const propsClause =
              propString.length > 0
                ? ` { ${propString} }`
                : ` { ${this.buildGeneratedIdClause(targetNodeDef)} }`;

            const relPattern = buildRelPattern({
              sourceVar,
              relDef,
              targetVar: createVar,
            });

            // Wrap in CALL subquery so failed connect MATCHes don't kill the outer pipeline
            const hasNestedOps = nestedRelLines.length > 0;
            if (hasNestedOps) {
              lines.push(withClause);
              lines.push(`CALL {`);
              lines.push(withClause);
            } else lines.push(withClause);

            lines.push(`CREATE (${createVar}:${targetLabelStr}${propsClause})`);
            mergeParams(params, propParams);
            lines.push(`CREATE ${relPattern}`);

            if (hasNestedOps) {
              lines.push(...nestedRelLines);
              lines.push(`RETURN count(*) AS _cc_${key}_${ci}`);
              lines.push(`}`);
            }
          }
        }

        // --- disconnect (runs before connect so "disconnect all + connect new" works) ---
        if (item.disconnect) {
          const disconnectItems = Array.isArray(item.disconnect)
            ? (item.disconnect as Record<string, unknown>[])
            : [item.disconnect as Record<string, unknown>];

          for (let di = 0; di < disconnectItems.length; di++) {
            const disconnectSpec = disconnectItems[di];
            const whereSpec = disconnectSpec.where as
              | Record<string, unknown>
              | undefined;

            const relVar = `r_disc_${key}_${i}_${di}`;

            lines.push(withClause);

            if (!whereSpec || Object.keys(whereSpec).length === 0) {
              const pattern = buildRelPattern({
                sourceVar,
                relDef,
                targetVar: '',
                edgeVar: relVar,
              });
              lines.push(`OPTIONAL MATCH ${pattern}`);
              lines.push(`DELETE ${relVar}`);
            } else {
              const nodeWhere = (whereSpec.node ?? whereSpec) as Record<
                string,
                unknown
              >;
              const discTarget = `${sourceVar}_disc${varCounter}`;
              varCounter++;

              const pattern = buildRelPattern({
                sourceVar,
                relDef,
                targetVar: discTarget,
                edgeVar: relVar,
                targetLabel: 'auto',
              });
              lines.push(`OPTIONAL MATCH ${pattern}`);

              const conditions = this.buildNodeWhereConditions(
                nodeWhere,
                discTarget,
                `${itemPrefix}_disc_${di}`,
                params,
                targetNodeDef,
              );

              if (conditions.length > 0)
                lines.push(`WHERE ${conditions.join(' AND ')}`);

              lines.push(`DELETE ${relVar}`);
            }
          }
        }

        // --- connect ---
        if (item.connect) {
          const connectItems = Array.isArray(item.connect)
            ? (item.connect as Record<string, unknown>[])
            : [item.connect as Record<string, unknown>];

          for (let ci = 0; ci < connectItems.length; ci++) {
            const connectSpec = connectItems[ci];
            const whereSpec = connectSpec.where as
              | Record<string, unknown>
              | undefined;
            const nodeWhere = (whereSpec?.node ?? whereSpec ?? {}) as Record<
              string,
              unknown
            >;
            const edgeInput = connectSpec.edge as
              | Record<string, unknown>
              | undefined;

            // Wrap in CALL subquery so a failed MATCH doesn't kill the outer pipeline
            lines.push(withClause);
            lines.push(`CALL {`);
            lines.push(withClause);

            const connectVar = `${sourceVar}_conn${varCounter}`;
            varCounter++;

            lines.push(`MATCH (${connectVar}:${targetLabelStr})`);

            const conditions = this.buildNodeWhereConditions(
              nodeWhere,
              connectVar,
              `${itemPrefix}_conn${ci}`,
              params,
              targetNodeDef,
            );
            if (conditions.length > 0)
              lines.push(`WHERE ${conditions.join(' AND ')}`);

            if (edgeInput && Object.keys(edgeInput).length > 0) {
              // Use bare target var (no label) since connectVar is already bound by MATCH
              const relVar = `r_conn_${key}_${ci}`;
              assertSafeIdentifier(relDef.type, 'relationship type');
              const escapedRelType = escapeIdentifier(relDef.type);
              const mergePattern =
                relDef.direction === 'OUT'
                  ? `(${sourceVar})-[${relVar}:${escapedRelType}]->(${connectVar})`
                  : `(${sourceVar})<-[${relVar}:${escapedRelType}]-(${connectVar})`;
              lines.push(`MERGE ${mergePattern}`);
              const setItems: string[] = [];
              for (const [prop, val] of Object.entries(edgeInput)) {
                if (val === undefined) continue;
                assertSafeIdentifier(prop, 'edge property');
                const paramName = `${itemPrefix}_conn${ci}_edge_${prop}`;
                setItems.push(
                  `r_conn_${key}_${ci}.${escapeIdentifier(prop)} = $${paramName}`,
                );
                params[paramName] = val;
              }
              if (setItems.length > 0) lines.push(`SET ${setItems.join(', ')}`);
            } else {
              const relPattern = buildRelPattern({
                sourceVar,
                relDef,
                targetVar: connectVar,
              });
              lines.push(`MERGE ${relPattern}`);
            }

            lines.push(`RETURN count(*) AS _cn_${key}_${ci}`);
            lines.push(`}`);
          }
        }

        // --- update (nested) ---
        if (item.update) {
          const updateSpec = item.update as Record<string, unknown>;
          const edgeUpdate = updateSpec.edge as
            | Record<string, unknown>
            | undefined;
          const nodeUpdate = (updateSpec.node ??
            (edgeUpdate ? {} : updateSpec)) as Record<string, unknown>;
          const updateWhere = item.where as Record<string, unknown> | undefined;

          const updateVar = `${sourceVar}_u${varCounter}`;
          const relVar = `r_${key}_${i}`;
          varCounter++;

          // Pre-compute SET clauses for node properties
          const setClauses: string[] = [];
          const setParams: Record<string, unknown> = {};
          for (const [prop, val] of Object.entries(nodeUpdate)) {
            if (targetNodeDef.relationships.has(prop)) continue;
            if (val === undefined) continue;
            assertSafeIdentifier(prop, 'nested update property');
            const paramName = `${itemPrefix}_set_${prop}`;
            setClauses.push(
              `${updateVar}.${escapeIdentifier(prop)} = $${paramName}`,
            );
            setParams[paramName] = val;
          }

          // Pre-compute SET clauses for edge (relationship) properties
          const edgeClauses: string[] = [];
          const edgeParams: Record<string, unknown> = {};
          if (edgeUpdate)
            for (const [prop, val] of Object.entries(edgeUpdate)) {
              if (val === undefined) continue;
              assertSafeIdentifier(prop, 'edge update property');
              const paramName = `${itemPrefix}_edge_${prop}`;
              edgeClauses.push(
                `${relVar}.${escapeIdentifier(prop)} = $${paramName}`,
              );
              edgeParams[paramName] = val;
            }

          // Pre-compute nested relationship operations
          const nestedParams: Record<string, unknown> = {};
          const nestedRelLines = this.buildUpdateRelationships(
            nodeUpdate,
            targetNodeDef,
            updateVar,
            itemPrefix,
            nestedParams,
            depth + 1,
            allVars,
          );

          // Only emit the MATCH block if there's actual work to do
          const hasWork =
            setClauses.length > 0 ||
            edgeClauses.length > 0 ||
            nestedRelLines.length > 0;
          if (hasWork) {
            // Wrap in CALL subquery so a failed MATCH doesn't kill the outer pipeline.
            // RETURN count(*) ensures exactly 1 row is returned even if MATCH finds nothing.
            // WITH is required before CALL (Neo4j syntax rule after CREATE/DELETE/SET).
            lines.push(withClause);
            lines.push(`CALL {`);
            lines.push(withClause);

            const relArrow = buildRelPattern({
              sourceVar,
              relDef,
              targetVar: updateVar,
              edgeVar: relVar,
              targetLabel: 'auto',
            });
            lines.push(`MATCH ${relArrow}`);

            // WHERE on the target
            if (updateWhere) {
              const nodeWhere = (updateWhere.node ?? updateWhere) as Record<
                string,
                unknown
              >;
              const conditions: string[] = [];
              for (const [prop, val] of Object.entries(nodeWhere)) {
                assertSafeIdentifier(prop, 'update where property');
                const paramName = `${itemPrefix}_where_${prop}`;
                conditions.push(
                  `${updateVar}.${escapeIdentifier(prop)} = $${paramName}`,
                );
                params[paramName] = val;
              }
              if (conditions.length > 0)
                lines.push(`WHERE ${conditions.join(' AND ')}`);
            }

            if (setClauses.length > 0)
              lines.push(`SET ${setClauses.join(', ')}`);
            mergeParams(params, setParams);

            if (edgeClauses.length > 0)
              lines.push(`SET ${edgeClauses.join(', ')}`);
            mergeParams(params, edgeParams);

            mergeParams(params, nestedParams);
            lines.push(...nestedRelLines);

            lines.push(`RETURN count(*) AS _uc_${key}_${i}`);
            lines.push(`}`);
          }
        }
      }
    }

    return lines;
  }

  /**
   * Operator suffixes supported in connect/disconnect WHERE conditions.
   * Maps suffix → Cypher operator template (use %v for variable, %p for param).
   */
  private static readonly OPERATOR_SUFFIXES: [string, string][] = [
    ['_NOT_IN', 'NOT %v IN $%p'],
    ['_IN', '%v IN $%p'],
    ['_NOT_CONTAINS', 'NOT %v CONTAINS $%p'],
    ['_CONTAINS', '%v CONTAINS $%p'],
    ['_NOT_STARTS_WITH', 'NOT %v STARTS WITH $%p'],
    ['_STARTS_WITH', '%v STARTS WITH $%p'],
    ['_NOT_ENDS_WITH', 'NOT %v ENDS WITH $%p'],
    ['_ENDS_WITH', '%v ENDS WITH $%p'],
    ['_LTE', '%v <= $%p'],
    ['_LT', '%v < $%p'],
    ['_GTE', '%v >= $%p'],
    ['_GT', '%v > $%p'],
    ['_NOT', '%v <> $%p'],
  ];

  /**
   * Parse a property key that may contain an operator suffix (e.g. `id_IN`, `name_CONTAINS`).
   * Returns the base property name and the Cypher expression template.
   */
  private parseOperatorSuffix(key: string): {
    baseProp: string;
    template: string;
  } {
    for (const [suffix, template] of MutationCompiler.OPERATOR_SUFFIXES)
      if (key.endsWith(suffix))
        return { baseProp: key.slice(0, -suffix.length), template };

    // No suffix — simple equality
    return { baseProp: key, template: '%v = $%p' };
  }

  /**
   * Build WHERE conditions for connect/disconnect operations.
   * Handles operator suffixes (_IN, _NOT, _NOT_IN, _CONTAINS, etc.),
   * NOT blocks, and relationship filters (_SOME, _NONE, _ALL, _SINGLE).
   *
   * @param targetNodeDef - Optional node definition for the target node.
   *   Required to resolve relationship filters like `configurations_SOME`.
   *   When omitted, relationship filters are silently skipped.
   */
  private buildNodeWhereConditions(
    nodeWhere: Record<string, unknown>,
    targetVar: string,
    prefix: string,
    params: Record<string, unknown>,
    targetNodeDef?: NodeDefinition,
  ): string[] {
    const conditions: string[] = [];

    for (const [prop, val] of Object.entries(nodeWhere))
      if (prop === 'NOT') {
        const notSpec = val as Record<string, unknown>;
        for (const [notProp, notVal] of Object.entries(notSpec)) {
          const { baseProp, template } = this.parseOperatorSuffix(notProp);
          assertSafeIdentifier(baseProp, 'where property');
          const paramName = `${prefix}_NOT_${notProp}`;
          const escapedProp = escapeIdentifier(baseProp);
          let expr: string;
          if (template === '%v = $%p')
            // Simple equality → negate to <>
            expr = `${targetVar}.${escapedProp} <> $${paramName}`;
          else {
            // Operator suffix — wrap with NOT if not already negated
            const resolved = template
              .replace('%v', `${targetVar}.${escapedProp}`)
              .replace('$%p', `$${paramName}`);
            expr = resolved.startsWith('NOT ') ? resolved : `NOT ${resolved}`;
          }
          conditions.push(expr);
          params[paramName] = notVal;
        }
      } else {
        // Check for relationship filter suffixes (_SOME, _NONE, _ALL, _SINGLE)
        const relFilter = this.tryBuildRelationshipFilter(
          prop,
          val,
          targetVar,
          prefix,
          params,
          targetNodeDef,
        );
        if (relFilter) {
          conditions.push(relFilter);
          continue;
        }

        const { baseProp, template } = this.parseOperatorSuffix(prop);
        assertSafeIdentifier(baseProp, 'where property');
        const paramName = `${prefix}_${prop}`;
        conditions.push(
          template
            .replace('%v', `${targetVar}.${escapeIdentifier(baseProp)}`)
            .replace('$%p', `$${paramName}`),
        );
        params[paramName] = val;
      }

    return conditions;
  }

  /**
   * Build WHERE conditions from a connection-level WHERE spec.
   * Handles `node`, `NOT`, `AND`, `OR` at the connection level.
   *
   * Connection WHERE format: `{ node: {...}, NOT: { node: {...} }, AND: [...], OR: [...] }`
   */
  private buildConnectionWhereConditions(
    whereSpec: Record<string, unknown> | undefined,
    targetVar: string,
    prefix: string,
    params: Record<string, unknown>,
    targetNodeDef?: NodeDefinition,
  ): string[] {
    if (!whereSpec || Object.keys(whereSpec).length === 0) return [];

    const conditions: string[] = [];

    // Direct node conditions
    if (whereSpec.node) {
      const nodeConditions = this.buildNodeWhereConditions(
        whereSpec.node as Record<string, unknown>,
        targetVar,
        prefix,
        params,
        targetNodeDef,
      );
      conditions.push(...nodeConditions);
    }

    // NOT wrapper — negate the inner connection conditions
    if (whereSpec.NOT) {
      const notSpec = whereSpec.NOT as Record<string, unknown>;
      const innerConditions = this.buildConnectionWhereConditions(
        notSpec,
        targetVar,
        `${prefix}_NOT`,
        params,
        targetNodeDef,
      );
      if (innerConditions.length > 0)
        conditions.push(`NOT (${innerConditions.join(' AND ')})`);
    }

    // AND — all sub-conditions must hold
    if (Array.isArray(whereSpec.AND))
      for (let i = 0; i < whereSpec.AND.length; i++) {
        const sub = this.buildConnectionWhereConditions(
          whereSpec.AND[i] as Record<string, unknown>,
          targetVar,
          `${prefix}_AND${i}`,
          params,
          targetNodeDef,
        );
        conditions.push(...sub);
      }

    // OR — any sub-condition must hold
    if (Array.isArray(whereSpec.OR)) {
      const orClauses: string[] = [];
      for (let i = 0; i < whereSpec.OR.length; i++) {
        const sub = this.buildConnectionWhereConditions(
          whereSpec.OR[i] as Record<string, unknown>,
          targetVar,
          `${prefix}_OR${i}`,
          params,
          targetNodeDef,
        );
        if (sub.length > 0) orClauses.push(`(${sub.join(' AND ')})`);
      }
      if (orClauses.length > 0) conditions.push(`(${orClauses.join(' OR ')})`);
    }

    // Fallback: if no recognized keys, treat the whole spec as node conditions
    // (backward compatibility for simple `{ id: '...' }` style)
    if (!whereSpec.node && !whereSpec.NOT && !whereSpec.AND && !whereSpec.OR) {
      // Reject unsupported connection WHERE keys (e.g., "edge")
      if (whereSpec.edge !== undefined)
        throw new OGMError(
          `Connection WHERE with "edge" filters is not supported in mutations. ` +
            `Only "node", "NOT", "AND", "OR" keys or direct property conditions are allowed.`,
        );

      const fallbackConditions = this.buildNodeWhereConditions(
        whereSpec,
        targetVar,
        prefix,
        params,
        targetNodeDef,
      );
      conditions.push(...fallbackConditions);
    }

    return conditions;
  }

  /** Counter for unique relationship filter variables within a single WHERE clause. */
  private relFilterCounter = 0;

  /**
   * Try to compile a relationship filter condition (_SOME, _NONE, _ALL, _SINGLE).
   * Returns the Cypher expression string or null if the key is not a relationship filter.
   */
  private tryBuildRelationshipFilter(
    key: string,
    value: unknown,
    nodeVar: string,
    prefix: string,
    params: Record<string, unknown>,
    targetNodeDef?: NodeDefinition,
  ): string | null {
    if (!targetNodeDef || typeof value !== 'object' || value === null)
      return null;

    // Detect suffix and extract field name
    let suffix: RelationshipSuffix | null = null;
    let fieldName = '';
    for (const s of RELATIONSHIP_SUFFIXES)
      if (key.endsWith(s)) {
        suffix = s;
        fieldName = key.slice(0, -s.length);
        break;
      }

    // If no suffix, check if bare key is a relationship (defaults to _SOME)
    if (!suffix) {
      const relDef = targetNodeDef.relationships.get(key);
      if (!relDef) return null;
      suffix = '_SOME';
      fieldName = key;
    }

    const relDef = targetNodeDef.relationships.get(fieldName);
    if (!relDef) return null;

    const relTargetDef = resolveTargetDef(relDef.target, this.schema);
    if (!relTargetDef) return null;

    const relVar = `rf${this.relFilterCounter++}`;
    const innerWhere = value as Record<string, unknown>;

    // Build the MATCH pattern
    const edgePart = `[:${escapeIdentifier(relDef.type)}]`;
    const escapedTarget = escapeIdentifier(relDef.target);
    const pattern =
      relDef.direction === 'IN'
        ? `(${nodeVar})<-${edgePart}-(${relVar}:${escapedTarget})`
        : `(${nodeVar})-${edgePart}->(${relVar}:${escapedTarget})`;

    // Recursively compile inner conditions
    const innerConditions = this.buildNodeWhereConditions(
      innerWhere,
      relVar,
      `${prefix}_${fieldName}`,
      params,
      relTargetDef,
    );
    const innerClause =
      innerConditions.length > 0
        ? ` WHERE ${innerConditions.join(' AND ')}`
        : '';

    switch (suffix) {
      case '_SOME':
        return `EXISTS { MATCH ${pattern}${innerClause} }`;

      case '_NONE':
        return `NOT EXISTS { MATCH ${pattern}${innerClause} }`;

      case '_ALL':
        // Double negation: all match ≡ none fail to match
        if (!innerClause) return '';
        return `NOT EXISTS { MATCH ${pattern} WHERE NOT (${innerConditions.join(' AND ')}) }`;

      case '_SINGLE':
        return `size([${relVar} IN [(${pattern}${innerClause} | ${relVar})] | ${relVar}]) = 1`;

      default:
        return null;
    }
  }

  private buildGeneratedIdClause(nodeDef: NodeDefinition): string {
    const parts: string[] = [];
    for (const [, propDef] of nodeDef.properties)
      if (propDef.isGenerated)
        parts.push(`${escapeIdentifier(propDef.name)}: randomUUID()`);

    return parts.join(', ');
  }

  /**
   * Check if any item in an array connect spec has relationship filters in its WHERE clause.
   * Relationship filters require EXISTS subqueries which can't use UNWIND param references.
   */
  private arrayConnectHasRelationshipFilters(
    items: Record<string, unknown>[],
    targetNodeDef: NodeDefinition,
  ): boolean {
    for (const item of items) {
      const whereSpec = item.where as Record<string, unknown> | undefined;
      if (!whereSpec) continue;
      const nodeWhere = (whereSpec.node ?? whereSpec) as Record<
        string,
        unknown
      >;
      for (const key of Object.keys(nodeWhere)) {
        // Strip operator suffixes to get the base field name
        let fieldName = key;
        for (const s of RELATIONSHIP_SUFFIXES)
          if (key.endsWith(s)) {
            fieldName = key.slice(0, -s.length);
            break;
          }

        // If the base field name is a relationship on the target, it's a rel filter
        if (targetNodeDef.relationships.has(fieldName)) return true;
        // Also check if the value is an object (nested filter on a relationship)
        const val = nodeWhere[key];
        if (
          typeof val === 'object' &&
          val !== null &&
          !Array.isArray(val) &&
          targetNodeDef.relationships.has(key)
        )
          return true;
      }
    }
    return false;
  }

  private extractConnectWhereConditions(
    item: Record<string, unknown>,
    targetVar: string,
    itemVar: string,
  ): string[] {
    const conditions: string[] = [];
    const whereSpec = item.where as Record<string, unknown> | undefined;
    if (!whereSpec) return conditions;

    const nodeWhere = (whereSpec.node ?? whereSpec) as Record<string, unknown>;
    for (const key of Object.keys(nodeWhere)) {
      const { baseProp, template } = this.parseOperatorSuffix(key);
      assertSafeIdentifier(baseProp, 'connect where property');
      // Replace template placeholders with dynamic UNWIND references
      // Note: itemVar map access is NOT escaped (parameter map keys, not Cypher identifiers)
      const valueRef = `${itemVar}.where.node.${key}`;
      conditions.push(
        template
          .replace('%v', `${targetVar}.${escapeIdentifier(baseProp)}`)
          .replace('$%p', valueRef),
      );
    }

    return conditions;
  }

  private extractEdgeProperties(item: Record<string, unknown>): string[] {
    const edgeSpec = item.edge as Record<string, unknown> | undefined;
    if (!edgeSpec) return [];
    const keys = Object.keys(edgeSpec).filter((k) => edgeSpec[k] !== undefined);
    for (const key of keys) assertSafeIdentifier(key, 'edge property');

    return keys;
  }
}

/**
 * Build a stable signature for a `connect` array item — the set of keys
 * inside `where.node` (or `where` directly for the legacy bare-object
 * shape) PLUS the set of keys inside `edge`. Used by the UNWIND fast
 * path to validate that every item shares the same shape; mismatched
 * shapes silently drop keys from the compiled WHERE / SET.
 */
function computeConnectItemSignature(item: Record<string, unknown>): string {
  const where = item.where as Record<string, unknown> | undefined;
  const nodeWhere = (where?.node ?? where ?? {}) as Record<string, unknown>;
  const edge = (item.edge ?? {}) as Record<string, unknown>;

  const nodeKeys = Object.keys(nodeWhere)
    .filter((k) => nodeWhere[k] !== undefined)
    .sort()
    .join(',');
  const edgeKeys = Object.keys(edge)
    .filter((k) => edge[k] !== undefined)
    .sort()
    .join(',');

  return `node:[${nodeKeys}]|edge:[${edgeKeys}]`;
}

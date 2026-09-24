import { OGMError } from '../errors';
import type { OGMLogger } from '../execution/executor';
import { PolicyDeniedError } from '../policy/errors';
import { NO_ROOT_POLICY } from '../policy/types';
import type { PolicyContextBundle } from '../policy/types';
import {
  NodeDefinition,
  PropertyDefinition,
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
  assertSafePropertyName,
  escapeIdentifier,
  isPlainObject,
  mergeParams,
} from '../utils/validation';
import {
  coerceWriteValue,
  resolveDefaultWriteValue,
  wrapListItemExpr,
  wrapWhereParam,
  wrapWriteExpr,
} from '../utils/write-coercion';
import { WhereCompiler } from './where.compiler';

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

  private logger?: OGMLogger;

  /**
   * WhereCompiler used ONLY to compile a relationship TARGET type's
   * `read` policy predicate for connect/disconnect target MATCHes,
   * mirroring the read paths (`WhereCompiler`/`SelectionCompiler`).
   * Injected by the OGM so it shares the user's compiler options;
   * lazily constructed with default options otherwise.
   */
  private policyWhereCompiler?: WhereCompiler;

  constructor(
    private schema: SchemaMetadata,
    options?: { logger?: OGMLogger; whereCompiler?: WhereCompiler },
  ) {
    this.logger = options?.logger;
    this.policyWhereCompiler = options?.whereCompiler;
  }

  /**
   * Resolve and compile the TARGET type's `read` policy predicate for a
   * connect/disconnect target MATCH, mirroring the read path
   * (`WhereCompiler.buildTargetBundle` + `WhereCompiler.compile`). You
   * must be allowed to SEE a node to link/unlink it, so linking to an
   * unreadable node is the IDOR this closes; the codebase models the
   * row-level write gate for `update`/`delete` targets as `read`
   * ReadRestrictive policies (see policy/types.ts), so `read` is both
   * necessary and the semantically correct operation here.
   *
   * Returns `null` — leaving the emitted Cypher BYTE-IDENTICAL — when:
   *   - no policy context is threaded (no policy bound / bypass active), OR
   *   - no `paramCounter` is available to allocate policy params, OR
   *   - the target type has no policy applicable to `read`, OR
   *   - the resolved policy is `overridden` (compiles to nothing).
   *
   * When a target policy resolves, the compiled predicate is returned and
   * its bound params are merged into `params`. Policy params use the
   * shared `paramCounter` (`param<N>`), continuing the sequence started by
   * the top-level WHERE, so they can never collide with the
   * connect/disconnect `where` params (prefix-named, e.g.
   * `connect_<field>_<prop>`) or the selection's params (allocated later
   * from the same counter).
   */
  private buildTargetPolicyPredicate(
    targetNodeDef: NodeDefinition,
    targetVar: string,
    params: Record<string, unknown>,
    policyContext: PolicyContextBundle | undefined,
    paramCounter: { count: number } | undefined,
    /**
     * Operation whose policy gates the target (v2.3.0): `read` for
     * connect/disconnect (you must see a node to link it), `update` for a
     * nested update, `delete` for nested/cascade deletes — exactly what the
     * equivalent DIRECT write on the target type enforces.
     */
    op: 'read' | 'update' | 'delete' = 'read',
  ): string | null {
    if (!policyContext) return null;
    // v2.3.0 — a missing counter must never mean a missing policy.
    const counter = paramCounter ?? counterAfter(params);

    // Mirror the direct write's compile-time default-deny: a direct
    // update/delete with `onDeny: 'throw'` and no applicable permissive
    // throws before running, so the nested equivalent must too. (Connect/
    // disconnect keep their pre-2.3.0 `read` semantics: compile to false.)
    if (op !== 'read' && policyContext.defaults.onDeny === 'throw') {
      const resolved = policyContext.resolveForType(targetNodeDef.typeName, op);
      if (resolved && !resolved.overridden && resolved.permissives.length === 0)
        throw new PolicyDeniedError({
          typeName: targetNodeDef.typeName,
          operation: op,
          reason: 'no-permissive-matched',
        });
    }

    // Abstract (interface / union) targets get a CASE over their concrete
    // members' own clauses — pre-2.3.0 only the abstract type's own
    // policies (usually none) were applied.
    const clause = this.getPolicyWhereCompiler().compileTargetPolicyClause(
      targetNodeDef.typeName,
      targetVar,
      op,
      policyContext,
      counter,
    );

    if (clause.preludes.length > 0)
      throw new OGMError(
        `Policy on "${targetNodeDef.typeName}" requires @cypher field ` +
          `projection, which is not supported inside nested mutation ` +
          `target filters. Refactor the policy to use stored properties.`,
      );

    if (!clause.cypher) return null;
    mergeParams(params, clause.params);
    return clause.cypher;
  }

  private getPolicyWhereCompiler(): WhereCompiler {
    // Inherit the logger: since v2.3.0 this compiler also compiles every
    // nested-write `where`, and its empty-AND/OR warnings must surface.
    if (!this.policyWhereCompiler)
      this.policyWhereCompiler = new WhereCompiler(this.schema, {
        logger: this.logger,
      });
    return this.policyWhereCompiler;
  }

  /**
   * Compile a nested-write `where` (connect, disconnect, nested update,
   * nested/cascade delete) against `targetVar` through `WhereCompiler` —
   * the single where implementation (v2.3.0: the mutation compiler's
   * parallel builder was removed after repeatedly drifting from it).
   * Operators, null semantics, abstract relationship targets and —
   * crucially — traversal-policy enforcement are identical to a direct
   * `where`: a relationship filter inside it AND-stitches the traversed
   * type's `read` policy. The target's OWN operation policy is added
   * separately by `buildTargetPolicyPredicate`, so the root here is bound
   * as `NO_ROOT_POLICY`.
   *
   * Returns `''` for an absent or empty where.
   */
  private compileTargetWhere(
    whereSpec: Record<string, unknown> | undefined,
    targetVar: string,
    targetNodeDef: NodeDefinition,
    params: Record<string, unknown>,
    policyContext: PolicyContextBundle | undefined,
    paramCounter: { count: number } | undefined,
  ): string {
    if (!whereSpec || Object.keys(whereSpec).length === 0) return '';
    const counter = paramCounter ?? counterAfter(params);
    const nodeWhere = connectionWhereToNodeWhere(whereSpec);
    const traversalBundle: PolicyContextBundle | undefined = policyContext
      ? { ...policyContext, operation: 'read', resolved: NO_ROOT_POLICY }
      : undefined;
    const compiled = this.getPolicyWhereCompiler().compile(
      nodeWhere,
      targetVar,
      targetNodeDef,
      counter,
      traversalBundle ? { policyContext: traversalBundle } : undefined,
    );
    if (compiled.preludes && compiled.preludes.length > 0)
      throw new OGMError(
        `Filtering a nested mutation target of type "${targetNodeDef.typeName}" ` +
          `by an @cypher field is not supported. Use stored properties in ` +
          `nested connect/disconnect/update/delete filters.`,
      );
    mergeParams(params, compiled.params);
    return compiled.cypher;
  }

  /**
   * The bulk-connect UNWIND fast path compiles each where key against the
   * ROW's own value (`connItem.where.node.<key>`), which `WhereCompiler`
   * cannot express. It is therefore restricted to the one shape where
   * that is exact: every item's where is `{ node: { … } }` or bare
   * properties, holding only declared, stored scalar properties of the
   * target (registered operators allowed) with NON-NULL values — no
   * `AND`/`OR`/`NOT`/`node_NOT`, no relationship traversal, no `@cypher`
   * field. Every predicate it emits is then a scalar comparison against a
   * concrete row value, so it can only narrow matches, never fail open.
   * Anything else takes the per-item path through `WhereCompiler`.
   */
  private isConnectFastPathEligible(
    items: Record<string, unknown>[],
    targetNodeDef: NodeDefinition,
  ): boolean {
    for (const item of items) {
      const where = item.where;
      if (where === undefined) continue;
      if (!isPlainObject(where)) return false;
      const keys = Object.keys(where).filter((k) => where[k] !== undefined);
      let nodeWhere: Record<string, unknown>;
      if (keys.some((k) => CONNECTION_WHERE_KEYS.has(k))) {
        if (keys.length !== 1 || keys[0] !== 'node') return false;
        if (!isPlainObject(where.node)) return false;
        nodeWhere = where.node;
      } else nodeWhere = where;

      for (const [key, val] of Object.entries(nodeWhere)) {
        if (val === undefined || val === null) return false;
        if (isPlainObject(val)) return false;
        const { baseProp } = this.parseOperatorSuffix(key);
        const propDef = targetNodeDef.properties.get(baseProp);
        if (!propDef || propDef.isCypher) return false;
      }
    }
    return true;
  }

  /**
   * Surface a logical operator that contributed zero effective conditions.
   * Mirrors WhereCompiler.warnEmptyLogical — fires only on the anomalous
   * branch, so the hot path pays nothing.
   */
  private warnEmptyLogical(op: 'AND' | 'OR', context: string): void {
    this.logger?.warn?.(
      op === 'OR'
        ? `[OGM] ${context}.OR has zero effective conditions — compiled to \`false\` (matches nothing, per Prisma semantics). Omit the OR key to match everything.`
        : `[OGM] ${context}.AND has zero effective conditions — no filter emitted (matches everything).`,
    );
  }

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
    /**
     * The caller's `create` bundle (v2.3.0). Its `resolveForType` gates
     * every connect target in the nested input by the TARGET type's `read`
     * policy — pre-2.3.0 the create path threaded no policy at all.
     */
    policyContext?: PolicyContextBundle,
    /**
     * Shared `param<N>` counter; continue it into the RETURN selection so
     * nested-filter params never collide with the selection's.
     */
    paramCounter?: { count: number },
  ): MutationResult {
    const counter = paramCounter ?? { count: 0 };
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
        policyContext,
        counter,
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
    /**
     * The caller's resolved policy bundle for this mutation (the SOURCE
     * type's `update` bundle). Its `resolveForType` is used to resolve
     * each connect/disconnect TARGET type's `read` policy. `undefined`
     * when no policy is bound or a bypass is active — in which case the
     * emitted Cypher is byte-identical to before this enforcement.
     */
    policyContext?: PolicyContextBundle,
    /**
     * Shared `param<N>` counter, continued from the top-level WHERE
     * compile so target-policy params never collide with connect/
     * disconnect `where` params or the selection's params.
     */
    paramCounter?: { count: number },
  ): MutationResult {
    const labelStr = this.getCachedLabelString(nodeDef);

    const lines: string[] = [];
    const params: Record<string, unknown> = { ...whereResult.params };
    // Continue after the root WHERE's params when the caller threads no
    // counter, so nested filters can never collide with them.
    const counter = paramCounter ?? counterAfter(whereResult.params);

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
        assertSafePropertyName(key, 'update property');
        const propDef = nodeDef.properties.get(key);
        const paramName = `update_${key}`;
        const valueExpr = wrapWriteExpr(`$${paramName}`, value, propDef);
        setClauses.push(`n.${escapeIdentifier(key)} = ${valueExpr}`);
        params[paramName] = coerceWriteValue(value, propDef);
      }
      if (setClauses.length > 0) lines.push(`SET ${setClauses.join(', ')}`);

      // Process nested relationship operations within update body
      const relLines = this.buildUpdateRelationships(
        update,
        nodeDef,
        'n',
        'update',
        params,
        0,
        [],
        policyContext,
        counter,
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
        policyContext,
        counter,
      );
      lines.push(...disconnectLines);
    }

    // Connect relationships (top-level)
    if (connect) {
      const connectLines = this.buildConnects(
        connect,
        nodeDef,
        params,
        policyContext,
        counter,
      );
      lines.push(...connectLines);
    }

    lines.push(
      returnMode === 'count' ? 'RETURN count(n) AS count' : 'RETURN n',
    );

    return { cypher: lines.join('\n'), params };
  }

  /**
   * Generate DELETE Cypher with optional cascade.
   *
   * v2.3.0 — each cascaded relationship honours its per-item `where` and
   * is gated by the TARGET type's `delete` policy (`buildNestedDelete`).
   * Pre-2.3.0 the cascade iterated only the relationship KEYS: the
   * documented `{ where }` was ignored, so every related node — shared
   * ones included — was deleted, with no policy check.
   */
  compileDelete(
    nodeDef: NodeDefinition,
    whereResult: {
      cypher: string;
      params: Record<string, unknown>;
      preludes?: string[];
    },
    deleteInput?: Record<string, unknown>,
    /** The caller's `delete` bundle; gates each cascade target. */
    policyContext?: PolicyContextBundle,
    /** Shared `param<N>` counter, continued from the root WHERE. */
    paramCounter?: { count: number },
  ): MutationResult {
    const labelStr = this.getCachedLabelString(nodeDef);

    const lines: string[] = [];
    const params: Record<string, unknown> = { ...whereResult.params };
    const counter = paramCounter ?? counterAfter(whereResult.params);

    lines.push(`MATCH (n:${labelStr})`);
    if (whereResult.preludes && whereResult.preludes.length > 0)
      lines.push(...whereResult.preludes);
    if (whereResult.cypher) lines.push(`WHERE ${whereResult.cypher}`);

    if (deleteInput && Object.keys(deleteInput).length > 0) {
      let varCounter = 0;
      for (const [fieldName, spec] of Object.entries(deleteInput)) {
        if (spec === undefined) continue;
        const relDef = nodeDef.relationships.get(fieldName);
        if (!relDef)
          throw new OGMError(
            `Unknown relationship "${fieldName}" in the delete input of ${nodeDef.typeName}.`,
          );
        const targetNodeDef = resolveTargetDef(relDef.target, this.schema);
        if (!targetNodeDef)
          throw new OGMError(
            `Cannot resolve the target type "${relDef.target}" of relationship "${fieldName}".`,
          );
        lines.push(
          ...this.buildNestedDelete({
            spec,
            relDef,
            sourceVar: 'n',
            withClause: 'WITH n',
            targetNodeDef,
            nextVar: () => `cascade_${varCounter++}`,
            tag: fieldName,
            params,
            policyContext,
            paramCounter: counter,
          }),
        );
      }
    }
    lines.push('DETACH DELETE n');

    return { cypher: lines.join('\n'), params };
  }

  /**
   * Nested / cascade delete of ONE relationship's targets (v2.3.0), shared
   * by `compileDelete` (`Model.delete`'s `delete` input) and delete-inside-
   * `update`. One subquery per spec item:
   *
   *   <withClause>
   *   CALL {
   *     <withClause>
   *     MATCH (src)-[:REL]->(t)
   *     WHERE <item.where via WhereCompiler> AND <target `delete` policy>
   *     DETACH DELETE t
   *     RETURN count(*) AS _del_<tag>_<i>
   *   }
   *
   * `spec` is one item or an array (singular vs list relationships);
   * `null` means "no cascade" (GraphQL InputMaybe). `{}` / no `where`
   * deletes every related node the target's `delete` policy permits.
   * A multi-level cascade (`delete` inside an item) and unknown item keys
   * are rejected instead of silently ignored.
   */
  private buildNestedDelete(args: {
    spec: unknown;
    relDef: RelationshipDefinition;
    sourceVar: string;
    withClause: string;
    targetNodeDef: NodeDefinition;
    nextVar: () => string;
    tag: string;
    params: Record<string, unknown>;
    policyContext: PolicyContextBundle | undefined;
    paramCounter: { count: number } | undefined;
  }): string[] {
    const { spec, relDef, sourceVar, withClause, targetNodeDef } = args;
    if (spec === null || spec === undefined) return [];
    // Legacy shorthand: `{ rel: true }` = delete every related node (the
    // pre-2.3.0 cascade ignored values, so callers relied on it). Any other
    // non-object value — `false` included, which used to delete everything
    // too — is rejected below rather than silently reinterpreted.
    const items = spec === true ? [{}] : Array.isArray(spec) ? spec : [spec];
    const lines: string[] = [];

    items.forEach((item, idx) => {
      if (!isPlainObject(item))
        throw new OGMError(
          `Each nested delete of "${relDef.fieldName}" must be an object ({ where?, delete? }).`,
        );
      for (const key of Object.keys(item)) {
        if (item[key] === undefined) continue;
        if (key !== 'where' && key !== 'delete')
          throw new OGMError(
            `Unknown key "${key}" in a nested delete of "${relDef.fieldName}". Allowed: "where", "delete".`,
          );
      }
      if (hasNestedCascade(item.delete))
        throw new OGMError(
          `Multi-level cascade delete is not supported (a "delete" inside the nested delete of "${relDef.fieldName}"). ` +
            `Delete the deeper nodes in a separate call.`,
        );

      const targetVar = args.nextVar();
      const pattern = buildRelPattern({
        sourceVar,
        relDef,
        targetVar,
        targetLabel: 'auto',
        schema: this.schema,
      });
      const conditions = [
        this.compileTargetWhere(
          item.where as Record<string, unknown> | undefined,
          targetVar,
          targetNodeDef,
          args.params,
          args.policyContext,
          args.paramCounter,
        ),
        this.buildTargetPolicyPredicate(
          targetNodeDef,
          targetVar,
          args.params,
          args.policyContext,
          args.paramCounter,
          'delete',
        ),
      ].filter((c): c is string => Boolean(c));

      lines.push(withClause);
      lines.push('CALL {');
      lines.push(withClause);
      lines.push(`MATCH ${pattern}`);
      if (conditions.length > 0)
        lines.push(`WHERE ${conditions.join(' AND ')}`);
      lines.push(`DETACH DELETE ${targetVar}`);
      lines.push(`RETURN count(*) AS _del_${args.tag}_${idx}`);
      lines.push('}');
    });

    return lines;
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
      assertSafePropertyName(key, 'merge key');
      const propDef = nodeDef.properties.get(key);
      const paramName = `merge_${key}`;
      const valueExpr = wrapWriteExpr(`$${paramName}`, value, propDef);
      mergeProps.push(`${escapeIdentifier(key)}: ${valueExpr}`);
      mergeKeyNames.push(key);
      params[paramName] = coerceWriteValue(value, propDef);
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
      assertSafePropertyName(key, 'create property');
      const propDef = nodeDef.properties.get(key);
      const paramName = `onCreate_${key}`;
      const valueExpr = wrapWriteExpr(`$${paramName}`, value, propDef);
      createSets.push(`n.${escapeIdentifier(key)} = ${valueExpr}`);
      params[paramName] = coerceWriteValue(value, propDef);
    }
    // `@default` values apply to the ON CREATE branch — a defaulted
    // property not supplied in `create` and not already fixed by the
    // MERGE key gets its default, mirroring create().
    for (const [, propDef] of nodeDef.properties) {
      if (propDef.defaultValue === undefined) continue;
      if (propDef.isGenerated || propDef.isCypher) continue;
      if (create[propDef.name] !== undefined) continue;
      if (mergeKeyNames.includes(propDef.name)) continue;
      const paramName = `onCreate_${propDef.name}`;
      const bound = resolveDefaultWriteValue(propDef);
      const valueExpr = wrapWriteExpr(`$${paramName}`, bound, propDef);
      createSets.push(`n.${escapeIdentifier(propDef.name)} = ${valueExpr}`);
      params[paramName] = bound;
    }
    if (createSets.length > 0)
      lines.push(`ON CREATE SET ${createSets.join(', ')}`);

    // ON MATCH SET — all properties from update input (scalar only)
    const updateSets: string[] = [];
    for (const [key, value] of Object.entries(update)) {
      if (value === undefined) continue;
      if (nodeDef.relationships.has(key)) continue;
      assertSafePropertyName(key, 'update property');
      const propDef = nodeDef.properties.get(key);
      const paramName = `onMatch_${key}`;
      const valueExpr = wrapWriteExpr(`$${paramName}`, value, propDef);
      updateSets.push(`n.${escapeIdentifier(key)} = ${valueExpr}`);
      params[paramName] = coerceWriteValue(value, propDef);
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
      assertSafePropertyName(key, 'createMany property');
      scalarKeys.push(key);
    }

    // Identify @id (generated) fields that are NOT provided in data
    const generatedFields: string[] = [];
    for (const [, propDef] of nodeDef.properties)
      if (propDef.isGenerated && !scalarKeys.includes(propDef.name))
        generatedFields.push(propDef.name);

    // Whole-column `@default`s: applied only when NO item supplies the
    // field. Per-item gaps inside a provided column stay null — one
    // createMany batch shares a single Cypher text, and a per-item
    // default would need coalesce(), which would also override explicit
    // nulls.
    const defaultedProps: PropertyDefinition[] = [];
    for (const [, propDef] of nodeDef.properties)
      if (
        propDef.defaultValue !== undefined &&
        !propDef.isGenerated &&
        !propDef.isCypher &&
        !scalarKeys.includes(propDef.name)
      )
        defaultedProps.push(propDef);

    // Build sanitized items (strip undefined values)
    const sanitizedItems = data.map((item) => {
      const sanitized: Record<string, unknown> = {};
      for (const key of scalarKeys)
        if (item[key] !== undefined)
          sanitized[key] = coerceWriteValue(
            item[key],
            nodeDef.properties.get(key),
          );
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
        .map(
          (k) =>
            `${escapeIdentifier(k)}: ${wrapListItemExpr(
              `item.${escapeIdentifier(k)}`,
              data.map((d) => d[k]),
              nodeDef.properties.get(k),
            )}`,
        )
        .join(', ');
      lines.push(`MERGE (n:${labelStr} { ${mergeProps} })`);

      // ON CREATE SET — remaining fields + generated IDs
      const onCreateSets: string[] = [];
      for (const key of scalarKeys)
        if (!mergeKeys.includes(key))
          onCreateSets.push(
            `n.${escapeIdentifier(key)} = ${wrapListItemExpr(
              `item.${escapeIdentifier(key)}`,
              data.map((d) => d[key]),
              nodeDef.properties.get(key),
            )}`,
          );

      for (const field of generatedFields)
        onCreateSets.push(`n.${escapeIdentifier(field)} = randomUUID()`);

      for (const propDef of defaultedProps) {
        const paramName = `default_${propDef.name}`;
        const bound = resolveDefaultWriteValue(propDef);
        onCreateSets.push(
          `n.${escapeIdentifier(propDef.name)} = ${wrapWriteExpr(
            `$${paramName}`,
            bound,
            propDef,
          )}`,
        );
        params[paramName] = bound;
      }

      if (onCreateSets.length > 0)
        lines.push(`ON CREATE SET ${onCreateSets.join(', ')}`);
    } else {
      // CREATE with all scalar properties + generated IDs
      const propParts: string[] = [];
      for (const field of generatedFields)
        propParts.push(`${escapeIdentifier(field)}: randomUUID()`);
      for (const key of scalarKeys)
        propParts.push(
          `${escapeIdentifier(key)}: ${wrapListItemExpr(
            `item.${escapeIdentifier(key)}`,
            data.map((d) => d[key]),
            nodeDef.properties.get(key),
          )}`,
        );

      for (const propDef of defaultedProps) {
        const paramName = `default_${propDef.name}`;
        const bound = resolveDefaultWriteValue(propDef);
        propParts.push(
          `${escapeIdentifier(propDef.name)}: ${wrapWriteExpr(
            `$${paramName}`,
            bound,
            propDef,
          )}`,
        );
        params[paramName] = bound;
      }

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

  /**
   * Resolve the PropertyDefinition of an edge (relationship) property so
   * Int/BigInt edge writes get the same Integer coercion as node writes.
   * Returns undefined when the relationship declares no properties type
   * (the coercion then passes the value through untouched).
   */
  private getEdgePropDef(
    relDef: RelationshipDefinition,
    propName: string,
  ): PropertyDefinition | undefined {
    if (!relDef.properties) return undefined;
    return this.schema.relationshipProperties
      .get(relDef.properties)
      ?.properties.get(propName);
  }

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
      assertSafePropertyName(key, 'create property');
      const propDef = nodeDef.properties.get(key);
      const paramName = `${prefix}_${key}`;
      const valueExpr = wrapWriteExpr(`$${paramName}`, value, propDef);
      parts.push(`${escapeIdentifier(key)}: ${valueExpr}`);
      propParams[paramName] = coerceWriteValue(value, propDef);
    }

    // `@default` values — applied for any property with a default that the
    // input leaves undefined. Explicit null is respected as null: the user
    // asked for null, a default would override intent. Generated (@id) and
    // @cypher (computed, not stored) properties never take defaults.
    for (const [, propDef] of nodeDef.properties) {
      if (propDef.defaultValue === undefined) continue;
      if (propDef.isGenerated || propDef.isCypher) continue;
      if (input[propDef.name] !== undefined) continue;
      const paramName = `${prefix}_${propDef.name}`;
      const bound = resolveDefaultWriteValue(propDef);
      const valueExpr = wrapWriteExpr(`$${paramName}`, bound, propDef);
      parts.push(`${escapeIdentifier(propDef.name)}: ${valueExpr}`);
      propParams[paramName] = bound;
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
    policyContext?: PolicyContextBundle,
    paramCounter?: { count: number },
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
            policyContext,
            paramCounter,
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
        policyContext,
        paramCounter,
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
    policyContext?: PolicyContextBundle,
    paramCounter?: { count: number },
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
          policyContext,
          paramCounter,
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
            assertSafePropertyName(prop, 'edge property');
            const edgePropDef = this.getEdgePropDef(relDef, prop);
            const paramName = `${prefix}_create${ci}_edge_${prop}`;
            setItems.push(
              `${relVar}.${escapeIdentifier(prop)} = ${wrapWriteExpr(
                `$${paramName}`,
                val,
                edgePropDef,
              )}`,
            );
            params[paramName] = coerceWriteValue(val, edgePropDef);
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

        const connectConditions = [
          this.compileTargetWhere(
            whereSpec,
            connectVar,
            targetNodeDef,
            params,
            policyContext,
            paramCounter,
          ),
          this.buildTargetPolicyPredicate(
            targetNodeDef,
            connectVar,
            params,
            policyContext,
            paramCounter,
          ),
        ].filter((c): c is string => Boolean(c));
        if (connectConditions.length > 0)
          lines.push(`WHERE ${connectConditions.join(' AND ')}`);

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
            assertSafePropertyName(prop, 'edge property');
            const edgePropDef = this.getEdgePropDef(relDef, prop);
            const paramName = `${prefix}_conn${ci}_edge_${prop}`;
            setItems.push(
              `r_conn_${startCounter + counter - 1}.${escapeIdentifier(prop)} = ${wrapWriteExpr(
                `$${paramName}`,
                val,
                edgePropDef,
              )}`,
            );
            params[paramName] = coerceWriteValue(val, edgePropDef);
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
    policyContext?: PolicyContextBundle,
    paramCounter?: { count: number },
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

        // The UNWIND fast path compiles filters against per-row values and
        // is only exact for plain scalar, non-null filters (see
        // isConnectFastPathEligible). Everything else — null values,
        // logical keys, traversals — takes one CALL subquery per item,
        // compiled through WhereCompiler.
        const useFastPath = this.isConnectFastPathEligible(
          spec as Record<string, unknown>[],
          targetNodeDef,
        );

        if (!useFastPath)
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

            const connectConditions = [
              this.compileTargetWhere(
                whereSpec,
                connectVar,
                targetNodeDef,
                params,
                policyContext,
                paramCounter,
              ),
              this.buildTargetPolicyPredicate(
                targetNodeDef,
                connectVar,
                params,
                policyContext,
                paramCounter,
              ),
            ].filter((c): c is string => Boolean(c));
            if (connectConditions.length > 0)
              lines.push(`WHERE ${connectConditions.join(' AND ')}`);

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
                assertSafePropertyName(prop, 'edge property');
                const edgePropDef = this.getEdgePropDef(relDef, prop);
                const paramName = `connect_${fieldName}_${ci}_edge_${prop}`;
                setItems.push(
                  `${relVar}.${escapeIdentifier(prop)} = ${wrapWriteExpr(
                    `$${paramName}`,
                    val,
                    edgePropDef,
                  )}`,
                );
                params[paramName] = coerceWriteValue(val, edgePropDef);
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
                if (v !== undefined)
                  cleaned[k] = coerceWriteValue(
                    v,
                    this.getEdgePropDef(relDef, k),
                  );

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
            targetNodeDef,
          );
          const policyPredicate = this.buildTargetPolicyPredicate(
            targetNodeDef,
            'target',
            params,
            policyContext,
            paramCounter,
          );
          const unwindConditions = policyPredicate
            ? [...whereConditions, policyPredicate]
            : whereConditions;
          if (unwindConditions.length > 0)
            lines.push(`WHERE ${unwindConditions.join(' AND ')}`);

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
              (p) =>
                `r.${escapeIdentifier(p)} = ${wrapListItemExpr(
                  `connItem.edge.${p}`,
                  (spec as Record<string, unknown>[]).map(
                    (it) =>
                      (it.edge as Record<string, unknown> | undefined)?.[p],
                  ),
                  this.getEdgePropDef(relDef, p),
                )}`,
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

        const singleConnectConditions = [
          this.compileTargetWhere(
            whereSpec,
            'target',
            targetNodeDef,
            params,
            policyContext,
            paramCounter,
          ),
          this.buildTargetPolicyPredicate(
            targetNodeDef,
            'target',
            params,
            policyContext,
            paramCounter,
          ),
        ].filter((c): c is string => Boolean(c));
        if (singleConnectConditions.length > 0)
          lines.push(`WHERE ${singleConnectConditions.join(' AND ')}`);

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
            const edgePropDef = this.getEdgePropDef(relDef, prop);
            const paramName = `connect_${fieldName}_edge_${prop}`;
            setItems.push(
              `r.${escapeIdentifier(prop)} = ${wrapWriteExpr(
                `$${paramName}`,
                val,
                edgePropDef,
              )}`,
            );
            params[paramName] = coerceWriteValue(val, edgePropDef);
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
    policyContext?: PolicyContextBundle,
    paramCounter?: { count: number },
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

          if (!targetNodeDef)
            throw new OGMError(
              `Cannot resolve the target type "${relDef.target}" of relationship "${fieldName}".`,
            );
          const disconnectConditions = [
            this.compileTargetWhere(
              whereSpec,
              targetVar,
              targetNodeDef,
              params,
              policyContext,
              paramCounter,
            ),
            this.buildTargetPolicyPredicate(
              targetNodeDef,
              targetVar,
              params,
              policyContext,
              paramCounter,
            ),
          ].filter((c): c is string => Boolean(c));
          if (disconnectConditions.length > 0)
            lines.push(`WHERE ${disconnectConditions.join(' AND ')}`);

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
    policyContext?: PolicyContextBundle,
    paramCounter?: { count: number },
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
          policyContext,
          paramCounter,
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
    policyContext?: PolicyContextBundle,
    paramCounter?: { count: number },
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
            policyContext,
            paramCounter,
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
        // Shared with `compileDelete`'s cascade: where + target `delete`
        // policy, one CALL subquery per spec item (v2.3.0).
        if (item.delete)
          lines.push(
            ...this.buildNestedDelete({
              spec: item.delete,
              relDef,
              sourceVar,
              withClause,
              targetNodeDef,
              nextVar: () => `${sourceVar}_del${varCounter++}`,
              tag: `${key}_${i}`,
              params,
              policyContext,
              paramCounter,
            }),
          );

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
              policyContext,
              paramCounter,
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

              // Pre-1.8.1 this called `buildNodeWhereConditions` with
              // `(whereSpec.node ?? whereSpec)`, which silently fell through
              // for connection-shape inputs like `{ NOT: { node: {...} } }`,
              // `{ AND: [...] }`, or `{ OR: [...] }` — producing broken
              // Cypher (e.g. `target.\`node\` <> $param`). Now we route
              // through the connection-aware compiler so connection-shape
              // keys are handled identically to the top-level disconnect
              // path (`buildDisconnects`). Restores backwards-compat with
              // @neo4j/graphql-ogm's nested update.disconnect[].where shape.
              const nestedDiscConditions = [
                this.compileTargetWhere(
                  whereSpec,
                  discTarget,
                  targetNodeDef,
                  params,
                  policyContext,
                  paramCounter,
                ),
                this.buildTargetPolicyPredicate(
                  targetNodeDef,
                  discTarget,
                  params,
                  policyContext,
                  paramCounter,
                ),
              ].filter((c): c is string => Boolean(c));
              if (nestedDiscConditions.length > 0)
                lines.push(`WHERE ${nestedDiscConditions.join(' AND ')}`);

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

            // Pre-1.8.1 this used `buildNodeWhereConditions` with
            // `(whereSpec?.node ?? whereSpec ?? {})`, which broke on
            // connection-shape inputs (NOT/AND/OR wrappers). Routing
            // through `buildConnectionWhereConditions` makes nested
            // connect handle the same shapes as nested disconnect and
            // top-level paths. Empty/undefined `whereSpec` short-circuits
            // to `[]` inside the helper, so the no-where case still works.
            const nestedConnConditions = [
              this.compileTargetWhere(
                whereSpec,
                connectVar,
                targetNodeDef,
                params,
                policyContext,
                paramCounter,
              ),
              this.buildTargetPolicyPredicate(
                targetNodeDef,
                connectVar,
                params,
                policyContext,
                paramCounter,
              ),
            ].filter((c): c is string => Boolean(c));
            if (nestedConnConditions.length > 0)
              lines.push(`WHERE ${nestedConnConditions.join(' AND ')}`);

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
                assertSafePropertyName(prop, 'edge property');
                const edgePropDef = this.getEdgePropDef(relDef, prop);
                const paramName = `${itemPrefix}_conn${ci}_edge_${prop}`;
                setItems.push(
                  `r_conn_${key}_${ci}.${escapeIdentifier(prop)} = ${wrapWriteExpr(
                    `$${paramName}`,
                    val,
                    edgePropDef,
                  )}`,
                );
                params[paramName] = coerceWriteValue(val, edgePropDef);
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
            assertSafePropertyName(prop, 'nested update property');
            const nodePropDef = targetNodeDef.properties.get(prop);
            const paramName = `${itemPrefix}_set_${prop}`;
            setClauses.push(
              `${updateVar}.${escapeIdentifier(prop)} = ${wrapWriteExpr(
                `$${paramName}`,
                val,
                nodePropDef,
              )}`,
            );
            setParams[paramName] = coerceWriteValue(val, nodePropDef);
          }

          // Pre-compute SET clauses for edge (relationship) properties
          const edgeClauses: string[] = [];
          const edgeParams: Record<string, unknown> = {};
          if (edgeUpdate)
            for (const [prop, val] of Object.entries(edgeUpdate)) {
              if (val === undefined) continue;
              assertSafePropertyName(prop, 'edge update property');
              const edgePropDef = this.getEdgePropDef(relDef, prop);
              const paramName = `${itemPrefix}_edge_${prop}`;
              edgeClauses.push(
                `${relVar}.${escapeIdentifier(prop)} = ${wrapWriteExpr(
                  `$${paramName}`,
                  val,
                  edgePropDef,
                )}`,
              );
              edgeParams[paramName] = coerceWriteValue(val, edgePropDef);
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
            policyContext,
            paramCounter,
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

            // WHERE on the target.
            // v1.8.7 — pre-1.8.7 this unwrapped `(updateWhere.node ??
            // updateWhere)` and compiled EVERY key as plain equality, so
            // operator suffixes became non-existent property lookups
            // (`u.\`name_CONTAINS\` = $p` — matches nothing, silent
            // no-op) and `AND`/`OR`/`NOT` became bogus property
            // predicates. The disconnect (v1.8.1) and connect (v1.8.1)
            // siblings were already routed through the connection-aware
            // compiler; this was the missed third sibling. The param
            // prefix is chosen so the legacy plain-equality case keeps
            // byte-identical param names (`${itemPrefix}_where_${prop}`).
            // v2.3.0 — the nested update is row-filtered by the TARGET's
            // `update` policy, exactly like a direct update on that type
            // (pre-2.3.0 it enforced no target policy at all).
            const updateConditions = [
              this.compileTargetWhere(
                updateWhere,
                updateVar,
                targetNodeDef,
                params,
                policyContext,
                paramCounter,
              ),
              this.buildTargetPolicyPredicate(
                targetNodeDef,
                updateVar,
                params,
                policyContext,
                paramCounter,
                'update',
              ),
            ].filter((c): c is string => Boolean(c));
            if (updateConditions.length > 0)
              lines.push(`WHERE ${updateConditions.join(' AND ')}`);

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

  private buildGeneratedIdClause(nodeDef: NodeDefinition): string {
    const parts: string[] = [];
    for (const [, propDef] of nodeDef.properties)
      if (propDef.isGenerated)
        parts.push(`${escapeIdentifier(propDef.name)}: randomUUID()`);

    return parts.join(', ');
  }

  private extractConnectWhereConditions(
    item: Record<string, unknown>,
    targetVar: string,
    itemVar: string,
    targetNodeDef?: NodeDefinition,
  ): string[] {
    const conditions: string[] = [];
    const whereSpec = item.where as Record<string, unknown> | undefined;
    if (!whereSpec) return conditions;

    const nodeWhere = (whereSpec.node ?? whereSpec) as Record<string, unknown>;
    for (const key of Object.keys(nodeWhere)) {
      const { baseProp, template } = this.parseOperatorSuffix(key);
      assertSafePropertyName(baseProp, 'connect where property');
      // Replace template placeholders with dynamic UNWIND references
      // Note: itemVar map access is NOT escaped (parameter map keys, not Cypher identifiers)
      // Temporal wrap keys off the FIRST item's value type — the UNWIND
      // fast path already requires shape-homogeneous items.
      const valueRef = wrapWhereParam(
        `${itemVar}.where.node.${key}`,
        nodeWhere[key],
        targetNodeDef?.properties.get(baseProp),
        key.slice(baseProp.length),
      );
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
    for (const key of keys) assertSafePropertyName(key, 'edge property');

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
/** Keys that make a nested-mutation `where` connection-shaped. */
const CONNECTION_WHERE_KEYS: ReadonlySet<string> = new Set([
  'node',
  'node_NOT',
  'NOT',
  'AND',
  'OR',
  'edge',
  'edge_NOT',
]);

/**
 * Map a nested-mutation connection where onto an equivalent NODE where on
 * the target, for `WhereCompiler` (v2.3.0). Mutation `where` never supports
 * edge filters, so the two shapes are interchangeable:
 *
 *   { node: A }          → A
 *   { node_NOT: A }      → { NOT: A }
 *   { NOT: C }           → { NOT: map(C) }
 *   { AND: [C…] }        → { AND: [map(C)…] }   (likewise OR; `OR: []`
 *                                                 still matches nothing)
 *   bare properties      → themselves (legacy `{ id: 'x' }` shape)
 *
 * `edge`/`edge_NOT` throw (unsupported in mutations). In a connection-
 * shaped where, any other key throws too — the removed parallel builder
 * silently IGNORED such keys (`{ id: 'x', NOT: {…} }` dropped `id`),
 * widening the match.
 */
export function connectionWhereToNodeWhere(
  spec: Record<string, unknown>,
): Record<string, unknown> {
  if (!isPlainObject(spec))
    throw new OGMError('A nested mutation where must be an object.');
  const keys = Object.keys(spec).filter((k) => spec[k] !== undefined);
  const edgeKey = keys.find((k) => k === 'edge' || k === 'edge_NOT');
  if (edgeKey)
    throw new OGMError(
      `Connection WHERE with "${edgeKey}" filters is not supported in mutations. ` +
        `Only "node", "node_NOT", "NOT", "AND", "OR" keys or direct property conditions are allowed.`,
    );
  if (!keys.some((k) => CONNECTION_WHERE_KEYS.has(k))) return spec;

  const parts: Record<string, unknown>[] = [];
  for (const key of keys) {
    const value = spec[key];
    if (value === null) continue;
    switch (key) {
      case 'node':
        parts.push(value as Record<string, unknown>);
        break;
      case 'node_NOT':
        parts.push({ NOT: value });
        break;
      case 'NOT':
        parts.push({
          NOT: connectionWhereToNodeWhere(value as Record<string, unknown>),
        });
        break;
      case 'AND':
      case 'OR':
        if (!Array.isArray(value))
          throw new OGMError(
            `"${key}" in a nested mutation where must be an array.`,
          );
        parts.push({
          [key]: value.map((item) =>
            connectionWhereToNodeWhere(item as Record<string, unknown>),
          ),
        });
        break;
      default:
        throw new OGMError(
          `Unknown key "${key}" in a connection-shaped nested mutation where. ` +
            `Allowed: "node", "node_NOT", "NOT", "AND", "OR" — put property ` +
            `conditions inside "node".`,
        );
    }
  }
  return parts.length === 1 ? parts[0] : { AND: parts };
}

/** A nested delete item's own `delete` asks for a deeper cascade. */
function hasNestedCascade(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return isPlainObject(value) ? Object.keys(value).length > 0 : true;
}

/**
 * A `param<N>` counter that continues after every `param<N>` already in
 * `params`, for callers that did not thread their own counter (direct
 * `MutationCompiler` use): nested-write filters compiled with it can never
 * collide with the root WHERE's params.
 */
function counterAfter(params: Record<string, unknown>): { count: number } {
  let max = -1;
  for (const key of Object.keys(params)) {
    const match = /^param(\d+)$/.exec(key);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return { count: max + 1 };
}

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

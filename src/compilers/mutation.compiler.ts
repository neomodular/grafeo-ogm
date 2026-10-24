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
  checkWhereJsDate,
  coerceWhereValue,
  coerceWriteValue,
  resolveDefaultWriteValue,
  wrapListItemExpr,
  wrapWhereParam,
  wrapWriteExpr,
} from '../utils/write-coercion';
import { lenientStrictMode, StrictMode } from '../utils/strict-mode';
import {
  assertWhereDepth,
  compileDurationRange,
  WhereCompiler,
} from './where.compiler';

export interface MutationResult {
  cypher: string;
  params: Record<string, unknown>;
  /**
   * v2.8.0 — `compileUpdate` only: the update has a nested `delete` whose
   * target type is the type of a node the statement still holds (the root
   * or an enclosing nested-update node), e.g. chart -> tags -> charts
   * (finding F1). Without the alive guard, a statement whose delete reaches
   * that node fails with `EntityNotFound` when a later clause reads or
   * writes it; `updateMany` counts a deleted root.
   */
  cycleDelete?: boolean;
}

/**
 * v2.8.0 — state shared by one `compileUpdate`'s nested update walk.
 */
interface NestedUpdateState {
  /** Emit the alive guard after op blocks that may delete a held node (F1). */
  readonly guardDeleted: boolean;
  /** Set when a nested delete's target type can be a held node (F1). */
  cycleDelete: boolean;
  /**
   * `Type.field` of each nested `connect` / `create` on a field an
   * enclosing nested update item iterates (F2).
   */
  readonly feedback: Set<string>;
}

/**
 * v2.6.1 — a row filter on `n` that gates the MATCH side of a MERGE (the
 * root type's `update` policy, compiled by `WhereCompiler.compile`). An
 * empty `cypher` means "no filter" and leaves the emitted Cypher unchanged.
 */
export interface MatchGuard {
  cypher: string;
  params: Record<string, unknown>;
  preludes?: string[];
}

/**
 * Where a connect / disconnect is emitted: its source variable, the WITH
 * that carries every variable still needed, and a prefix that keeps its
 * variables, params and aliases unique when nested (v2.4.8).
 */
interface WriteScope {
  sourceVar: string;
  /** Every variable the WITH carries (ancestors + `sourceVar`). */
  carryVars: string[];
  withClause: string;
  varPrefix: string;
  depth: number;
}

/** The root node `n` of an update — the pre-2.4.8 names, unprefixed. */
const TOP_SCOPE: WriteScope = {
  sourceVar: 'n',
  carryVars: ['n'],
  withClause: 'WITH n',
  varPrefix: '',
  depth: 0,
};

/** Max depth of connects nested in connects (disconnects likewise). */
const MAX_NESTED_LINK_DEPTH = 5;

/**
 * The scope of a connect / disconnect nested in an item whose target is
 * bound as `targetVar`: that node becomes the source, everything in scope
 * stays carried, and its own names are prefixed by it.
 */
function nestedScope(
  carryVars: string[],
  targetVar: string,
  depth: number,
  /**
   * A token unique along the whole write path (v2.5.1). Pre-2.5.1 the
   * prefix was `targetVar` alone, which sibling connects share (`target`)
   * and which per-member union / interface dispatch restarts (`n_conn0`),
   * so their nested params collided and the last writer won: links went
   * to the wrong node and edge values were overwritten.
   */
  uniqueToken: string,
) {
  if (depth >= MAX_NESTED_LINK_DEPTH)
    throw new OGMError(
      `Nested connect / disconnect deeper than ${MAX_NESTED_LINK_DEPTH} levels is not supported.`,
    );
  const vars = [...new Set([...carryVars, targetVar])];
  return {
    sourceVar: targetVar,
    carryVars: vars,
    withClause: `WITH ${vars.join(', ')}`,
    varPrefix: `${uniqueToken}_`,
    depth: depth + 1,
  } satisfies WriteScope;
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

  /** v2.6.0 — strict mode + warn-once log, shared per OGM. */
  private strictMode: StrictMode;

  constructor(
    private schema: SchemaMetadata,
    options?: {
      logger?: OGMLogger;
      whereCompiler?: WhereCompiler;
      strictMode?: StrictMode;
    },
  ) {
    this.logger = options?.logger;
    this.policyWhereCompiler = options?.whereCompiler;
    this.strictMode = options?.strictMode ?? lenientStrictMode();
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

    // Abstract (interface / union) targets get a conjunction over their
    // concrete members' own clauses — every member label the node carries
    // must pass (v2.5.4; pre-2.5.4 a first-match CASE) — pre-2.3.0 only
    // the abstract type's own policies (usually none) were applied.
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

  /**
   * v2.5.2 — a connect / disconnect nested in a connect / disconnect item
   * writes the INTERMEDIATE node's own relationships, which the direct
   * equivalent (`Intermediate.update({ connect | disconnect })`) only allows
   * under its `update` policy. Pre-2.5.2 the intermediate was gated by
   * `read` alone, so a context that could merely see a node could link and
   * unlink its relationships. Inside the item's CALL this filters the row
   * before the nested ops; the outer link / unlink still needs `read` only,
   * and `count(*)` keeps one row per node. No policies → no lines.
   */
  private gateOnUpdate(
    withClause: string,
    targetNodeDef: NodeDefinition,
    targetVar: string,
    params: Record<string, unknown>,
    policyContext: PolicyContextBundle | undefined,
    paramCounter: { count: number } | undefined,
  ): string[] {
    const predicate = this.buildTargetPolicyPredicate(
      targetNodeDef,
      targetVar,
      params,
      policyContext,
      paramCounter,
      'update',
    );
    return predicate ? [withClause, `WHERE ${predicate}`] : [];
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
      // A non-object item takes the per-item path, which rejects it.
      if (!isPlainObject(item)) return false;
      // A nested `connect` is per item (v2.4.8): the UNWIND cannot run it.
      if (item.connect != null) return false;
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
   * The MATCH that binds a connect TARGET by type. A node type keeps its
   * label pattern; an interface / union target matches its MEMBERS' labels
   * through a WHERE predicate (v2.4.8). Pre-2.4.8 it matched the abstract
   * type's own label, which implementer and member nodes do not carry, so
   * the connect linked nothing.
   */
  private targetMatch(
    targetNodeDef: NodeDefinition,
    targetVar: string,
  ): { match: string; labelPredicate: string | null } {
    const abstract = abstractTarget(targetNodeDef.typeName, this.schema);
    if (!abstract)
      return {
        match: `MATCH (${targetVar}:${this.getCachedLabelString(targetNodeDef)})`,
        labelPredicate: null,
      };
    const alternatives = abstract.members.map(
      (m) =>
        `${targetVar}:${this.getCachedLabelString(this.schema.nodes.get(m)!)}`,
    );
    return {
      match: `MATCH (${targetVar})`,
      labelPredicate:
        alternatives.length > 0 ? `(${alternatives.join(' OR ')})` : 'false',
    };
  }

  /**
   * Resolve a relationship's target for a nested write. Throws when the
   * target is unknown — pre-2.4.8 the nested op was silently skipped.
   */
  private requireTargetDef(relDef: RelationshipDefinition): NodeDefinition {
    const targetNodeDef = resolveTargetDef(relDef.target, this.schema);
    if (!targetNodeDef)
      throw new OGMError(
        `Cannot resolve the target type "${relDef.target}" of relationship "${relDef.fieldName}".`,
      );
    return targetNodeDef;
  }

  /**
   * v2.6.0 — keys of a connect / disconnect item that the compiler does not
   * read. Pre-2.6.0 (and still by default) they are ignored, so a typo such
   * as `{ wehre: … }` compiles to an item with NO filter: a connect links
   * every target node, a disconnect unlinks every related one. Default: one
   * warning per OGM; strict: `OGMError`, like an unknown write field.
   */
  private checkLinkItemKeys(
    item: Record<string, unknown>,
    kind: 'connect' | 'disconnect',
    relDef: RelationshipDefinition,
  ): void {
    const allowed =
      kind === 'connect' ? CONNECT_ITEM_KEYS : DISCONNECT_ITEM_KEYS;
    const unknown = unknownInputKeys(item, allowed);
    if (unknown.length === 0) return;
    const list = quoteKeys(unknown);
    const allowedList = quoteKeys(allowed);
    if (this.strictMode.strict)
      throw new OGMError(
        `Unknown key(s) ${list} in a ${kind} item on "${relDef.fieldName}". Allowed: ${allowedList}.`,
      );
    const unfiltered = item.where == null;
    this.strictMode.warn(
      `${kind}-unknown-key`,
      `${relDef.fieldName}\u0000${unknown.join(',')}`,
      `Unknown key(s) ${list} in a ${kind} item on "${relDef.fieldName}" ` +
        `${unknown.length > 1 ? 'are' : 'is'} ignored` +
        (unfiltered
          ? `; with no "where", the item ${
              kind === 'connect'
                ? `connects EVERY "${relDef.target}" node`
                : `unlinks EVERY related "${relDef.target}" node`
            }.`
          : '.') +
        ` Allowed: ${allowedList}.`,
      `throw an OGMError for unknown ${kind} item keys`,
    );
  }

  /**
   * v2.19.0 — strict item 32. A key of a connect / disconnect map (root,
   * or the nested `connect` / `disconnect` of an item) that is not a
   * relationship of `nodeDef`. Pre-v2.19.0 (and still by default) it is
   * skipped, so the write runs without it and reports success; a cascade
   * `delete` throws for the same mistake. Default: one warning per OGM,
   * type, kind and key; strict: `OGMError`. A key set to `undefined` is
   * ignored in both modes.
   */
  private checkLinkRelationship(
    nodeDef: NodeDefinition,
    fieldName: string,
    value: unknown,
    kind: 'connect' | 'disconnect',
  ): void {
    if (value === undefined) return;
    const msg = `Unknown relationship "${fieldName}" in the ${kind} input of ${nodeDef.typeName}`;
    if (this.strictMode.strict)
      throw new OGMError(
        `${msg}: it is not a relationship field of the type. Declare it in the schema, or fix the key.`,
      );
    this.strictMode.warn(
      `${kind}-unknown-relationship`,
      `${nodeDef.typeName}\u0000${fieldName}`,
      `${msg} is ignored: it is not a relationship field of the type, so nothing is ${
        kind === 'connect' ? 'connected' : 'disconnected'
      } for it.`,
      `throw an OGMError for unknown relationships in ${kind} inputs`,
    );
  }

  /**
   * v2.10.0 — strict item 22. Keys of a nested write object that the
   * compiler does not read (connect / disconnect items are
   * {@link checkLinkItemKeys}). Pre-2.10.0 (and still by default) they are
   * ignored: a typo'd `wher` in a nested update item leaves its `update`
   * with no filter, so it rewrites EVERY related node; `creat`, `updat`,
   * `egde` beside `node`, or a node field beside `edge` in a nested update
   * are dropped. Default: one warning per OGM and shape; strict:
   * `OGMError`, like an unknown write field.
   */
  private checkNestedWriteKeys(
    input: unknown,
    shape: NestedWriteShape,
    relDef: RelationshipDefinition,
  ): void {
    if (!isPlainObject(input)) return;
    const { keys: allowed, what } = NESTED_WRITE_SHAPES[shape];
    const unknown = unknownInputKeys(input, allowed);
    if (unknown.length === 0) return;
    const list = quoteKeys(unknown);
    const allowedList = quoteKeys(allowed);
    if (this.strictMode.strict)
      throw new OGMError(
        `Unknown key(s) ${list} in ${what} on "${relDef.fieldName}". Allowed: ${allowedList}.`,
      );
    let effect: string;
    if (shape === 'update item')
      effect =
        input.update != null && input.where == null
          ? `; with no "where", the item's "update" applies to EVERY related "${relDef.target}" node.`
          : '.';
    else if (shape === 'create field input')
      effect = `: only "create" and "connect" are written, nothing for ${unknown.length > 1 ? 'these keys' : 'this key'}.`;
    else if (shape === 'create item')
      effect = ': with "node" given, only "node" and "edge" are read.';
    else
      effect =
        ': with "node" or "edge" given, node fields are read only from "node".';
    this.strictMode.warn(
      'nested-write-unknown-key',
      `${shape}\u0000${relDef.fieldName}\u0000${unknown.join(',')}`,
      `Unknown key(s) ${list} in ${what} on "${relDef.fieldName}" ` +
        `${unknown.length > 1 ? 'are' : 'is'} ignored${effect} Allowed: ${allowedList}.`,
      'throw an OGMError for unknown keys in nested write inputs',
    );
  }

  /**
   * v2.10.0 — strict item 22: key-check one nested update item, the
   * create items it carries and its `update` body (when that body uses the
   * `node` / `edge` wrapper; the flat form is checked field by field by
   * `assertKnownField`). Connect / disconnect items are checked where they
   * are compiled.
   */
  private checkUpdateItemKeys(
    item: unknown,
    relDef: RelationshipDefinition,
  ): void {
    if (!isPlainObject(item)) return;
    this.checkNestedWriteKeys(item, 'update item', relDef);
    this.checkCreateItemKeys(item.create, relDef);
    const body = item.update;
    if (isPlainObject(body) && (body.node != null || body.edge))
      this.checkNestedWriteKeys(body, 'update body', relDef);
  }

  /**
   * v2.10.0 — strict item 22: key-check the nested create items of a
   * `create` value that use the `node` wrapper (`createSpec.node ??
   * createSpec`: without `node`, every key is a node field and checked by
   * `assertKnownField`).
   */
  private checkCreateItemKeys(
    create: unknown,
    relDef: RelationshipDefinition,
  ): void {
    if (create == null) return;
    for (const spec of Array.isArray(create) ? create : [create])
      if (isPlainObject(spec) && spec.node != null)
        this.checkNestedWriteKeys(spec, 'create item', relDef);
  }

  /**
   * v2.6.0 — `labels` on a MERGE path (upsert, createMany with
   * skipDuplicates) are SET after the MERGE, so they are also added to an
   * EXISTING node it matched. Default: unchanged, one warning; strict: the
   * labels go in `ON CREATE SET`, onto newly created nodes only.
   */
  private labelsOnMatchedNodes(
    nodeDef: NodeDefinition,
    op: 'upsert' | 'createMany',
  ): void {
    const call = op === 'upsert' ? 'upsert' : 'createMany with skipDuplicates';
    this.strictMode.warn(
      'labels-on-matched-nodes',
      `${nodeDef.typeName}\u0000${op}`,
      `"labels" on ${call} (${nodeDef.typeName}) are added to every node the MERGE returns, so an existing node ` +
        `it matched is relabelled too.`,
      'apply "labels" only to the nodes it creates',
    );
  }

  /**
   * v2.6.0 — `edge` keys that are not properties of the relationship's
   * `@relationshipProperties` type. Pre-2.6.0 (and still by default) each
   * is written to the relationship as a stray property. Default: one
   * warning per OGM; strict: `OGMError` (`Unknown field …`).
   */
  private checkEdgeKeys(
    relDef: RelationshipDefinition,
    edge: unknown,
    input: 'connect' | 'nested create' | 'nested update',
  ): void {
    if (!isPlainObject(edge)) return;
    const declared = relDef.properties
      ? this.schema.relationshipProperties.get(relDef.properties)?.properties
      : undefined;
    for (const key of Object.keys(edge)) {
      if (edge[key] === undefined || declared?.has(key)) continue;
      const owner = relDef.properties
        ? `the relationship properties type "${relDef.properties}"`
        : `the relationship, which declares no @relationshipProperties`;
      if (this.strictMode.strict)
        throw new OGMError(
          `Unknown field "${key}" in the edge input (${input}) of "${relDef.fieldName}": it is not a property of ` +
            `${owner}. Declare it in the schema, or fix the key.`,
        );
      this.strictMode.warn(
        'edge-unknown-key',
        `${relDef.fieldName}\u0000${key}`,
        `Unknown field "${key}" in the edge input of "${relDef.fieldName}" is not a property of ${owner}; ` +
          `it is written to the relationship as a stray property.`,
        `throw an OGMError for unknown edge fields`,
      );
    }
  }

  /**
   * v2.8.0 — whether a connect item keeps an EXISTING relationship's edge
   * properties (`overwrite: false`). Through v2.7.0 (and still by default)
   * `overwrite` is accepted but ignored: MERGE + SET overwrites the edge
   * values of a relationship that already exists. Default: one warning per
   * relationship field when the item carries edge values (without any the
   * flag changes nothing) and `false`; strict: `true`, and the item's edge
   * values go in ON CREATE SET.
   */
  private connectKeepsExistingEdge(
    item: Record<string, unknown>,
    relDef: RelationshipDefinition,
  ): boolean {
    if (item.overwrite !== false) return false;
    if (this.strictMode.strict) return true;
    const edge = item.edge;
    if (
      isPlainObject(edge) &&
      Object.keys(edge).some((k) => edge[k] !== undefined)
    )
      this.strictMode.warn(
        'connect-overwrite-false',
        relDef.fieldName,
        `"overwrite: false" on a connect item of "${relDef.fieldName}" is ignored: when the relationship ` +
          `already exists, its edge properties are overwritten with the item's "edge" values.`,
        'leave an existing relationship unchanged when "overwrite" is false',
      );
    return false;
  }

  /**
   * v2.8.0 — `@default` values of the relationship properties that an
   * edge input leaves undefined, for an edge the write CREATES (nested
   * create, or the create branch of a connect's MERGE). Through v2.7.0
   * (and still by default) edge defaults were never applied, so the
   * relationship was stored without the property. Default: one warning per
   * properties type and field, and no SET items; strict: one
   * `<relVar>.<prop> = <default>` item per property, bound as
   * `<paramPrefix>_edge_<prop>` (the naming of the explicit edge values,
   * which never name a defaulted property, so the two cannot collide).
   * As for nodes, an explicit `null` is kept and `@id` / `@cypher` fields
   * take no default.
   */
  private edgeDefaultSetItems(
    relDef: RelationshipDefinition,
    edgeInput: unknown,
    relVar: string,
    paramPrefix: string,
    params: Record<string, unknown>,
  ): string[] {
    if (!relDef.properties) return [];
    const propsDef = this.schema.relationshipProperties.get(relDef.properties);
    if (!propsDef) return [];
    const edge = isPlainObject(edgeInput) ? edgeInput : {};
    const items: string[] = [];
    for (const [, propDef] of propsDef.properties) {
      // v2.18.0 — an `@id` relationship property is generated when the
      // relationship is created, as a node's `@id` is (`randomUUID()`), in
      // every mode. Pre-v2.18.0 nothing generated it: it was always null,
      // though the generated output type declares it non-null. A value the
      // edge input supplies (null included) wins, as for nodes; on a
      // connect's MERGE the item lands in ON CREATE SET, so an existing
      // relationship keeps its id.
      if (propDef.isGenerated && !propDef.isCypher) {
        if (edge[propDef.name] !== undefined) continue;
        assertSafePropertyName(propDef.name, 'edge property');
        items.push(
          `${relVar}.${escapeIdentifier(propDef.name)} = randomUUID()`,
        );
        continue;
      }
      if (propDef.defaultValue === undefined) continue;
      if (propDef.isGenerated || propDef.isCypher) continue;
      if (edge[propDef.name] !== undefined) continue;
      if (!this.strictMode.strict) {
        this.strictMode.warn(
          'edge-default-not-applied',
          `${relDef.properties}\u0000${propDef.name}`,
          `"${relDef.properties}.${propDef.name}" declares @default, but a relationship created without it ` +
            `(edge input of "${relDef.fieldName}") is stored with no "${propDef.name}" property.`,
          'apply @default values of relationship properties when the relationship is created',
        );
        continue;
      }
      assertSafePropertyName(propDef.name, 'edge property');
      const paramName = `${paramPrefix}_edge_${propDef.name}`;
      const bound = resolveDefaultWriteValue(propDef);
      params[paramName] = bound;
      items.push(
        `${relVar}.${escapeIdentifier(propDef.name)} = ${wrapWriteExpr(
          `$${paramName}`,
          bound,
          propDef,
        )}`,
      );
    }
    return items;
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

      // Labels first: an unsafe label must fail as such, before any
      // input-key check (v2.5.0 rejects unknown keys).
      const labelStr = this.getCachedLabelString(nodeDef);

      const { propString, propParams } = this.buildCreateProperties(
        input,
        nodeDef,
        prefix,
      );

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

    // Each input binds its own variable (`n`, `n_1`, ...). Re-bind them
    // all to `n`, one row per created node in input order, so the trailing
    // `RETURN n` — and the projection that replaces it — covers every node,
    // not just the first.
    if (createdVars.length > 1) {
      lines.push(`WITH [${createdVars.join(', ')}] AS __created`);
      lines.push('UNWIND __created AS n');
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
    /**
     * v2.8.0 — after a nested op block that may delete a node the statement
     * still holds (a nested delete reached through a cycle, finding F1),
     * keep the row only while that node exists: its remaining writes are
     * skipped and a deleted root leaves the response and `updateMany`'s
     * count. On under strict mode. In default mode the Cypher stays as in
     * v2.7.0; the model re-compiles with `true` only to re-run a statement
     * that failed with `EntityNotFound`.
     */
    guardDeleted: boolean = this.strictMode.strict,
  ): MutationResult {
    const labelStr = this.getCachedLabelString(nodeDef);

    const lines: string[] = [];
    const params: Record<string, unknown> = { ...whereResult.params };
    // Continue after the root WHERE's params when the caller threads no
    // counter, so nested filters can never collide with them.
    const counter = paramCounter ?? counterAfter(whereResult.params);
    const state: NestedUpdateState = {
      guardDeleted,
      cycleDelete: false,
      feedback: new Set<string>(),
    };

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

    // Disconnect relationships (top-level) — must run before connects
    // so that blanket disconnects don't remove newly-connected relationships.
    // v2.9.0 — strict mode emits it here, before the `update` body, as
    // @neo4j/graphql 5.x does (delete, disconnect, update, connect,
    // create). Default mode keeps the 2.x position, after the body.
    const emitDisconnect = (): void => {
      if (!disconnect) return;
      lines.push(
        ...this.buildDisconnects(
          disconnect,
          nodeDef,
          params,
          policyContext,
          counter,
        ),
      );
    };
    if (this.strictMode.strict) emitDisconnect();

    // SET properties
    if (update && Object.keys(update).length > 0) {
      const setClauses: string[] = [];
      for (const [key, value] of Object.entries(update)) {
        // Skip relationship fields — handled separately below
        if (nodeDef.relationships.has(key)) continue;
        if (value === undefined) continue;
        assertSafePropertyName(key, 'update property');
        assertKnownField(nodeDef, key, 'update', this.strictMode);
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
        new Set<string>(),
        state,
      );
      lines.push(...relLines);
    }

    // v2.8.0 (finding F2) — a known limitation in both modes; see the
    // `iterated` check in buildUpdateRelationships.
    for (const field of state.feedback)
      this.strictMode.notice(
        'nested-update-feedback',
        `${nodeDef.typeName}\u0000${field}`,
        `${returnMode === 'count' ? 'updateMany' : 'update'} on ${nodeDef.typeName} has a nested connect / create ` +
          `on "${field}" inside a nested update that iterates "${field}" itself. Each row of that nested update ` +
          `also sees the links and nodes the earlier rows of the statement added, so the work can grow ` +
          `geometrically with the matched rows, and the result depends on row order. Split the write into ` +
          `separate calls, or narrow the nested "where".`,
      );

    // v2.8.0 (finding F1) — default mode keeps v2.7.0's Cypher, so a root
    // a nested delete removed is still counted by `updateMany`.
    if (state.cycleDelete && !guardDeleted && returnMode === 'count')
      this.strictMode.warn(
        'update-many-cycle-delete',
        nodeDef.typeName,
        `updateMany on ${nodeDef.typeName} has a nested delete whose target type can be the root itself ` +
          `(a cycle such as ${nodeDef.typeName} -> … -> ${nodeDef.typeName}): a root the delete removes ` +
          `is still counted, and a statement that writes to a deleted node after the delete fails.`,
        'leave the deleted roots out of the count and skip the remaining writes of a deleted node',
      );

    if (!this.strictMode.strict) {
      for (const field of this.rootDisconnectOrderFields(
        update,
        disconnect,
        nodeDef,
      ))
        this.strictMode.warn(
          'update-op-order',
          `${nodeDef.typeName}.${field}`,
          `${returnMode === 'count' ? 'updateMany' : 'update'} on ${nodeDef.typeName} has a root \`disconnect\` and a nested ` +
            `update / connect / create / delete on "${nodeDef.typeName}.${field}" (same relationship type). 2.x runs the root ` +
            `\`disconnect\` after the \`update\` body, so the nested ops still see the relationships it removes and a blanket ` +
            `disconnect also removes what they just linked (@neo4j/graphql runs the root \`disconnect\` first).`,
          'run the root `disconnect` before the `update` body, as @neo4j/graphql does',
        );
      emitDisconnect();
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

    return state.cycleDelete
      ? { cypher: lines.join('\n'), params, cycleDelete: true }
      : { cypher: lines.join('\n'), params };
  }

  /**
   * v2.9.0 — the `update` relationship fields whose nested ops can give a
   * different result depending on whether the root `disconnect` runs before
   * or after them: a nested `update`, `connect`, `create` or `delete` on a
   * field with the same relationship type as a field the root `disconnect`
   * names. A nested `disconnect` alone commutes with it, so it is left out.
   */
  private rootDisconnectOrderFields(
    update: Record<string, unknown> | undefined,
    disconnect: Record<string, unknown> | undefined,
    nodeDef: NodeDefinition,
  ): string[] {
    if (!update || !disconnect) return [];
    const disconnectedTypes = new Set<string>();
    for (const [key, value] of Object.entries(disconnect)) {
      const relDef = nodeDef.relationships.get(key);
      if (relDef && value !== undefined) disconnectedTypes.add(relDef.type);
    }
    if (disconnectedTypes.size === 0) return [];
    const ops = ['update', 'connect', 'create', 'delete'];
    // An item, or a per-member map of items (`{ Dog: [{ create }] }`).
    const hasOrderedOp = (value: unknown, depth = 0): boolean =>
      (Array.isArray(value) ? value : [value]).some(
        (item) =>
          isPlainObject(item) &&
          (ops.some((op) => item[op] != null) ||
            (depth === 0 &&
              Object.entries(item).some(
                ([k, v]) => this.schema.nodes.has(k) && hasOrderedOp(v, 1),
              ))),
      );
    const fields: string[] = [];
    for (const [key, value] of Object.entries(update)) {
      const relDef = nodeDef.relationships.get(key);
      if (!relDef || value == null || !disconnectedTypes.has(relDef.type))
        continue;
      if (hasOrderedOp(value)) fields.push(key);
    }
    return fields;
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
    /**
     * vNEXT — strict item 39: runtime labels added to the root MATCH, as in
     * compileUpdate. `Model` passes them only in strict mode.
     */
    labels?: string[],
  ): MutationResult {
    const labelStr = this.getCachedLabelString(nodeDef);

    const lines: string[] = [];
    const params: Record<string, unknown> = { ...whereResult.params };
    const counter = paramCounter ?? counterAfter(whereResult.params);

    if (labels && labels.length > 0) {
      const extraLabels = labels.map((l) => assertSafeLabel(l)).join(':');
      lines.push(`MATCH (n:${labelStr}:${extraLabels})`);
    } else lines.push(`MATCH (n:${labelStr})`);
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
        // v2.6.2 — a cascade on a union / interface field keyed by member
        // type (`{ items: { Chart: [...] } }`, the generated
        // `…DeleteInput` shape) deletes each member's matching targets.
        // Pre-2.6.2 only the flat item list was accepted and the typed
        // shape threw `Unknown key "Chart" in a nested delete`.
        const members = perMemberDeleteEntries(
          spec,
          abstractTarget(relDef.target, this.schema),
          fieldName,
        );
        if (members) {
          for (const [member, memberSpec] of members)
            lines.push(
              ...this.buildNestedDelete({
                spec: memberSpec,
                relDef: this.narrowToMember(relDef, member),
                sourceVar: 'n',
                withClause: 'WITH n',
                targetNodeDef: this.schema.nodes.get(member)!,
                nextVar: () => `cascade_${varCounter++}`,
                tag: `${fieldName}_${member}`,
                params,
                policyContext,
                paramCounter: counter,
              }),
            );
          continue;
        }
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
        // v2.5.1 — an interface / union target binds no label in the
        // pattern, so restrict the match to its member types. Without it a
        // nested or cascade delete also DETACH DELETEd any other node on the
        // same relationship type (a Toy deleted through `pets`).
        this.targetMatch(targetNodeDef, targetVar).labelPredicate,
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
   *
   * v2.6.1 — `updateGuard` is the root type's `update` row filter on `n`
   * (compiled by the caller with `preserveVars: ['__matched']`). When it
   * is non-empty, an EXISTING node is updated only when it passes the
   * guard, exactly like a direct `update`; one that fails it is left
   * untouched and no row is returned. See `buildGuardedMerge`.
   */
  compileMerge(
    where: Record<string, unknown>,
    create: Record<string, unknown>,
    update: Record<string, unknown>,
    nodeDef: NodeDefinition,
    labels?: string[],
    updateGuard?: MatchGuard,
  ): MutationResult {
    const labelStr = this.getCachedLabelString(nodeDef);
    const lines: string[] = [];
    const params: Record<string, unknown> = {};

    // MERGE key: the `@id` / `@unique` fields of `where`, and nothing else
    // (v2.5.0). Any other key throws:
    //   - a plain field (`{ email, name }`) became part of the MERGE
    //     pattern, so an existing node with that email but another name did
    //     not match — MERGE created a DUPLICATE beside it;
    //   - an operator key (`name_CONTAINS`) was dropped, silently widening
    //     the match to the remaining keys;
    //   - a typo (`usernme`) became a phantom property on the new node.
    // Pre-1.7.4 any key set was accepted; 1.7.4 required at least one
    // unique key but still let the others through.
    const mergeProps: string[] = [];
    const mergeKeyNames: string[] = [];
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) continue;
      const propDef = nodeDef.properties.get(key);
      if (
        !propDef ||
        propDef.isCypher ||
        !(propDef.isUnique || propDef.isGenerated)
      )
        throw new OGMError(
          `upsert "where" accepts only @id / @unique fields of ${nodeDef.typeName}; "${key}" is not one. ` +
            `MERGE matches on exactly these keys — put other fields in "create" / "update", ` +
            `or use findFirst() + create() / update() for a non-unique match.`,
        );
      if (value === null)
        throw new OGMError(
          `upsert "where.${key}" is null; a MERGE key must have a value.`,
        );
      assertSafePropertyName(key, 'merge key');
      const paramName = `merge_${key}`;
      const valueExpr = wrapWriteExpr(`$${paramName}`, value, propDef);
      mergeProps.push(`${escapeIdentifier(key)}: ${valueExpr}`);
      mergeKeyNames.push(key);
      params[paramName] = coerceWriteValue(value, propDef);
    }

    if (mergeProps.length === 0)
      throw new OGMError(
        `upsert requires at least one scalar property in "where" for MERGE key: ` +
          `an @id or @unique field of ${nodeDef.typeName}.`,
      );

    // v2.6.0 — MERGE matches ALL its keys together, so `{ id, email }`
    // misses a node that has the email under another id and creates a
    // duplicate beside it (or fails on the unique constraint). Default:
    // compiled as before, with one warning; strict: exactly one key.
    if (mergeKeyNames.length > 1) {
      const keys = mergeKeyNames.map((k) => `"${k}"`).join(', ');
      if (this.strictMode.strict)
        throw new OGMError(
          `upsert "where" must name exactly one @id / @unique field of ${nodeDef.typeName}; got ${keys}. ` +
            `MERGE matches all of them together, so a node that has one but not the others is not found ` +
            `and a duplicate is created. Pass a single unique key.`,
        );
      this.strictMode.warn(
        'upsert-multiple-unique-keys',
        `${nodeDef.typeName}\u0000${mergeKeyNames.join(',')}`,
        `upsert on ${nodeDef.typeName} with several unique keys in "where" (${keys}) MERGEs on all of them ` +
          `together: a node that has one but not the others is not matched and a duplicate is created.`,
        'require exactly one unique key in an upsert "where"',
      );
    }

    lines.push(`MERGE (n:${labelStr} { ${mergeProps.join(', ')} })`);

    // ON CREATE SET — all properties from create input (scalar only)
    const createSets: string[] = [];
    for (const [key, value] of Object.entries(create)) {
      if (value === undefined) continue;
      if (nodeDef.relationships.has(key)) {
        if (value === null) continue;
        throw upsertRelationshipError(nodeDef, key, 'create');
      }
      assertSafePropertyName(key, 'create property');
      assertKnownField(nodeDef, key, 'create', this.strictMode);
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
    // `@id` values are generated on the ON CREATE branch exactly as
    // create() generates them — unless the caller supplied one in `create`
    // or it is already fixed by the MERGE key. Pre-2.4.1 nothing generated
    // it, so an upsert that created a node stored it without its `@id`.
    for (const [, propDef] of nodeDef.properties) {
      if (!propDef.isGenerated) continue;
      if (create[propDef.name] !== undefined) continue;
      if (mergeKeyNames.includes(propDef.name)) continue;
      createSets.push(`n.${escapeIdentifier(propDef.name)} = randomUUID()`);
    }
    // v2.6.0 — strict: runtime labels go on the node only when MERGE creates
    // it (see `labelsOnMatchedNodes`).
    const labelsOnCreate =
      this.strictMode.strict && labels && labels.length > 0;
    if (labelsOnCreate)
      createSets.push(`n:${labels.map((l) => assertSafeLabel(l)).join(':')}`);
    if (createSets.length > 0)
      lines.push(`ON CREATE SET ${createSets.join(', ')}`);

    // ON MATCH SET — all properties from update input (scalar only)
    const updateSets: string[] = [];
    for (const [key, value] of Object.entries(update)) {
      if (value === undefined) continue;
      if (nodeDef.relationships.has(key)) {
        if (value === null) continue;
        throw upsertRelationshipError(nodeDef, key, 'update');
      }
      assertSafePropertyName(key, 'update property');
      assertKnownField(nodeDef, key, 'update', this.strictMode);
      const propDef = nodeDef.properties.get(key);
      const paramName = `onMatch_${key}`;
      const valueExpr = wrapWriteExpr(`$${paramName}`, value, propDef);
      updateSets.push(`n.${escapeIdentifier(key)} = ${valueExpr}`);
      params[paramName] = coerceWriteValue(value, propDef);
    }
    if (updateGuard !== undefined && updateGuard.cypher !== '') {
      const guarded = buildGuardedMerge(
        labelStr,
        mergeProps,
        updateGuard,
        updateSets,
        params,
      );
      lines.unshift(...guarded.before);
      lines.push(...guarded.after);
    } else if (updateSets.length > 0)
      lines.push(`ON MATCH SET ${updateSets.join(', ')}`);

    // Extra labels. v2.6.1 — with an update guard, the rows that reach this
    // SET are the created node and an existing node that passed the guard.
    if (labels && labels.length > 0 && !labelsOnCreate) {
      const validatedLabels = labels.map((l) => assertSafeLabel(l)).join(':');
      lines.push(`SET n:${validatedLabels}`);
      this.labelsOnMatchedNodes(nodeDef, 'upsert');
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
    /**
     * v2.6.1 — the root type's `update` row filter on `n`. With
     * `skipDuplicates` and default-mode `labels`, an EXISTING node the
     * MERGE matched is relabelled only when it passes this guard (a label
     * change is an update, as `setLabels` enforces); created nodes get the
     * labels in `ON CREATE SET`.
     */
    updateGuard?: MatchGuard,
  ): MutationResult {
    if (data.length === 0) return { cypher: 'RETURN 0 AS count', params: {} };

    const labelStr = this.getCachedLabelString(nodeDef);
    const lines: string[] = [];
    const params: Record<string, unknown> = {};

    // Validate and sanitize: only scalar properties allowed. The column set
    // is the UNION of every item's keys — pre-2.4.6 it was `data[0]`'s
    // keys only, so a field that only later items supplied was silently
    // dropped (and a relationship field there was neither rejected nor
    // written).
    const scalarKeys: string[] = [];
    for (const [index, item] of data.entries())
      for (const key of Object.keys(item)) {
        if (item[key] === undefined || scalarKeys.includes(key)) continue;
        // v2.5.0 — rejected in EVERY item. Pre-2.5.0 only the first item's
        // relationship fields were; in later items the nested input was
        // skipped unwritten.
        // v2.5.3 — a `null` relationship field means "no nested write" and
        // is skipped, as upsert does. Pre-2.5.3 it threw.
        if (nodeDef.relationships.has(key) && item[key] === null) continue;
        if (nodeDef.relationships.has(key))
          throw new OGMError(
            `createMany does not support relationship fields. Found: "${key}" in data[${index}]. Use create() for nested operations.`,
          );
        assertSafePropertyName(key, 'createMany property');
        assertKnownField(nodeDef, key, 'createMany', this.strictMode);
        scalarKeys.push(key);
      }

    // Identify @id (generated) fields that are NOT provided in data
    const generatedFields: string[] = [];
    for (const [, propDef] of nodeDef.properties)
      if (propDef.isGenerated && !scalarKeys.includes(propDef.name))
        generatedFields.push(propDef.name);

    // A @id column supplied by SOME items only: the others still get a
    // generated id (as create() would), never null.
    const isPartialGenerated = (key: string) =>
      Boolean(nodeDef.properties.get(key)?.isGenerated) &&
      data.some((d) => d[key] === undefined || d[key] === null);
    const columnExpr = (key: string) => {
      const expr = wrapListItemExpr(
        `item.${escapeIdentifier(key)}`,
        data.map((d) => d[key]),
        nodeDef.properties.get(key),
      );
      return isPartialGenerated(key) ? `coalesce(${expr}, randomUUID())` : expr;
    };

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

    // Build sanitized items (strip undefined values). A `@default` field
    // whose column is supplied by only some items is filled per item for
    // the others — exactly what create() gives an item that omits it. An
    // explicit `null` is kept as null.
    const sanitizedItems = data.map((item) => {
      const sanitized: Record<string, unknown> = {};
      for (const key of scalarKeys) {
        const propDef = nodeDef.properties.get(key);
        if (item[key] !== undefined)
          sanitized[key] = coerceWriteValue(item[key], propDef);
        else if (
          propDef?.defaultValue !== undefined &&
          !propDef.isGenerated &&
          !propDef.isCypher
        )
          sanitized[key] = resolveDefaultWriteValue(propDef);
      }
      return sanitized;
    });
    params.items = sanitizedItems;

    lines.push('UNWIND $items AS item');

    const guardedLabels =
      Boolean(skipDuplicates) &&
      !this.strictMode.strict &&
      labels !== undefined &&
      labels.length > 0 &&
      updateGuard !== undefined &&
      updateGuard.cypher !== '';

    if (skipDuplicates) {
      // MERGE key: the unique/id fields EVERY item supplies — an item
      // missing one would MERGE on null, which Neo4j rejects.
      const mergeKeys: string[] = [];
      for (const key of scalarKeys) {
        const propDef = nodeDef.properties.get(key);
        if (
          propDef &&
          (propDef.isUnique || propDef.isGenerated) &&
          data.every((d) => d[key] !== undefined && d[key] !== null)
        )
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
          onCreateSets.push(`n.${escapeIdentifier(key)} = ${columnExpr(key)}`);

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

      // v2.6.0 — strict: labels only on the nodes MERGE creates.
      // v2.6.1 — also with an update guard: the matched nodes are
      // relabelled below, only where the guard passes.
      if (
        (this.strictMode.strict || guardedLabels) &&
        labels &&
        labels.length > 0
      )
        onCreateSets.push(
          `n:${labels.map((l) => assertSafeLabel(l)).join(':')}`,
        );

      if (onCreateSets.length > 0)
        lines.push(`ON CREATE SET ${onCreateSets.join(', ')}`);
    } else {
      // CREATE with all scalar properties + generated IDs
      const propParts: string[] = [];
      for (const field of generatedFields)
        propParts.push(`${escapeIdentifier(field)}: randomUUID()`);
      for (const key of scalarKeys)
        propParts.push(`${escapeIdentifier(key)}: ${columnExpr(key)}`);

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
    if (guardedLabels) {
      // v2.6.1 — matched nodes are relabelled only where the update guard
      // passes. Pre-2.6.1 `SET n:<labels>` ran on every node the MERGE
      // returned, so an existing node the context could not update was
      // relabelled. FOREACH keeps one row per item (invariant 2).
      const validatedLabels = labels!.map((l) => assertSafeLabel(l)).join(':');
      mergeParams(params, updateGuard!.params);
      lines.push('WITH n');
      if (updateGuard!.preludes && updateGuard!.preludes.length > 0)
        lines.push(...updateGuard!.preludes);
      lines.push(
        `FOREACH (__l IN CASE WHEN ${updateGuard!.cypher} THEN [1] ELSE [] END | SET n:${validatedLabels})`,
      );
      this.labelsOnMatchedNodes(nodeDef, 'createMany');
    } else if (
      labels &&
      labels.length > 0 &&
      !(skipDuplicates && this.strictMode.strict)
    ) {
      const validatedLabels = labels.map((l) => assertSafeLabel(l)).join(':');
      lines.push(`SET n:${validatedLabels}`);
      if (skipDuplicates) this.labelsOnMatchedNodes(nodeDef, 'createMany');
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
      assertKnownField(nodeDef, key, 'create', this.strictMode);
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

      if (value == null) continue;
      const relInput = value as Record<string, unknown>;

      // Union / interface targets: per-member keys (e.g. items: { Ebook:
      // { create: [...] } }) dispatch to the concrete member; an interface
      // also takes the flat `{ connect, create }` shape (v2.4.8 — pre-2.4.8
      // interface targets were skipped entirely, so nothing was written).
      const abstract = abstractTarget(relDef.target, this.schema);
      const memberEntries = abstract
        ? perMemberEntries(relInput, abstract, key)
        : null;

      if (memberEntries) {
        for (const [memberKey, memberValue] of memberEntries) {
          const memberNodeDef = this.schema.nodes.get(memberKey)!;

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

      const targetNodeDef = this.requireTargetDef(relDef);

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

    // v2.10.0 — strict item 22: only `create` / `connect` are read here.
    this.checkNestedWriteKeys(relInput, 'create field input', relDef);
    this.checkCreateItemKeys(relInput.create, relDef);

    // A flat interface input (v2.4.8): each create names its implementer.
    const abstract = abstractTarget(targetNodeDef.typeName, this.schema);

    // --- create ---
    if (relInput.create) {
      const createItems = Array.isArray(relInput.create)
        ? (relInput.create as Record<string, unknown>[])
        : [relInput.create as Record<string, unknown>];

      for (let ci = 0; ci < createItems.length; ci++) {
        const createSpec = createItems[ci];
        // v2.18.0 — pre-v2.18.0 a raw TypeError reading `.node`.
        if (createSpec == null)
          throw nullNestedItemError('create', relDef, createSpec);
        let nodeSpec = (createSpec.node ?? createSpec) as Record<
          string,
          unknown
        >;
        let createDef = targetNodeDef;
        if (abstract) {
          const [member, memberSpec] = unwrapAbstractCreateNode(
            nodeSpec,
            abstract,
            relDef.fieldName,
          );
          createDef = this.schema.nodes.get(member)!;
          nodeSpec = memberSpec;
        }
        const targetLabelStr = this.getCachedLabelString(createDef);

        const createVar = `${nodeVar}_c${startCounter + counter}`;
        counter++;

        const { propString, propParams } = this.buildCreateProperties(
          nodeSpec,
          createDef,
          `${prefix}_create${ci}`,
        );

        // Handle nested relationship creates within the created node
        const nestedRelLines = this.buildCreateRelationships(
          nodeSpec,
          createDef,
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
            : ` { ${this.buildGeneratedIdClause(createDef)} }`;

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
        this.checkEdgeKeys(relDef, edgeInput, 'nested create');
        const relVar = `r_edge_${startCounter + counter - 1}`;
        const defaultItems = this.edgeDefaultSetItems(
          relDef,
          edgeInput,
          relVar,
          `${prefix}_create${ci}`,
          params,
        );
        if (
          (edgeInput && Object.keys(edgeInput).length > 0) ||
          defaultItems.length > 0
        ) {
          // Re-match the relationship to set edge props
          const relArrow = buildRelPattern({
            sourceVar: nodeVar,
            relDef,
            targetVar: createVar,
            edgeVar: relVar,
            targetLabel: 'auto',
            // Abstract targets: no label — the created node never carries
            // the union / interface label (v2.4.8).
            schema: this.schema,
          });
          lines.push(`WITH ${[...allVars, createVar].join(', ')}`);
          lines.push(`MATCH ${relArrow}`);
          const setItems: string[] = [];
          for (const [prop, val] of Object.entries(edgeInput ?? {})) {
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
          setItems.push(...defaultItems);
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
        // Wrap in CALL subquery so a failed MATCH doesn't kill the outer pipeline
        const index = startCounter + counter;
        counter++;
        lines.push(
          ...this.buildConnectItem({
            connectSpec: connectItems[ci],
            relDef,
            targetNodeDef,
            sourceVar: nodeVar,
            withClause,
            connectVar: `${nodeVar}_cn${index}`,
            relVar: `r_conn_${index}`,
            edgeParamPrefix: `${prefix}_conn${ci}`,
            returnAlias: `_ccn_${prefix}_${ci}`,
            params,
            policyContext,
            paramCounter,
            scope: {
              sourceVar: nodeVar,
              carryVars: allVars,
              withClause,
              varPrefix: '',
              depth: 0,
            },
          }),
        );
      }
    }

    return { lines, counterUsed: counter };
  }

  /**
   * Top-level `connect`. A union / interface relationship keyed by member
   * (`{ media: { Book: [...] } }`, the shape codegen emits) connects each
   * member separately; a flat interface input matches the implementers by
   * their own labels (v2.4.8 — pre-2.4.8 both matched the abstract type's
   * label, which no node carries, and the per-member shape was never
   * unwrapped, so the MATCH carried NO filter at all).
   */
  private buildConnects(
    connect: Record<string, unknown>,
    nodeDef: NodeDefinition,
    params: Record<string, unknown>,
    policyContext?: PolicyContextBundle,
    paramCounter?: { count: number },
    scope: WriteScope = TOP_SCOPE,
  ): string[] {
    const lines: string[] = [];

    for (const [fieldName, spec] of Object.entries(connect)) {
      const relDef = nodeDef.relationships.get(fieldName);
      if (!relDef) {
        this.checkLinkRelationship(nodeDef, fieldName, spec, 'connect');
        continue;
      }
      // v2.5.1 — `{ rel: null }` (the generated input is `InputMaybe`)
      // connects nothing. Since 2.4.8 it reached the item compiler with no
      // `where`, so the MATCH had no filter and EVERY target was linked.
      if (spec == null) continue;

      const abstract = abstractTarget(relDef.target, this.schema);
      const memberEntries =
        abstract && !isBlanketSpec(spec)
          ? perMemberEntries(spec, abstract, fieldName)
          : null;
      if (memberEntries) {
        for (const [member, memberSpec] of memberEntries)
          lines.push(
            ...this.buildRelConnects(
              memberSpec,
              this.narrowToMember(relDef, member),
              this.schema.nodes.get(member)!,
              `${fieldName}_${member}`,
              params,
              policyContext,
              paramCounter,
              scope,
            ),
          );
        continue;
      }

      lines.push(
        ...this.buildRelConnects(
          spec,
          relDef,
          this.requireTargetDef(relDef),
          fieldName,
          params,
          policyContext,
          paramCounter,
          scope,
        ),
      );
    }

    return lines;
  }

  /**
   * One relationship's top-level connect. `tag` names its variables,
   * params and aliases: the field name, or `<field>_<Member>` for an
   * abstract relationship given per member, so two members never collide.
   */
  private buildRelConnects(
    spec: unknown,
    relDef: RelationshipDefinition,
    targetNodeDef: NodeDefinition,
    tag: string,
    params: Record<string, unknown>,
    policyContext: PolicyContextBundle | undefined,
    paramCounter: { count: number } | undefined,
    scope: WriteScope,
  ): string[] {
    const lines: string[] = [];
    const { sourceVar, withClause, varPrefix } = scope;

    // Array connect
    if (Array.isArray(spec)) {
      if (spec.length === 0) return lines; // Empty array — nothing to connect

      // The UNWIND fast path compiles filters against per-row values and
      // is only exact for plain scalar, non-null filters (see
      // isConnectFastPathEligible). Everything else — null values,
      // logical keys, traversals, abstract targets — takes one CALL
      // subquery per item, compiled through WhereCompiler.
      // v2.8.0 — in strict mode an `overwrite: false` item takes the
      // per-item path, which compiles its edge values to ON CREATE SET.
      const useFastPath =
        !abstractTarget(targetNodeDef.typeName, this.schema) &&
        this.isConnectFastPathEligible(
          spec as Record<string, unknown>[],
          targetNodeDef,
        ) &&
        !(
          this.strictMode.strict &&
          spec.some((it) => isPlainObject(it) && it.overwrite === false)
        );

      if (!useFastPath)
        for (let ci = 0; ci < spec.length; ci++)
          lines.push(
            ...this.buildConnectItem({
              connectSpec: spec[ci] as Record<string, unknown>,
              relDef,
              targetNodeDef,
              sourceVar,
              withClause,
              connectVar: `${varPrefix}target_${tag}_${ci}`,
              relVar: `${varPrefix}r_conn_${tag}_${ci}`,
              edgeParamPrefix: `${varPrefix}connect_${tag}_${ci}`,
              returnAlias: `_ccn_${varPrefix}${tag}_${ci}`,
              params,
              policyContext,
              paramCounter,
              scope,
            }),
          );
      else {
        // Every item is a plain object here (fast-path eligibility).
        for (const item of spec as Record<string, unknown>[]) {
          this.checkLinkItemKeys(item, 'connect', relDef);
          this.checkEdgeKeys(relDef, item.edge, 'connect');
          this.connectKeepsExistingEdge(item, relDef);
        }
        const targetVar = `${varPrefix}target`;
        const relVar = `${varPrefix}r`;
        const targetLabelStr = this.getCachedLabelString(targetNodeDef);
        // Scalar-only WHERE — use efficient UNWIND approach
        const paramName = `${varPrefix}connect_${tag}`;
        // Strip undefined values from edge objects — Neo4j driver drops undefined,
        // causing param mismatches when the Cypher references nested edge properties.
        params[paramName] = (spec as Record<string, unknown>[]).map((raw) => {
          // The WHERE reads `connItem.where.node.<key>`, so a bare-property
          // where (`{ where: { title } }`, which the fast path accepts) is
          // rebound under `node`. Pre-2.4.8 it was sent as-is: every lookup
          // was null, so the array connect silently linked nothing.
          const where = raw.where;
          const rebound =
            isPlainObject(where) &&
            !Object.keys(where).some((k) => CONNECTION_WHERE_KEYS.has(k))
              ? { ...raw, where: { node: where } }
              : raw;
          const item = this.coerceConnectItemWhere(rebound, targetNodeDef);
          const edge = item.edge as Record<string, unknown> | undefined;
          if (!edge) return item;
          const cleaned: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(edge))
            if (v !== undefined)
              cleaned[k] = coerceWriteValue(v, this.getEdgePropDef(relDef, k));

          return { ...item, edge: cleaned };
        });

        // Wrap in a CALL subquery: UNWIND + MATCH yields one row per
        // matched target (zero when nothing matches), which would
        // multiply — or drop — the updated node for every later clause.
        // Connecting to no target is a no-op, as in @neo4j/graphql.
        lines.push(withClause);
        lines.push('CALL {');
        lines.push(withClause);
        lines.push(`UNWIND $${paramName} AS connItem`);
        lines.push(`MATCH (${targetVar}:${targetLabelStr})`);

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
          targetVar,
          'connItem',
          targetNodeDef,
        );
        const policyPredicate = this.buildTargetPolicyPredicate(
          targetNodeDef,
          targetVar,
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
          sourceVar,
          relDef,
          targetVar,
        });
        lines.push(`MERGE ${mergePattern}`);

        // Handle edge properties from first item structure
        const edgeProps = this.extractEdgeProperties(firstItem);
        // Every item shares the first item's edge key set (checked above),
        // so the `@default`s it leaves out are the same for every row.
        const defaultItems = this.edgeDefaultSetItems(
          relDef,
          firstItem.edge,
          relVar,
          paramName,
          params,
        );
        if (edgeProps.length > 0 || defaultItems.length > 0) {
          // Use bare target var (no label) since target is already bound by MATCH
          assertSafeIdentifier(relDef.type, 'relationship type');
          const escapedRelType = escapeIdentifier(relDef.type);
          const mergeWithVar =
            relDef.direction === 'OUT'
              ? `(${sourceVar})-[${relVar}:${escapedRelType}]->(${targetVar})`
              : `(${sourceVar})<-[${relVar}:${escapedRelType}]-(${targetVar})`;
          // Replace MERGE line with one that has a variable
          lines[lines.length - 1] = `MERGE ${mergeWithVar}`;
          // r.prop is relationship property (escape), connItem.edge.prop is parameter map (no escape)
          const setItems = edgeProps.map(
            (p) =>
              `${relVar}.${escapeIdentifier(p)} = ${wrapListItemExpr(
                `connItem.edge.${p}`,
                (spec as Record<string, unknown>[]).map(
                  (it) => (it.edge as Record<string, unknown> | undefined)?.[p],
                ),
                this.getEdgePropDef(relDef, p),
              )}`,
          );
          lines.push(...edgeMergeSets(setItems, defaultItems, false));
        }

        lines.push(`RETURN count(*) AS _conn_${varPrefix}${tag}`);
        lines.push('}');
      }
      return lines;
    }

    // Single connect — same row-preserving isolation as the UNWIND path.
    return this.buildConnectItem({
      connectSpec: spec as Record<string, unknown>,
      relDef,
      targetNodeDef,
      sourceVar,
      withClause,
      connectVar: `${varPrefix}target`,
      relVar: `${varPrefix}r`,
      edgeParamPrefix: `${varPrefix}connect_${tag}`,
      returnAlias: `_conn_${varPrefix}${tag}`,
      params,
      policyContext,
      paramCounter,
      scope,
    });
  }

  /**
   * One connect item, isolated in a CALL subquery so a MATCH that finds
   * nothing (or many) never changes the outer row count:
   *
   *   <withClause>
   *   CALL {
   *     <withClause>
   *     MATCH (cv[:Label])
   *     WHERE <member labels> AND <where> AND <target `read` policy>
   *     MERGE (src)-[rv:REL]->(cv) [SET rv.<edge> = …]
   *     RETURN count(*) AS <alias>
   *   }
   *
   * Shared by every connect site (top-level, nested in create, nested in
   * update), which differ only in the names they pass.
   */
  private buildConnectItem(a: {
    connectSpec: Record<string, unknown>;
    relDef: RelationshipDefinition;
    targetNodeDef: NodeDefinition;
    sourceVar: string;
    withClause: string;
    connectVar: string;
    relVar: string;
    edgeParamPrefix: string;
    returnAlias: string;
    params: Record<string, unknown>;
    policyContext: PolicyContextBundle | undefined;
    paramCounter: { count: number } | undefined;
    scope: WriteScope;
  }): string[] {
    const { connectSpec, relDef, targetNodeDef, sourceVar, connectVar } = a;
    // v2.5.1 — every connect item reaches here (top-level, array, nested in
    // create / update / connect). A null or non-object item has no filter:
    // compiling it would MATCH, and link, every target node.
    if (!isPlainObject(connectSpec))
      throw new OGMError(
        `A connect item on "${relDef.fieldName}" must be an object such as { where: { node: { … } } }; got ${
          connectSpec === null ? 'null' : typeof connectSpec
        }.`,
      );
    this.checkLinkItemKeys(connectSpec, 'connect', relDef);
    this.checkEdgeKeys(relDef, connectSpec.edge, 'connect');
    const lines: string[] = [];
    const whereSpec = connectSpec.where as Record<string, unknown> | undefined;
    const edgeInput = connectSpec.edge as Record<string, unknown> | undefined;

    lines.push(a.withClause);
    lines.push('CALL {');
    lines.push(a.withClause);

    const { match, labelPredicate } = this.targetMatch(
      targetNodeDef,
      connectVar,
    );
    lines.push(match);

    const conditions = [
      labelPredicate,
      this.compileTargetWhere(
        whereSpec,
        connectVar,
        targetNodeDef,
        a.params,
        a.policyContext,
        a.paramCounter,
      ),
      this.buildTargetPolicyPredicate(
        targetNodeDef,
        connectVar,
        a.params,
        a.policyContext,
        a.paramCounter,
      ),
    ].filter((c): c is string => Boolean(c));
    if (conditions.length > 0) lines.push(`WHERE ${conditions.join(' AND ')}`);

    const keepExisting = this.connectKeepsExistingEdge(connectSpec, relDef);
    const defaultItems = this.edgeDefaultSetItems(
      relDef,
      edgeInput,
      a.relVar,
      a.edgeParamPrefix,
      a.params,
    );
    if (
      (edgeInput && Object.keys(edgeInput).length > 0) ||
      defaultItems.length > 0
    ) {
      // Use bare target var (no label) since connectVar is already bound by MATCH.
      // Including labels on a bound variable in MERGE causes Neo4j to reject it.
      assertSafeIdentifier(relDef.type, 'relationship type');
      const escapedRelType = escapeIdentifier(relDef.type);
      const mergePattern =
        relDef.direction === 'OUT'
          ? `(${sourceVar})-[${a.relVar}:${escapedRelType}]->(${connectVar})`
          : `(${sourceVar})<-[${a.relVar}:${escapedRelType}]-(${connectVar})`;
      lines.push(`MERGE ${mergePattern}`);
      const setItems: string[] = [];
      for (const [prop, val] of Object.entries(edgeInput ?? {})) {
        if (val === undefined) continue;
        assertSafePropertyName(prop, 'edge property');
        const edgePropDef = this.getEdgePropDef(relDef, prop);
        const paramName = `${a.edgeParamPrefix}_edge_${prop}`;
        setItems.push(
          `${a.relVar}.${escapeIdentifier(prop)} = ${wrapWriteExpr(
            `$${paramName}`,
            val,
            edgePropDef,
          )}`,
        );
        a.params[paramName] = coerceWriteValue(val, edgePropDef);
      }
      lines.push(...edgeMergeSets(setItems, defaultItems, keepExisting));
    } else {
      const relPattern = buildRelPattern({
        sourceVar,
        relDef,
        targetVar: connectVar,
      });
      lines.push(`MERGE ${relPattern}`);
    }

    // A `connect` nested in the item links the CONNECTED node onward
    // (`connect: { posts: [{ where, connect: { tags: [...] } }] }`), with
    // the same policy predicates at its level. Pre-2.4.8 it was ignored.
    const nested = connectSpec.connect;
    if (nested != null) {
      if (abstractTarget(targetNodeDef.typeName, this.schema))
        throw new OGMError(
          `A nested "connect" inside a connect on "${relDef.fieldName}" (abstract type "${targetNodeDef.typeName}") ` +
            `must be keyed by the implementing type, e.g. { ${relDef.fieldName}: { Member: [{ where, connect }] } }.`,
        );
      const inner = nestedScope(
        a.scope.carryVars,
        connectVar,
        a.scope.depth,
        a.edgeParamPrefix,
      );
      lines.push(
        ...this.gateOnUpdate(
          inner.withClause,
          targetNodeDef,
          connectVar,
          a.params,
          a.policyContext,
          a.paramCounter,
        ),
      );
      for (const nestedConnect of Array.isArray(nested) ? nested : [nested]) {
        if (!isPlainObject(nestedConnect))
          throw new OGMError(
            `A nested "connect" inside a connect on "${relDef.fieldName}" must be an object keyed by relationship.`,
          );
        lines.push(
          ...this.buildConnects(
            nestedConnect,
            targetNodeDef,
            a.params,
            a.policyContext,
            a.paramCounter,
            inner,
          ),
        );
      }
    }

    lines.push(`RETURN count(*) AS ${a.returnAlias}`);
    lines.push('}');
    return lines;
  }

  /**
   * Top-level `disconnect`. Abstract relationships follow the connect
   * rules (see buildConnects): per member, or flat on an interface,
   * matching implementers by their own labels (v2.4.8 — pre-2.4.8 the
   * target pattern used the interface / union label, so nothing matched).
   */
  private buildDisconnects(
    disconnect: Record<string, unknown>,
    nodeDef: NodeDefinition,
    params: Record<string, unknown>,
    policyContext?: PolicyContextBundle,
    paramCounter?: { count: number },
    scope: WriteScope = TOP_SCOPE,
  ): string[] {
    const lines: string[] = [];

    for (const [fieldName, spec] of Object.entries(disconnect)) {
      const relDef = nodeDef.relationships.get(fieldName);
      if (!relDef) {
        this.checkLinkRelationship(nodeDef, fieldName, spec, 'disconnect');
        continue;
      }

      const abstract = abstractTarget(relDef.target, this.schema);
      // `null` / `{}` stays a blanket disconnect of the whole relationship.
      const memberEntries =
        abstract && !isBlanketSpec(spec)
          ? perMemberEntries(spec, abstract, fieldName)
          : null;
      if (memberEntries) {
        for (const [member, memberSpec] of memberEntries)
          lines.push(
            ...this.buildRelDisconnects(
              memberSpec,
              this.narrowToMember(relDef, member),
              this.schema.nodes.get(member)!,
              `${fieldName}_${member}`,
              params,
              policyContext,
              paramCounter,
              scope,
            ),
          );
        continue;
      }

      lines.push(
        ...this.buildRelDisconnects(
          spec,
          relDef,
          resolveTargetDef(relDef.target, this.schema) ?? undefined,
          fieldName,
          params,
          policyContext,
          paramCounter,
          scope,
        ),
      );
    }

    return lines;
  }

  /**
   * A `disconnect` nested in a disconnect item unlinks the disconnected
   * node's OWN relationships (`disconnect: { posts: [{ where, disconnect:
   * { tags: [...] } }] }`), with the same policy predicates at its level.
   * Pre-2.4.8 it was ignored. `''`-free: no input, no lines.
   */
  private buildNestedDisconnect(
    nested: unknown,
    relDef: RelationshipDefinition,
    targetNodeDef: NodeDefinition,
    targetVar: string,
    carryVars: string[],
    params: Record<string, unknown>,
    policyContext: PolicyContextBundle | undefined,
    paramCounter: { count: number } | undefined,
    depth = 0,
    /** Unique along the write path; see `nestedScope`. */
    uniqueToken: string = targetVar,
  ): string[] {
    if (nested == null) return [];
    if (abstractTarget(targetNodeDef.typeName, this.schema))
      throw new OGMError(
        `A nested "disconnect" inside a disconnect on "${relDef.fieldName}" (abstract type "${targetNodeDef.typeName}") ` +
          `must be keyed by the implementing type, e.g. { ${relDef.fieldName}: { Member: [{ where, disconnect }] } }.`,
      );
    const inner = nestedScope(carryVars, targetVar, depth, uniqueToken);
    const lines = this.gateOnUpdate(
      inner.withClause,
      targetNodeDef,
      targetVar,
      params,
      policyContext,
      paramCounter,
    );
    for (const nestedDisconnect of Array.isArray(nested) ? nested : [nested]) {
      if (!isPlainObject(nestedDisconnect))
        throw new OGMError(
          `A nested "disconnect" inside a disconnect on "${relDef.fieldName}" must be an object keyed by relationship.`,
        );
      lines.push(
        ...this.buildDisconnects(
          nestedDisconnect,
          targetNodeDef,
          params,
          policyContext,
          paramCounter,
          inner,
        ),
      );
    }
    return lines;
  }

  /**
   * v2.18.0 — strict item 31: a `null` / `undefined` ITEM inside a disconnect
   * array (`disconnect: { posts: [{ where }, undefined] }`, typically an
   * unset optional variable). It compiles to the blanket form, so every
   * related node is unlinked, not just the ones the other items name.
   * `disconnect: { posts: null }` and an `{}` item stay the documented
   * blanket disconnect in both modes. Default: one warning per OGM and
   * relationship field, and the blanket disconnect as before; strict:
   * `OGMError` (as a null connect item has thrown since v2.5.1).
   */
  private checkNullDisconnectItem(
    item: null | undefined,
    relDef: RelationshipDefinition,
  ): void {
    const got = item === null ? 'null' : 'undefined';
    if (this.strictMode.strict)
      throw new OGMError(
        `A disconnect item on "${relDef.fieldName}" is ${got}. An item inside a disconnect array must be ` +
          `an object such as { where: { node: { … } } }; to unlink every related node pass ` +
          `{ ${relDef.fieldName}: [{}] } or { ${relDef.fieldName}: null }.`,
      );
    this.strictMode.warn(
      'disconnect-null-item',
      relDef.fieldName,
      `A ${got} item inside the disconnect array of "${relDef.fieldName}" unlinks EVERY related node ` +
        `(it compiles to the blanket disconnect), not only the nodes the other items name.`,
      'throw an OGMError for a null / undefined disconnect item',
    );
  }

  /**
   * vNEXT — strict item 41: a disconnect item that is not an object — a
   * string, number, boolean or array (`disconnect: { posts: ['p1'] }`,
   * `posts: true`, a nested `disconnect: [5]`). It carries no `where`, so
   * it compiled to the blanket form and unlinked EVERY related node (the
   * target's read policy still applied). Like item 31 (null items), which
   * it extends: default warns once per OGM and relationship field and keeps
   * the blanket disconnect; strict throws `OGMError`, as a non-object
   * connect item has since v2.5.1.
   */
  private checkNonObjectDisconnectItem(
    item: unknown,
    relDef: RelationshipDefinition,
  ): void {
    const got = Array.isArray(item) ? 'an array' : `a ${typeof item}`;
    if (this.strictMode.strict)
      throw new OGMError(
        `A disconnect item on "${relDef.fieldName}" is ${got}. A disconnect item must be ` +
          `an object such as { where: { node: { … } } }; to unlink every related node pass ` +
          `{ ${relDef.fieldName}: [{}] } or { ${relDef.fieldName}: null }.`,
      );
    this.strictMode.warn(
      'disconnect-non-object-item',
      relDef.fieldName,
      `A disconnect item on "${relDef.fieldName}" is ${got}, not an object: it unlinks EVERY ` +
        `related node (it compiles to the blanket disconnect).`,
      'throw an OGMError for a disconnect item that is not an object',
    );
  }

  /** One relationship's disconnect items; `tag` as in buildRelConnects. */
  private buildRelDisconnects(
    spec: unknown,
    relDef: RelationshipDefinition,
    targetNodeDef: NodeDefinition | undefined,
    tag: string,
    params: Record<string, unknown>,
    policyContext: PolicyContextBundle | undefined,
    paramCounter: { count: number } | undefined,
    scope: WriteScope,
  ): string[] {
    const lines: string[] = [];
    const { sourceVar, withClause, varPrefix } = scope;

    // Normalize spec to an array of disconnect items
    const specItems: Array<Record<string, unknown> | null | undefined> =
      Array.isArray(spec) ? spec : [spec as Record<string, unknown>];

    for (let si = 0; si < specItems.length; si++) {
      const item = specItems[si];
      if (item == null && Array.isArray(spec))
        this.checkNullDisconnectItem(item, relDef);
      else if (item != null && !isPlainObject(item))
        this.checkNonObjectDisconnectItem(item, relDef);
      const relVar = `${varPrefix}r_${tag}_${si}`;

      // Wrap in a CALL subquery: the OPTIONAL MATCH yields one row per
      // matched relationship, which would multiply every later clause.
      // `count(*)` collapses it back to exactly one row per `n`.
      lines.push(withClause);
      lines.push('CALL {');
      lines.push(withClause);

      if (
        item == null ||
        (typeof item === 'object' && Object.keys(item).length === 0)
      ) {
        // Blanket disconnect — remove every relationship of this type to
        // a target the caller can READ. Like the `where` branch below, a
        // policy-bound context only unlinks nodes it can see; pre-2.4.4
        // the blanket form bound an anonymous `()` and also severed links
        // to policy-hidden nodes. Without policies there is no predicate
        // and the Cypher is unchanged.
        const blanketTarget = `${varPrefix}target_${tag}_${si}`;
        const predicate = targetNodeDef
          ? this.buildTargetPolicyPredicate(
              targetNodeDef,
              blanketTarget,
              params,
              policyContext,
              paramCounter,
            )
          : undefined;
        const { labelRaw, labelPredicate } = this.blanketRestriction(
          relDef,
          targetNodeDef,
          blanketTarget,
        );
        const pattern = buildRelPattern({
          sourceVar,
          relDef,
          targetVar: predicate || labelPredicate ? blanketTarget : '',
          edgeVar: relVar,
          targetLabelRaw: labelRaw,
        });
        lines.push(`OPTIONAL MATCH ${pattern}`);
        const blanketConditions = [labelPredicate, predicate].filter(Boolean);
        if (blanketConditions.length > 0)
          lines.push(`WHERE ${blanketConditions.join(' AND ')}`);
        lines.push(`DELETE ${relVar}`);
      } else {
        // Specific disconnect with conditions
        const disconnectSpec = item as Record<string, unknown>;
        if (isPlainObject(disconnectSpec))
          this.checkLinkItemKeys(disconnectSpec, 'disconnect', relDef);
        const whereSpec = disconnectSpec.where as
          | Record<string, unknown>
          | undefined;

        const targetVar = `${varPrefix}target_${tag}_${si}`;
        const pattern = buildRelPattern({
          sourceVar,
          relDef,
          targetVar,
          edgeVar: relVar,
          targetLabel: 'auto',
          // An abstract target binds no label (its nodes carry their
          // members' labels); the member predicate below narrows it.
          schema: this.schema,
        });
        lines.push(`OPTIONAL MATCH ${pattern}`);

        if (!targetNodeDef)
          throw new OGMError(
            `Cannot resolve the target type "${relDef.target}" of relationship "${relDef.fieldName}".`,
          );
        const labelPredicate = abstractTarget(
          targetNodeDef.typeName,
          this.schema,
        )
          ? this.targetMatch(targetNodeDef, targetVar).labelPredicate
          : null;
        const disconnectConditions = [
          labelPredicate,
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
        lines.push(
          ...this.buildNestedDisconnect(
            disconnectSpec.disconnect,
            relDef,
            targetNodeDef,
            targetVar,
            scope.carryVars,
            params,
            policyContext,
            paramCounter,
            scope.depth,
          ),
        );
      }

      lines.push(`RETURN count(*) AS _${relVar}`);
      lines.push('}');
    }

    return lines;
  }

  /**
   * Relationships narrowed from an abstract target to one member by the
   * per-member dispatch. A BLANKET disconnect on one adds the member's
   * label: the relationship type alone also reaches the other members, so
   * pre-2.4.8 `{ Ebook: [{ disconnect: [{}] }] }` unlinked every member.
   */
  private narrowedRelDefs = new WeakSet<RelationshipDefinition>();

  private narrowToMember(
    relDef: RelationshipDefinition,
    member: string,
  ): RelationshipDefinition {
    const narrowed: RelationshipDefinition = { ...relDef, target: member };
    this.narrowedRelDefs.add(narrowed);
    return narrowed;
  }

  /**
   * v2.6.0 — how a blanket disconnect (`null` / `{}`) restricts its target.
   *
   * Default (v2.5.3): only a relationship narrowed to a union / interface
   * member keeps that member's label; otherwise the target is anonymous,
   * so with two fields on one relationship type and direction
   * (`pets: [Pet]`, `toys: [Toy]`, both `HAS`) a blanket disconnect of one
   * also unlinks the other's nodes (warned once at OGM construction).
   *
   * Strict: the field's own target type — its label, or for an abstract
   * target a predicate over its members' labels on `targetVar`.
   */
  private blanketRestriction(
    relDef: RelationshipDefinition,
    targetNodeDef: NodeDefinition | undefined,
    targetVar: string,
  ): { labelRaw: string | undefined; labelPredicate: string | null } {
    const narrowed = this.blanketTargetLabel(relDef);
    if (narrowed || !this.strictMode.strict || !targetNodeDef)
      return { labelRaw: narrowed, labelPredicate: null };
    if (abstractTarget(targetNodeDef.typeName, this.schema))
      return {
        labelRaw: undefined,
        labelPredicate: this.targetMatch(targetNodeDef, targetVar)
          .labelPredicate,
      };
    return {
      labelRaw: this.getCachedLabelString(targetNodeDef),
      labelPredicate: null,
    };
  }

  /** The label a blanket disconnect over `relDef` must keep (see above). */
  private blanketTargetLabel(
    relDef: RelationshipDefinition,
  ): string | undefined {
    if (!this.narrowedRelDefs.has(relDef)) return undefined;
    return this.getCachedLabelString(this.schema.nodes.get(relDef.target)!);
  }

  /**
   * Dispatch update operations for a union- or interface-typed
   * relationship given per member (interfaces since v2.4.8).
   * Each member key in the input is recursed into buildUpdateRelationships
   * with a narrowed relDef pointing at the concrete member type.
   */
  private dispatchUnionUpdateOps(
    key: string,
    memberEntries: [string, unknown][],
    relDef: RelationshipDefinition,
    nodeDef: NodeDefinition,
    sourceVar: string,
    prefix: string,
    params: Record<string, unknown>,
    depth: number,
    ancestorVars: string[],
    policyContext?: PolicyContextBundle,
    paramCounter?: { count: number },
    deleted?: Set<string>,
    state?: NestedUpdateState,
    iterated?: readonly string[],
  ): string[] {
    const lines: string[] = [];

    for (const [memberKey, memberValue] of memberEntries) {
      const memberRelDef = this.narrowToMember(relDef, memberKey);
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
          deleted,
          state,
          iterated,
        ),
      );
    }

    return lines;
  }

  /** The concrete node types a value of `typeName` can be. */
  private concreteTypes(typeName: string): string[] {
    return abstractTarget(typeName, this.schema)?.members ?? [typeName];
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
    /**
     * v2.8.0 — collects the concrete types a nested `delete` at or below
     * this level may delete, for the enclosing level's guard (F1).
     */
    deleted: Set<string> = new Set<string>(),
    state: NestedUpdateState = {
      guardDeleted: false,
      cycleDelete: false,
      feedback: new Set<string>(),
    },
    /**
     * v2.8.0 — `Type.field` of every relationship an enclosing nested
     * update item iterates (F2).
     */
    iterated: readonly string[] = [],
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

    // v2.8.0 — finding F1. A nested delete reached through a cycle
    // (chart -> tags -> charts) can delete `sourceVar` itself. A later
    // clause that reads or writes it — the root's response projection or
    // read-policy filter, a CREATE from it — then fails with
    // `EntityNotFound` (SET and MATCH on it are silently no-ops, and
    // `updateMany`'s `count(n)` still counts it). After an op block that
    // may delete a type `sourceVar` can be, `guardAfter` records the shape
    // and, when guarding (strict mode, or the re-run of a default-mode
    // statement that failed), keeps the row only while `sourceVar` exists.
    // Without the guard the Cypher is byte-identical to v2.7.0.
    const sourceTypes = this.concreteTypes(nodeDef.typeName);
    const guardAfter = (types: Iterable<string>): void => {
      let hit = false;
      for (const t of types) {
        deleted.add(t);
        if (sourceTypes.includes(t)) hit = true;
      }
      if (!hit) return;
      state.cycleDelete = true;
      if (state.guardDeleted)
        lines.push(withClause, `WHERE ${aliveGuard(sourceVar)}`);
    };

    for (const [key, value] of Object.entries(update)) {
      const relDef = nodeDef.relationships.get(key);
      if (!relDef || value == null) continue;

      // Union / interface targets given per member — dispatch each member
      // recursively. A flat interface input is handled below against the
      // interface (v2.4.8 — pre-2.4.8 it was skipped, writing nothing).
      const abstract = abstractTarget(relDef.target, this.schema);
      const memberEntries = abstract
        ? perMemberEntries(value, abstract, key)
        : null;

      if (memberEntries) {
        lines.push(
          ...this.dispatchUnionUpdateOps(
            key,
            memberEntries,
            relDef,
            nodeDef,
            sourceVar,
            prefix,
            params,
            depth,
            ancestorVars,
            policyContext,
            paramCounter,
            deleted,
            state,
            iterated,
          ),
        );
        continue;
      }

      const targetNodeDef = this.requireTargetDef(relDef);
      const relPrefix = `${prefix}_${key}`;
      // Past the dispatch, `abstract` is set only for a flat INTERFACE
      // input (a flat union input threw in perMemberEntries).

      // v2.8.0 — finding F2. A `connect` / `create` on a field an ENCLOSING
      // nested update item iterates (chart -> categories -> charts ->
      // categories) adds links that the enclosing item's MATCH sees again
      // for every later row (the statement's own writes are visible to its
      // later rows, as in @neo4j/graphql), so the work can grow
      // geometrically with the matched rows. Snapshot semantics are not
      // offered (see the README); recorded here for a warning.
      const field = `${nodeDef.typeName}.${key}`;

      // Value can be an array (e.g., chapters: [{ create: ... }, { update: ... }])
      // or an object (e.g., author: { connect: ... })
      const items = Array.isArray(value)
        ? (value as Record<string, unknown>[])
        : [value as Record<string, unknown>];
      if (
        iterated.includes(field) &&
        items.some(
          (it) =>
            isPlainObject(it) && (it.connect != null || it.create != null),
        )
      )
        state.feedback.add(field);

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        // v2.18.0 — pre-v2.18.0 a null / undefined item threw a raw TypeError.
        if (item == null) throw nullNestedItemError('update', relDef, item);
        const itemPrefix = `${relPrefix}_${i}`;
        // v2.10.0 — strict item 22: unknown keys in the item, its create
        // items and its `update` body.
        this.checkUpdateItemKeys(item, relDef);

        // --- delete (detach delete target nodes) ---
        // Shared with `compileDelete`'s cascade: where + target `delete`
        // policy, one CALL subquery per spec item (v2.3.0).
        if (item.delete) {
          const deleteLines = this.buildNestedDelete({
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
          });
          lines.push(...deleteLines);
          if (deleteLines.length > 0)
            guardAfter(this.concreteTypes(targetNodeDef.typeName));
        }

        // --- disconnect (runs before connect so "disconnect all + connect new" works) ---
        if (item.disconnect) {
          const disconnectItems = Array.isArray(item.disconnect)
            ? (item.disconnect as Record<string, unknown>[])
            : [item.disconnect as Record<string, unknown>];

          for (let di = 0; di < disconnectItems.length; di++) {
            const disconnectSpec = disconnectItems[di];
            // v2.18.0 — pre-v2.18.0 a null / undefined item threw a raw
            // TypeError reading `.where`.
            if (disconnectSpec == null)
              throw nullNestedItemError('disconnect', relDef, disconnectSpec);
            if (!isPlainObject(disconnectSpec))
              this.checkNonObjectDisconnectItem(disconnectSpec, relDef);
            if (isPlainObject(disconnectSpec))
              this.checkLinkItemKeys(disconnectSpec, 'disconnect', relDef);
            const whereSpec = disconnectSpec.where as
              | Record<string, unknown>
              | undefined;
            // A nested `disconnect` needs the target bound, so an item that
            // carries one is never the anonymous blanket form.
            const nestedDisconnect = disconnectSpec.disconnect;

            const relVar = `r_disc_${key}_${i}_${di}`;

            // Same isolation as the top-level disconnect: keep the
            // OPTIONAL MATCH fan-out from multiplying later nested ops.
            lines.push(withClause);
            lines.push('CALL {');
            lines.push(withClause);

            if (
              (!whereSpec || Object.keys(whereSpec).length === 0) &&
              nestedDisconnect == null
            ) {
              // Blanket — same read-policy gate as the top-level blanket
              // disconnect: only unlink targets the caller can read.
              const blanketTarget = `${sourceVar}_disc${varCounter}`;
              const predicate = this.buildTargetPolicyPredicate(
                targetNodeDef,
                blanketTarget,
                params,
                policyContext,
                paramCounter,
              );
              const { labelRaw, labelPredicate } = this.blanketRestriction(
                relDef,
                targetNodeDef,
                blanketTarget,
              );
              if (predicate || labelPredicate) varCounter++;
              const pattern = buildRelPattern({
                sourceVar,
                relDef,
                targetVar: predicate || labelPredicate ? blanketTarget : '',
                edgeVar: relVar,
                targetLabelRaw: labelRaw,
              });
              lines.push(`OPTIONAL MATCH ${pattern}`);
              const blanketConditions = [labelPredicate, predicate].filter(
                Boolean,
              );
              if (blanketConditions.length > 0)
                lines.push(`WHERE ${blanketConditions.join(' AND ')}`);
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
                // An interface target matches its implementers, which do
                // not carry the interface label (v2.4.8).
                schema: this.schema,
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
                abstract
                  ? this.targetMatch(targetNodeDef, discTarget).labelPredicate
                  : null,
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
              lines.push(
                ...this.buildNestedDisconnect(
                  nestedDisconnect,
                  relDef,
                  targetNodeDef,
                  discTarget,
                  allVars,
                  params,
                  policyContext,
                  paramCounter,
                  0,
                  // `discTarget` restarts per member under union dispatch;
                  // `itemPrefix` is unique along the path.
                  `${itemPrefix}_disc${di}`,
                ),
              );
            }

            lines.push(`RETURN count(*) AS _${relVar}`);
            lines.push('}');
          }
        }

        // v2.9.0 — `connect` + `create` and the nested `update` are emitted
        // by these two closures, in an order that depends on strict mode
        // (see the end of the item loop).
        const emitLinks = (): void => {
          // --- connect ---
          if (item.connect) {
            const connectItems = Array.isArray(item.connect)
              ? (item.connect as Record<string, unknown>[])
              : [item.connect as Record<string, unknown>];

            for (let ci = 0; ci < connectItems.length; ci++) {
              // Wrap in CALL subquery so a failed MATCH doesn't kill the outer pipeline
              const connectVar = `${sourceVar}_conn${varCounter}`;
              varCounter++;
              lines.push(
                ...this.buildConnectItem({
                  connectSpec: connectItems[ci],
                  relDef,
                  targetNodeDef,
                  sourceVar,
                  withClause,
                  connectVar,
                  relVar: `r_conn_${key}_${ci}`,
                  edgeParamPrefix: `${itemPrefix}_conn${ci}`,
                  returnAlias: `_cn_${key}_${ci}`,
                  params,
                  policyContext,
                  paramCounter,
                  scope: {
                    sourceVar,
                    carryVars: allVars,
                    withClause,
                    varPrefix: '',
                    depth: 0,
                  },
                }),
              );
            }
          }

          // --- create ---
          // Runs after disconnect and connect (as in @neo4j/graphql), so a
          // same-item `disconnect: [{}]` + `create` keeps the new node linked.
          // Pre-2.4.2 create ran first and the disconnect-all removed it.
          if (item.create) {
            const createItems = Array.isArray(item.create)
              ? (item.create as Record<string, unknown>[])
              : [item.create as Record<string, unknown>];

            for (let ci = 0; ci < createItems.length; ci++) {
              const createSpec = createItems[ci];
              // v2.18.0 — pre-v2.18.0 a raw TypeError reading `.node`.
              if (createSpec == null)
                throw nullNestedItemError('create', relDef, createSpec);
              let nodeSpec = (createSpec.node ?? createSpec) as Record<
                string,
                unknown
              >;
              // Flat interface input: the create names its implementer.
              let createDef = targetNodeDef;
              if (abstract) {
                const [member, memberSpec] = unwrapAbstractCreateNode(
                  nodeSpec,
                  abstract,
                  key,
                );
                createDef = this.schema.nodes.get(member)!;
                nodeSpec = memberSpec;
              }
              const targetLabelStr = this.getCachedLabelString(createDef);

              const createVar = `${sourceVar}_cr${varCounter}`;
              varCounter++;

              const { propString, propParams } = this.buildCreateProperties(
                nodeSpec,
                createDef,
                `${itemPrefix}_create${ci}`,
              );

              // Handle nested relationship creates within the created node
              const nestedRelLines = this.buildCreateRelationships(
                nodeSpec,
                createDef,
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
                  : ` { ${this.buildGeneratedIdClause(createDef)} }`;

              // `edge` properties on the new relationship — the same input
              // create() accepts. Pre-2.4.5 this path never read
              // `createSpec.edge`, so they were silently dropped.
              const edgeInput = createSpec.edge as
                | Record<string, unknown>
                | undefined;
              this.checkEdgeKeys(relDef, edgeInput, 'nested create');
              const edgeEntries = Object.entries(edgeInput ?? {}).filter(
                ([, v]) => v !== undefined,
              );
              const defaultItems = this.edgeDefaultSetItems(
                relDef,
                edgeInput,
                `${createVar}_e`,
                `${itemPrefix}_create${ci}`,
                params,
              );
              const edgeVar =
                edgeEntries.length || defaultItems.length
                  ? `${createVar}_e`
                  : undefined;

              const relPattern = buildRelPattern({
                sourceVar,
                relDef,
                targetVar: createVar,
                edgeVar,
              });

              // Wrap in CALL subquery so failed connect MATCHes don't kill the outer pipeline
              const hasNestedOps = nestedRelLines.length > 0;
              if (hasNestedOps) {
                lines.push(withClause);
                lines.push(`CALL {`);
                lines.push(withClause);
              } else lines.push(withClause);

              lines.push(
                `CREATE (${createVar}:${targetLabelStr}${propsClause})`,
              );
              mergeParams(params, propParams);
              lines.push(`CREATE ${relPattern}`);

              if (edgeVar) {
                const setItems = edgeEntries.map(([prop, val]) => {
                  assertSafePropertyName(prop, 'edge property');
                  const edgePropDef = this.getEdgePropDef(relDef, prop);
                  const paramName = `${itemPrefix}_create${ci}_edge_${prop}`;
                  params[paramName] = coerceWriteValue(val, edgePropDef);
                  return `${edgeVar}.${escapeIdentifier(prop)} = ${wrapWriteExpr(
                    `$${paramName}`,
                    val,
                    edgePropDef,
                  )}`;
                });
                setItems.push(...defaultItems);
                lines.push(`SET ${setItems.join(', ')}`);
              }

              if (hasNestedOps) {
                lines.push(...nestedRelLines);
                lines.push(`RETURN count(*) AS _cc_${key}_${ci}`);
                lines.push(`}`);
              }
            }
          }
        };

        const emitUpdate = (): void => {
          // --- update (nested) ---
          if (item.update) {
            const updateSpec = item.update as Record<string, unknown>;
            const edgeUpdate = updateSpec.edge as
              | Record<string, unknown>
              | undefined;
            const nodeUpdate = (updateSpec.node ??
              (edgeUpdate ? {} : updateSpec)) as Record<string, unknown>;
            const updateWhere = item.where as
              | Record<string, unknown>
              | undefined;
            // A flat interface update writes the interface's own fields; the
            // per-implementer `_on` form is not supported (v2.4.8).
            if (abstract && isPlainObject(nodeUpdate) && '_on' in nodeUpdate)
              throw new OGMError(
                `"_on" in a nested update of "${key}" is not supported. Key the update by implementing type instead ` +
                  `(e.g. { ${key}: { ${abstract.members[0] ?? 'Member'}: [{ where, update }] } }).`,
              );

            // v2.6.2 — `node` keyed by implementing type: each member's body
            // runs as that member's nested update (same `where`, same
            // `edge`), exactly as `{ [key]: { Member: [{ where, update }] } }`.
            const memberBodies = perMemberUpdateBodies(
              nodeUpdate,
              abstract,
              targetNodeDef,
              key,
            );
            if (memberBodies) {
              lines.push(
                ...this.dispatchUnionUpdateOps(
                  key,
                  memberBodies.map(([member, body]) => [
                    member,
                    [
                      {
                        ...(updateWhere !== undefined
                          ? { where: updateWhere }
                          : {}),
                        update: {
                          node: body,
                          ...(edgeUpdate !== undefined
                            ? { edge: edgeUpdate }
                            : {}),
                        },
                      },
                    ],
                  ]),
                  relDef,
                  nodeDef,
                  sourceVar,
                  `${itemPrefix}_upd`,
                  params,
                  depth,
                  ancestorVars,
                  policyContext,
                  paramCounter,
                  deleted,
                  state,
                  iterated,
                ),
              );
              return;
            }

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
              assertKnownField(
                targetNodeDef,
                prop,
                'nested update',
                this.strictMode,
              );
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
            this.checkEdgeKeys(relDef, edgeUpdate, 'nested update');
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
            const nestedDeleted = new Set<string>();
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
              nestedDeleted,
              state,
              [...iterated, field],
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
                schema: this.schema,
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
                // v2.5.1 — restrict an interface / union target to its member
                // types; without it the nested update also SET properties on
                // other nodes on the same relationship type.
                this.targetMatch(targetNodeDef, updateVar).labelPredicate,
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
              guardAfter(nestedDeleted);
            }
          }
        };

        // v2.9.0 — order of `update` against `connect` / `create`. 2.x runs
        // the nested `update` last (delete, disconnect, connect, create,
        // update), so its MATCH also reaches the nodes this item just
        // linked. @neo4j/graphql 5.x runs it before them (delete,
        // disconnect, update, connect, create), so it only touches the
        // relationships that existed before. Strict mode takes the
        // @neo4j/graphql order; default mode keeps the 2.x Cypher byte for
        // byte and warns once per field when the item has both.
        if (this.strictMode.strict) {
          emitUpdate();
          emitLinks();
        } else {
          if (item.update && (item.connect || item.create))
            this.strictMode.warn(
              'nested-update-op-order',
              field,
              `A nested update item on "${field}" has \`update\` together with \`connect\` / \`create\`. ` +
                `2.x runs \`connect\` / \`create\` before \`update\`, so the update also matches the nodes ` +
                `the same item just linked (@neo4j/graphql runs \`update\` first, on the existing relationships only).`,
              'run the `update` before the `connect` / `create` of the same item, as @neo4j/graphql does',
            );
          emitLinks();
          emitUpdate();
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

  /**
   * v2.18.0 — coerce the `where.node` values of one UNWIND fast-path connect
   * item to the stored representation, as the WhereCompiler does for every
   * other filter (`coerceWhereValue`). Pre-v2.18.0 the values were bound raw:
   * a BigInt / Int filter given as an integer string (the generated BigInt
   * input type) or a `bigint` never equalled the stored Long, so an array
   * connect silently linked nothing while the same item given alone (per-
   * item path, WhereCompiler) linked its target.
   */
  private coerceConnectItemWhere(
    item: Record<string, unknown>,
    targetNodeDef: NodeDefinition,
  ): Record<string, unknown> {
    const where = item.where;
    if (!isPlainObject(where) || !isPlainObject(where.node)) return item;
    const nodeWhere = where.node;
    let coerced: Record<string, unknown> | undefined;
    for (const [key, val] of Object.entries(nodeWhere)) {
      const { baseProp } = this.parseOperatorSuffix(key);
      // vNEXT — strict item 42, as in the WhereCompiler.
      checkWhereJsDate(
        val,
        targetNodeDef.properties.get(baseProp),
        key.slice(baseProp.length),
        this.strictMode,
        targetNodeDef.typeName,
      );
      const next = coerceWhereValue(
        val,
        targetNodeDef.properties.get(baseProp),
        key.slice(baseProp.length),
      );
      if (next === val) continue;
      coerced ??= { ...nodeWhere };
      coerced[key] = next;
    }
    return coerced ? { ...item, where: { ...where, node: coerced } } : item;
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
      const propDef = targetNodeDef?.properties.get(baseProp);
      const suffix = key.slice(baseProp.length);
      const valueRef = wrapWhereParam(
        `${itemVar}.where.node.${key}`,
        coerceWhereValue(nodeWhere[key], propDef, suffix),
        propDef,
        suffix,
      );
      const fieldRef = `${targetVar}.${escapeIdentifier(baseProp)}`;
      // v2.15.0 — Duration ranges, as in the WhereCompiler.
      const durationRange = compileDurationRange(
        suffix,
        fieldRef,
        valueRef,
        propDef,
        this.strictMode,
        targetNodeDef?.typeName,
      );
      if (durationRange !== null) {
        conditions.push(durationRange);
        continue;
      }
      conditions.push(
        template.replace('%v', fieldRef).replace('$%p', valueRef),
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
 * v2.18.0 — the OGMError for a `null` / `undefined` item inside a nested
 * write array (`update: { posts: [{ disconnect: [undefined] }] }`). These
 * items used to reach property reads and throw a raw TypeError.
 */
function nullNestedItemError(
  kind: 'create' | 'update' | 'disconnect',
  relDef: RelationshipDefinition,
  item: null | undefined,
): OGMError {
  const shape =
    kind === 'create'
      ? '{ node: { … }, edge?: { … } }'
      : kind === 'update'
        ? '{ where?, update?, connect?, disconnect?, create?, delete? }'
        : '{ where: { node: { … } } } (or {} to unlink every related node)';
  return new OGMError(
    `A nested ${kind} item on "${relDef.fieldName}" must be an object such as ${shape}; got ${
      item === null ? 'null' : 'undefined'
    }.`,
  );
}

/**
 * v2.8.0 — the SET clauses after a connect's `MERGE` of the relationship.
 * `defaults` (strict-mode edge `@default`s) apply only when the MERGE
 * creates it; `explicit` edge values too when `keepExisting`
 * (`overwrite: false` in strict mode), otherwise on every match. With no
 * defaults and `keepExisting` false this is the pre-2.8.0 `SET …`.
 */
function edgeMergeSets(
  explicit: string[],
  defaults: string[],
  keepExisting: boolean,
): string[] {
  if (keepExisting) {
    const all = [...explicit, ...defaults];
    return all.length > 0 ? [`ON CREATE SET ${all.join(', ')}`] : [];
  }
  const out: string[] = [];
  if (defaults.length > 0) out.push(`ON CREATE SET ${defaults.join(', ')}`);
  if (explicit.length > 0) out.push(`SET ${explicit.join(', ')}`);
  return out;
}

/**
 * Build a stable signature for a `connect` array item — the set of keys
 * inside `where.node` (or `where` directly for the legacy bare-object
 * shape) PLUS the set of keys inside `edge`. Used by the UNWIND fast
 * path to validate that every item shares the same shape; mismatched
 * shapes silently drop keys from the compiled WHERE / SET.
 */
/**
 * v2.6.0 — the keys a connect / disconnect item is compiled from. `overwrite`
 * is offered by the generated `ConnectFieldInput` and accepted as before
 * (MERGE + SET always overwrites the edge properties it is given; v2.8.0 —
 * strict mode honours `overwrite: false`, see connectKeepsExistingEdge).
 */
const CONNECT_ITEM_KEYS: ReadonlySet<string> = new Set([
  'where',
  'edge',
  'overwrite',
  'connect',
]);
const DISCONNECT_ITEM_KEYS: ReadonlySet<string> = new Set([
  'where',
  'disconnect',
]);

/**
 * v2.10.0 — strict item 22: the keys each nested write object is compiled
 * from, which are also exactly the keys its generated input type offers
 * (`input-emitter.ts`). `edge` is read whether or not the relationship
 * declares properties; `checkEdgeKeys` reports what is inside it.
 *
 * - `update item` — `<Type><Field>UpdateFieldInput` (and per member);
 * - `create field input` — `<Type><Field>FieldInput`, a relationship field
 *   in `create()` and in a nested create's `node` (and per member);
 * - `create item` — `<Type><Field>CreateFieldInput`, when `node` is given;
 * - `update body` — `<Type><Field>UpdateConnectionInput`, when `node` or
 *   `edge` is given.
 */
type NestedWriteShape =
  | 'update item'
  | 'create field input'
  | 'create item'
  | 'update body';
const NESTED_WRITE_SHAPES: Record<
  NestedWriteShape,
  { keys: ReadonlySet<string>; what: string }
> = {
  'update item': {
    keys: new Set([
      'where',
      'update',
      'connect',
      'disconnect',
      'create',
      'delete',
    ]),
    what: 'a nested update item',
  },
  'create field input': {
    keys: new Set(['create', 'connect']),
    what: 'the nested create input',
  },
  'create item': {
    keys: new Set(['node', 'edge']),
    what: 'a nested create item',
  },
  'update body': {
    keys: new Set(['node', 'edge']),
    what: 'the "update" of a nested update item',
  },
};

/** Defined keys of a write input object that `allowed` does not contain. */
function unknownInputKeys(
  input: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): string[] {
  return Object.keys(input).filter(
    (k) => input[k] !== undefined && !allowed.has(k),
  );
}

function quoteKeys(keys: Iterable<string>): string {
  return [...keys].map((k) => `"${k}"`).join(', ');
}

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
  /**
   * v2.12.2 — nesting depth of `spec` within the nested-write where. This
   * pre-walk recurses through connection-shaped `NOT` / `AND` / `OR` BEFORE
   * the where compiler sees the result, so it shares the compiler's limit
   * (`MAX_WHERE_DEPTH`); pre-2.12.2 a few thousand nested levels overflowed
   * the JS stack here with a raw `RangeError`.
   */
  depth = 0,
): Record<string, unknown> {
  if (!isPlainObject(spec))
    throw new OGMError('A nested mutation where must be an object.');
  assertWhereDepth(depth);
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
          NOT: connectionWhereToNodeWhere(
            value as Record<string, unknown>,
            depth + 1,
          ),
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
            connectionWhereToNodeWhere(
              item as Record<string, unknown>,
              depth + 1,
            ),
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

/** An interface / union relationship target and its concrete members. */
export interface AbstractTarget {
  kind: 'interface' | 'union';
  name: string;
  members: string[];
}

/**
 * The concrete members of an interface / union relationship target, or
 * `null` for a node type. Implementer nodes carry their OWN labels, not
 * the interface's, so every write that has to find one matches by these
 * members' labels (v2.4.8).
 */
export function abstractTarget(
  target: string,
  schema: SchemaMetadata,
): AbstractTarget | null {
  if (schema.nodes.has(target)) return null;
  const iface = schema.interfaces?.get(target);
  if (iface)
    return {
      kind: 'interface',
      name: target,
      members: iface.implementedBy.filter((m) => schema.nodes.has(m)),
    };
  const union = schema.unions?.get(target);
  if (union)
    return {
      kind: 'union',
      name: target,
      members: union.filter((m) => schema.nodes.has(m)),
    };
  return null;
}

/**
 * Classify the nested-write value of an abstract relationship (v2.4.8):
 *
 *   - PER-MEMBER — keyed by member type (`{ Dog: { … } }`), the shape
 *     codegen emits for union AND interface targets. Returns the defined
 *     `[member, value]` entries.
 *   - FLAT — the operation keys themselves (`{ connect, create, … }`, or an
 *     array of them), the @neo4j/graphql interface shape. Returns `null`.
 *     Only interfaces accept it: a union has no common fields to filter or
 *     write, so a flat union input throws.
 *
 * Pre-2.4.8 a key that was not a member was skipped, so a flat or typo'd
 * input on an abstract relationship compiled to no write at all. Mixing
 * member keys with other keys now throws instead.
 */
export function perMemberEntries(
  value: unknown,
  target: AbstractTarget,
  fieldName: string,
): [string, unknown][] | null {
  if (Array.isArray(value) || !isPlainObject(value)) {
    if (target.kind === 'union')
      throw new OGMError(
        `Relationship "${fieldName}" targets the union "${target.name}": key its nested input by member type ` +
          `(${target.members.map((m) => `"${m}"`).join(', ')}).`,
      );
    return null;
  }
  const keys = Object.keys(value).filter((k) => value[k] !== undefined);
  const memberKeys = keys.filter((k) => target.members.includes(k));
  if (memberKeys.length === 0 && target.kind === 'interface') return null;
  if (memberKeys.length !== keys.length) {
    const other = keys.filter((k) => !target.members.includes(k));
    throw new OGMError(
      `Unknown key(s) ${other.map((k) => `"${k}"`).join(', ')} in the nested input of "${fieldName}" ` +
        `(${target.kind} "${target.name}"). ` +
        (target.kind === 'union'
          ? `Key it by member type: ${target.members.map((m) => `"${m}"`).join(', ')}.`
          : `Use either member keys (${target.members.map((m) => `"${m}"`).join(', ')}) or the operation keys, not both.`),
    );
  }
  return memberKeys
    .filter((k) => value[k] !== null)
    .map((k) => [k, value[k]] as [string, unknown]);
}

/**
 * v2.6.2 — the per-member entries of a root cascade delete on an abstract
 * relationship (`{ Chart: [...], Doc: [...] }`, the generated union
 * `…DeleteInput`), or `null` for the flat item list (`[{ where }]`,
 * `{ where }`, `true`, `null`), which keeps its pre-2.6.2 handling. Member
 * keys mixed with item keys throw.
 */
function perMemberDeleteEntries(
  spec: unknown,
  target: AbstractTarget | null,
  fieldName: string,
): [string, unknown][] | null {
  if (!target || !isPlainObject(spec)) return null;
  const keys = Object.keys(spec).filter((k) => spec[k] !== undefined);
  if (!keys.some((k) => target.members.includes(k))) return null;
  const other = keys.filter((k) => !target.members.includes(k));
  if (other.length > 0)
    throw new OGMError(
      `Unknown key(s) ${other.map((k) => `"${k}"`).join(', ')} in the delete input of "${fieldName}" ` +
        `(${target.kind} "${target.name}"). Key it by member type (${target.members.map((m) => `"${m}"`).join(', ')}) ` +
        `or give the item list, not both.`,
    );
  return keys
    .filter((k) => spec[k] !== null)
    .map((k) => [k, spec[k]] as [string, unknown]);
}

/**
 * v2.6.2 — the per-member bodies of a FLAT interface nested update whose
 * `node` is keyed by implementing type (`{ node: { Chart: { … } } }`, the
 * generated `<Interface>UpdateInput`), or `null` for the flat interface
 * fields (`{ node: { name } }`). Pre-2.6.2 the typed shape threw
 * `Unknown field "Chart"`. Member keys mixed with other keys throw.
 */
export function perMemberUpdateBodies(
  nodeUpdate: unknown,
  target: AbstractTarget | null,
  targetDef: NodeDefinition,
  fieldName: string,
): [string, Record<string, unknown>][] | null {
  if (!target || target.kind !== 'interface' || !isPlainObject(nodeUpdate))
    return null;
  const keys = Object.keys(nodeUpdate).filter(
    (k) => nodeUpdate[k] !== undefined,
  );
  const isMember = (k: string) =>
    target.members.includes(k) &&
    !targetDef.properties.has(k) &&
    !targetDef.relationships.has(k);
  if (!keys.some(isMember)) return null;
  const other = keys.filter((k) => !isMember(k));
  if (other.length > 0)
    throw new OGMError(
      `Unknown key(s) ${other.map((k) => `"${k}"`).join(', ')} in the nested update of "${fieldName}" ` +
        `(interface "${target.name}"): use either member keys (${target.members.map((m) => `"${m}"`).join(', ')}) ` +
        `or the interface's fields, not both.`,
    );
  const bodies: [string, Record<string, unknown>][] = [];
  for (const k of keys) {
    const body = nodeUpdate[k];
    if (body === null) continue;
    if (!isPlainObject(body))
      throw new OGMError(
        `The "${k}" update of "${fieldName}" must be an object (the ${k} update input).`,
      );
    bodies.push([k, body]);
  }
  return bodies;
}

/**
 * Unwrap a FLAT interface nested-create node spec — `{ Dog: { … } }`,
 * exactly one implementer key — into the implementer and its own input
 * (v2.4.8). Anything else throws: without a member key the compiler cannot
 * know which labels and properties the new node gets.
 */
export function unwrapAbstractCreateNode(
  nodeSpec: unknown,
  target: AbstractTarget,
  fieldName: string,
): [string, Record<string, unknown>] {
  const keys = isPlainObject(nodeSpec)
    ? Object.keys(nodeSpec).filter((k) => nodeSpec[k] !== undefined)
    : [];
  if (
    !isPlainObject(nodeSpec) ||
    keys.length !== 1 ||
    !target.members.includes(keys[0]) ||
    !isPlainObject(nodeSpec[keys[0]])
  )
    throw new OGMError(
      `A nested create on "${fieldName}" (${target.kind} "${target.name}") must name exactly one implementing type, ` +
        `e.g. { node: { ${target.members[0] ?? 'Member'}: { … } } }. Allowed: ${target.members.map((m) => `"${m}"`).join(', ')}.`,
    );
  return [keys[0], nodeSpec[keys[0]] as Record<string, unknown>];
}

/**
 * Reject a write key that is neither a property nor a relationship of the
 * type (v2.5.0). Pre-2.5.0 only its spelling was checked, so a typo
 * (`nmae`) was stored as a stray property and the intended field was left
 * untouched — at every depth (nested creates and updates included).
 *
 * v2.19.0 — strict item 33: a `@cypher` field is computed when read, never
 * stored, and the generated write inputs leave it out. Pre-v2.19.0 (and
 * still by default) it was written as a stored property that no read
 * ever returns. Default: one warning per OGM, type and field; strict:
 * `OGMError`.
 */
function assertKnownField(
  nodeDef: NodeDefinition,
  key: string,
  input: 'create' | 'update' | 'createMany' | 'nested update',
  strictMode: StrictMode,
): void {
  const propDef = nodeDef.properties.get(key);
  if (propDef?.isCypher) {
    if (strictMode.strict)
      throw new OGMError(
        `Field "${key}" in the ${input} input of ${nodeDef.typeName} is a @cypher field: it is computed when ` +
          `read and cannot be written. Remove it from the input.`,
      );
    strictMode.warn(
      'cypher-field-write',
      `${nodeDef.typeName}\u0000${key}`,
      `Field "${key}" in the ${input} input of ${nodeDef.typeName} is a @cypher field, computed when read; ` +
        `it is written as a stored property that no read returns.`,
      'throw an OGMError for @cypher fields in write inputs',
    );
    return;
  }
  if (propDef || nodeDef.relationships.has(key)) return;
  throw new OGMError(
    `Unknown field "${key}" in the ${input} input of ${nodeDef.typeName}: it is neither a property nor a ` +
      `relationship of the type. Declare it in the schema, or fix the key.`,
  );
}

/**
 * MERGE writes scalars only. Pre-2.4.8 a relationship field in an upsert's
 * `create` / `update` was skipped, so its nested connect / create never
 * ran and nothing said so.
 */
function upsertRelationshipError(
  nodeDef: NodeDefinition,
  key: string,
  branch: 'create' | 'update',
): OGMError {
  return new OGMError(
    `upsert does not support relationship fields: "${key}" in "${branch}" (${nodeDef.typeName}). ` +
      `Use create() / update() for nested relationship operations.`,
  );
}

/**
 * v2.6.1 — the lines around an upsert MERGE that apply the root type's
 * `update` row filter to the node it MATCHES, as a direct `update` does:
 *
 *   OPTIONAL MATCH (__existing:L { key })        ┐ before
 *   WITH count(__existing) > 0 AS __matched      ┘
 *   MERGE (n:L { key })
 *   ON CREATE SET …
 *   WITH n, __matched                            ┐ after
 *   [@cypher preludes of the guard]              │
 *   WHERE NOT __matched OR (<guard>)             │
 *   FOREACH (__u IN CASE WHEN __matched THEN [1] ELSE [] END | SET …)
 *
 * A created node passes untouched by the update sets; an existing node is
 * updated only when it passes the guard; one that fails it is neither
 * updated nor returned (and the MERGE created nothing). Pre-2.6.1 the
 * update went in `ON MATCH SET` with no row filter, so any context the
 * WITH CHECK admitted rewrote any existing node — even its owner field.
 *
 * `count()` keeps one row before the MERGE whether 0, 1 or several nodes
 * match (invariant 2); FOREACH needs no subquery after the write
 * (invariant 1). Under a race, a node created between the OPTIONAL MATCH
 * and the MERGE is matched with `__matched = false`: its properties are
 * not updated (default-mode runtime `labels`, SET after this, still are).
 */
function buildGuardedMerge(
  labelStr: string,
  mergeProps: string[],
  guard: MatchGuard,
  updateSets: string[],
  params: Record<string, unknown>,
): { before: string[]; after: string[] } {
  mergeParams(params, guard.params);
  const after = ['WITH n, __matched'];
  if (guard.preludes && guard.preludes.length > 0)
    after.push(...guard.preludes);
  after.push(`WHERE NOT __matched OR (${guard.cypher})`);
  if (updateSets.length > 0)
    after.push(
      `FOREACH (__u IN CASE WHEN __matched THEN [1] ELSE [] END | SET ${updateSets.join(', ')})`,
    );
  return {
    before: [
      `OPTIONAL MATCH (__existing:${labelStr} { ${mergeProps.join(', ')} })`,
      'WITH count(__existing) > 0 AS __matched',
    ],
    after,
  };
}

/** `null` / `{}`: the whole-relationship (blanket) form, never per member. */
function isBlanketSpec(spec: unknown): boolean {
  if (spec == null) return true;
  return (
    isPlainObject(spec) && Object.keys(spec).every((k) => spec[k] === undefined)
  );
}

/**
 * v2.8.0 — true while `nodeVar` still exists in this transaction (finding
 * F1). A node DETACH DELETEd earlier in the statement is no longer found by
 * its element id (an id seek), while reading its properties throws
 * `EntityNotFound`.
 */
function aliveGuard(nodeVar: string): string {
  return `exists { MATCH (_alive) WHERE elementId(_alive) = elementId(${nodeVar}) }`;
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
 *
 * v2.12.1 — it also continues after every `policy_p<N>_<key>` the root
 * WHERE's policies bound, since the policy param prefix is now minted from
 * the same counter: a nested target's raw policy params must not reuse a
 * prefix the root already used.
 */
function counterAfter(params: Record<string, unknown>): { count: number } {
  let max = -1;
  for (const key of Object.keys(params)) {
    const match = /^(?:param(\d+)|policy_p(\d+)_)/.exec(key);
    if (match) max = Math.max(max, Number(match[1] ?? match[2]));
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

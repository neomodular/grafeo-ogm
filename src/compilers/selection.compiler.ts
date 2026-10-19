import {
  Kind,
  parse,
  print,
  valueFromASTUntyped,
  type ValueNode,
  type DocumentNode,
  type FieldNode,
  type InlineFragmentNode,
  type SelectionSetNode,
} from 'graphql';

import { int as neo4jInt } from 'neo4j-driver';
import { OGMError } from '../errors';
import type { PolicyContextBundle } from '../policy/types';
import type {
  NodeDefinition,
  PropertyDefinition,
  SchemaMetadata,
} from '../schema/types';
import { buildRelPattern, resolveTargetDef } from '../schema/utils';
import {
  CypherFieldScope,
  buildInlineCypherFieldExpr,
} from '../utils/cypher-field-projection';
import {
  assertSafeIdentifier,
  assertSortDirection,
  escapeIdentifier,
  isPlainObject,
  mergeParams,
} from '../utils/validation';
import {
  stitchUserAndPolicy,
  traversalBundle,
  type WhereCompiler,
} from './where.compiler';

/**
 * Represents a single node in the parsed selection tree.
 */
export interface SelectionNode {
  fieldName: string;
  alias?: string;
  isScalar: boolean;
  isRelationship: boolean;
  isConnection: boolean;
  children?: SelectionNode[];
  /** WHERE filter for relationship pattern comprehensions (Prisma-like select) */
  relationshipWhere?: Record<string, unknown>;
  connectionWhere?: Record<string, unknown>;
  edgeChildren?: SelectionNode[];
  /** Sort spec for array relationship pattern comprehensions (Prisma-like select) */
  orderBy?: Array<{ field: string; direction: 'ASC' | 'DESC' }>;
  /**
   * Sort spec for connection edges. Each entry targets either the related node
   * scalars (`scope: 'node'`) or @relationshipProperties scalars (`scope: 'edge'`).
   */
  connectionOrderBy?: Array<{
    field: string;
    direction: 'ASC' | 'DESC';
    scope: 'node' | 'edge';
  }>;
  /**
   * Connection only: `totalCount` was selected (v2.4.8). Pre-2.4.8 it was
   * silently dropped although the generated connection type declares it.
   */
  totalCount?: boolean;
  /**
   * Connection only: `totalCount` was selected WITHOUT `edges`, so the
   * projection carries `totalCount` alone (v2.4.8).
   */
  totalCountOnly?: boolean;
  /**
   * The concrete types whose inline fragments selected this field
   * (`... on B { x }`); absent when it was selected unconditionally.
   * v2.4.8 — lets an abstract-type projection resolve an implementer's
   * own `@cypher` field against that implementer.
   */
  typeConditions?: string[];
  /**
   * Relationship only: `options: { limit, offset }` from selectionSet
   * arguments (v2.5.0) — slices the (sorted) pattern comprehension.
   */
  limit?: number;
  offset?: number;
  /**
   * The selection carries selectionSet arguments (v2.5.0). Paths that
   * can't honour them throw instead of dropping them.
   */
  hasArguments?: boolean;
  /**
   * v2.5.3 — the same response key selected on DIFFERENT fields by sibling
   * inline fragments (`... on A { x: title } ... on B { x: body }`): the
   * field each fragment type selected. Projected as a per-type CASE.
   */
  fieldByType?: Record<string, string>;
}

/**
 * v2.5.3 — the printed arguments of a parsed selectionSet field, so a
 * response key selected twice merges its sub-selections only when both
 * selections carry the same arguments.
 */
const argumentKeys = new WeakMap<SelectionNode, string>();

function sameArguments(a: SelectionNode, b: SelectionNode): boolean {
  return (argumentKeys.get(a) ?? '') === (argumentKeys.get(b) ?? '');
}

/**
 * Merge `incoming` into `list` by response key (v2.5.3), as GraphQL merges
 * a field selected more than once: sub-selections are unioned. Pre-2.5.3
 * the second selection of a key was dropped with its sub-fields.
 *
 * - Same field, same arguments: children, edge children and `totalCount`
 *   merge recursively.
 * - Same field, different arguments: the first selection wins (unchanged).
 * - Different fields under one key, each selected by inline fragments on
 *   different types: recorded in `fieldByType` for a per-type projection.
 * - A selection outside any fragment makes the field unconditional.
 */
function mergeSelection(
  list: SelectionNode[],
  seen: Map<string, SelectionNode>,
  incoming: SelectionNode,
): void {
  const key = incoming.alias ?? incoming.fieldName;
  const existing = seen.get(key);
  if (!existing) {
    seen.set(key, incoming);
    list.push(incoming);
    return;
  }
  if (existing.fieldName !== incoming.fieldName || existing.fieldByType) {
    mergeFragmentField(existing, incoming);
    return;
  }
  if (existing.typeConditions && incoming.typeConditions)
    existing.typeConditions = [
      ...new Set([...existing.typeConditions, ...incoming.typeConditions]),
    ];
  // Also selected outside any fragment → unconditional.
  else delete existing.typeConditions;
  if (!sameArguments(existing, incoming)) return;
  if (incoming.children)
    existing.children = mergeSelectionLists(
      existing.children,
      incoming.children,
    );
  if (incoming.edgeChildren)
    existing.edgeChildren = mergeSelectionLists(
      existing.edgeChildren,
      incoming.edgeChildren,
    );
  if (existing.isConnection) {
    if (incoming.totalCount) existing.totalCount = true;
    if (existing.totalCountOnly && !incoming.totalCountOnly)
      delete existing.totalCountOnly;
  }
}

/** Two scalars under one key, from fragments on different types (v2.5.3). */
function mergeFragmentField(
  existing: SelectionNode,
  incoming: SelectionNode,
): void {
  // Only scalars selected by inline fragments can differ per type; any
  // other clash keeps the first selection (unchanged).
  if (
    !existing.isScalar ||
    !incoming.isScalar ||
    !existing.typeConditions ||
    !incoming.typeConditions
  )
    return;
  const byType: Record<string, string> = existing.fieldByType ?? {};
  if (!existing.fieldByType)
    for (const t of existing.typeConditions) byType[t] = existing.fieldName;
  for (const t of incoming.typeConditions)
    if (byType[t] === undefined) byType[t] = incoming.fieldName;
  existing.fieldByType = byType;
  existing.typeConditions = [
    ...new Set([...existing.typeConditions, ...incoming.typeConditions]),
  ];
}

function mergeSelectionLists(
  base: SelectionNode[] | undefined,
  extra: SelectionNode[],
): SelectionNode[] {
  const list: SelectionNode[] = [];
  const seen = new Map<string, SelectionNode>();
  for (const node of [...(base ?? []), ...extra])
    mergeSelection(list, seen, node);
  return list;
}

/** selectionSet field arguments the OGM honours, by field kind (v2.5.0). */
const RELATIONSHIP_ARGUMENTS = new Set(['where', 'options']);
const CONNECTION_ARGUMENTS = new Set(['where']);
const RELATIONSHIP_OPTIONS = new Set(['sort', 'limit', 'offset']);

/** Reject `$variables` anywhere in an argument value (v2.5.0). */
function assertNoVariables(value: ValueNode, where: string): void {
  if (value.kind === Kind.VARIABLE)
    throw new OGMError(
      `GraphQL variables are not supported in selectionSet arguments (${where}: $${value.name.value}). ` +
        `Inline the value, or use the typed \`select\` API.`,
    );
  if (value.kind === Kind.LIST)
    for (const v of value.values) assertNoVariables(v, where);
  if (value.kind === Kind.OBJECT)
    for (const f of value.fields) assertNoVariables(f.value, where);
}

function assertNoArguments(field: FieldNode, where: string): void {
  if (field.arguments && field.arguments.length > 0)
    throw new OGMError(
      `Unsupported argument "${field.arguments[0].name.value}" on "${where}". ` +
        `selectionSet arguments are supported only on relationship fields (where, options) ` +
        `and connection fields (where).`,
    );
}

function nonNegativeInt(value: unknown, what: string): number {
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isInteger(n) || n < 0)
    throw new OGMError(`${what} must be a non-negative integer.`);
  return n;
}

/**
 * Read a selectionSet field's arguments into the SelectionNode (v2.5.0).
 * Pre-2.5.0 `field.arguments` was never read: `posts(where: ...)`,
 * `posts(options: { sort, limit })` silently returned every related node.
 * Values are kept as data and compiled into bound parameters later —
 * nothing here is interpolated into Cypher. Any argument the OGM can't
 * honour throws.
 */
function applyFieldArguments(field: FieldNode, node: SelectionNode): void {
  const label = field.name.value;
  const allowed = node.isConnection
    ? CONNECTION_ARGUMENTS
    : node.isRelationship
      ? RELATIONSHIP_ARGUMENTS
      : null;
  node.hasArguments = true;
  for (const arg of field.arguments ?? []) {
    const name = arg.name.value;
    if (!allowed || !allowed.has(name))
      throw new OGMError(
        `Unsupported argument "${name}" on selectionSet field "${label}". ` +
          `Supported: where and options (sort, limit, offset) on relationship fields, where on connection fields.`,
      );
    assertNoVariables(arg.value, `${label}(${name})`);
    const value = valueFromASTUntyped(arg.value);
    if (!isPlainObject(value))
      throw new OGMError(
        `Argument "${name}" on selectionSet field "${label}" must be an object.`,
      );
    if (name === 'where') {
      if (node.isConnection) node.connectionWhere = value;
      else node.relationshipWhere = value;
      continue;
    }
    // options
    for (const [opt, optValue] of Object.entries(value)) {
      if (!RELATIONSHIP_OPTIONS.has(opt))
        throw new OGMError(
          `Unsupported option "${opt}" on selectionSet field "${label}". Supported: sort, limit, offset.`,
        );
      if (optValue === null || optValue === undefined) continue;
      if (opt === 'limit')
        node.limit = nonNegativeInt(optValue, `options.limit on "${label}"`);
      else if (opt === 'offset')
        node.offset = nonNegativeInt(optValue, `options.offset on "${label}"`);
      else {
        const entries = Array.isArray(optValue) ? optValue : [optValue];
        const orderBy: Array<{ field: string; direction: 'ASC' | 'DESC' }> = [];
        for (const entry of entries) {
          if (!isPlainObject(entry))
            throw new OGMError(
              `options.sort on "${label}" entries must be objects like { field: ASC }.`,
            );
          for (const [sortField, dir] of Object.entries(entry)) {
            assertSafeIdentifier(sortField, 'options.sort field');
            orderBy.push({
              field: sortField,
              direction: assertSortDirection(String(dir)),
            });
          }
        }
        if (orderBy.length > 0) node.orderBy = orderBy;
      }
    }
  }
}

/**
 * Compiles a selection set (parsed SelectionNode[]) into a Cypher RETURN map projection.
 *
 * Handles scalar fields, relationship pattern comprehensions (array and singular),
 * connection fields with edge properties, and nested traversals with depth limiting.
 */
export class SelectionCompiler {
  private static readonly DEFAULT_MAX_DEPTH = 5;
  /** Maximum number of distinct parsed selection sets retained. */
  private static readonly PARSE_CACHE_MAX_ENTRIES = 200;
  /**
   * Real LRU cache of parsed selection sets, capped at
   * `PARSE_CACHE_MAX_ENTRIES`. Pre-1.7.5 the implementation was
   * `if (size < 200) set(...)` — once saturated, every miss had to
   * re-parse via `graphql.parse()` because nothing was ever inserted
   * (and nothing was ever evicted to make room). Apps with high
   * selection-set cardinality silently paid full parse cost on every
   * request post-saturation. The new policy: on hit, delete + re-set
   * (so the entry moves to the most-recently-used end of the Map's
   * insertion-order iteration); on miss, evict the oldest entry
   * (`Map.keys().next().value` — Maps preserve insertion order) before
   * inserting the new one.
   */
  private parseCache = new Map<string, SelectionNode[]>();
  private whereCompiler?: WhereCompiler;

  constructor(
    private schema: SchemaMetadata,
    whereCompiler?: WhereCompiler,
  ) {
    this.whereCompiler = whereCompiler;
  }

  /** Clear the parse cache. Useful in tests to prevent cross-test pollution. */
  clearCache(): void {
    this.parseCache.clear();
  }

  /**
   * Compile selection nodes into a Cypher map projection string.
   *
   * @param selection - Parsed selection nodes
   * @param nodeVar - Cypher variable for the matched node (e.g., 'n')
   * @param nodeDef - Node definition from schema metadata
   * @param maxDepth - Maximum traversal depth (default 5)
   * @param currentDepth - Current depth (used internally for recursion)
   * @returns Cypher map projection string, e.g. "n { .id, .name, drugs: [...] }"
   */
  compile(
    selection: SelectionNode[],
    nodeVar: string,
    nodeDef: NodeDefinition,
    maxDepth: number = SelectionCompiler.DEFAULT_MAX_DEPTH,
    currentDepth: number = 0,
    params?: Record<string, unknown>,
    paramCounter?: { count: number },
    /**
     * Scope for `@cypher` scalar field projections at THIS pipeline level.
     * When provided, `@cypher` scalar fields in `selection` are registered
     * here so the caller can emit the CALL preludes before the RETURN
     * (preferred path: dedupes references and runs once per row binding).
     * When `null` (or omitted), `@cypher` scalar fields fall back to an
     * inline `head(COLLECT { WITH <var> AS this <stmt> })` projection —
     * required inside nested relationship pattern comprehensions where
     * CALL { ... } preludes have no anchor, and tolerated at the top level
     * for ad-hoc compile() callers that don't supply a scope.
     */
    cypherScope: CypherFieldScope | null = null,
    /**
     * Policy context for nested-selection enforcement. When set, every
     * relationship pattern comprehension, connection edge, and union
     * branch resolves the target type's `'read'` policy via
     * `policyContext.resolveForType` and AND-stitches it into the inner
     * WHERE clause. Without this, traversals would bypass policies.
     */
    policyContext: PolicyContextBundle | null = null,
  ): string {
    if (selection.length === 0) return `${nodeVar} { .id }`;

    // Check if this nodeDef is a resolved union type — if so, relationship
    // fields need CASE WHEN branches since different union members may have
    // the same field name but different underlying relationship types.
    const unionMembers = this.schema.unions?.get(nodeDef.typeName);
    const interfaceDef = this.schema.interfaces?.get(nodeDef.typeName);
    const isAbstract =
      (unionMembers && unionMembers.length > 0) ||
      (interfaceDef &&
        interfaceDef.implementedBy &&
        interfaceDef.implementedBy.length > 0);

    const parts: string[] = [];

    // Auto-emit __typename for abstract targets (unions/interfaces). Callers
    // of a discriminated type cannot narrow the returned object without
    // __typename, and requiring them to remember a boilerplate
    // `__typename: true` is a footgun — type guards silently return false
    // with no signal. Skip if the caller already asked for it explicitly.
    if (isAbstract) {
      const alreadyRequested = selection.some(
        (node) => node.isScalar && node.fieldName === '__typename',
      );
      if (!alreadyRequested) {
        const typenameExpr = this.compileTypename(nodeVar, nodeDef);
        if (typenameExpr) parts.push(`__typename: ${typenameExpr}`);
      }
    }

    for (const node of selection) {
      // v2.5.0 — a selectionSet alias names the output key (pre-2.5.0 it
      // was parsed and ignored). `key` is the field name when unaliased,
      // so unaliased projections are byte-identical.
      const aliased = node.alias !== undefined && node.alias !== node.fieldName;
      const key = aliased ? node.alias! : node.fieldName;
      if (aliased) assertSafeIdentifier(key, 'selection alias');

      if (node.isScalar) {
        // __typename is a GraphQL concept — Neo4j nodes don't have this property.
        // Synthesize it from node labels for union targets, or emit a constant.
        if (node.fieldName === '__typename') {
          const typenameExpr = this.compileTypename(nodeVar, nodeDef);
          if (typenameExpr) parts.push(`${key}: ${typenameExpr}`);
          continue;
        }

        assertSafeIdentifier(node.fieldName, 'selection field');

        if (isAbstract && node.typeConditions) {
          const conditional = this.compileFragmentScalar(
            node,
            key,
            nodeVar,
            nodeDef,
            cypherScope,
          );
          if (conditional) {
            parts.push(conditional);
            continue;
          }
        }

        // `@cypher` scalar fields normally project via a CALL { ... }
        // prelude registered on the surrounding pipeline's `cypherScope`.
        // Inside a nested relationship pattern comprehension preludes have
        // no anchor — fall back to an inline `head(COLLECT { ... })`
        // subquery expression, which Cypher 5.x evaluates per row of the
        // outer comprehension.
        const propDef = nodeDef.properties.get(node.fieldName);
        if (propDef?.isCypher && propDef.cypherStatement) {
          if (cypherScope) {
            const alias = cypherScope.register(node.fieldName, propDef);
            parts.push(`${escapeIdentifier(key)}: ${alias}`);
          } else
            parts.push(
              `${escapeIdentifier(key)}: ${buildInlineCypherFieldExpr(
                propDef.cypherStatement,
                nodeVar,
                `${nodeDef.typeName}.${node.fieldName}`,
              )}`,
            );

          continue;
        }

        parts.push(
          aliased
            ? `${escapeIdentifier(key)}: ${nodeVar}.${escapeIdentifier(node.fieldName)}`
            : `.${escapeIdentifier(node.fieldName)}`,
        );
        continue;
      }

      if (node.isConnection) {
        const connectionCypher = this.compileConnection(
          node,
          nodeVar,
          nodeDef,
          maxDepth,
          currentDepth,
          params,
          paramCounter,
          policyContext,
        );
        if (connectionCypher) parts.push(`${key}: ${connectionCypher}`);

        continue;
      }

      if (node.isRelationship) {
        // For union targets, relationship fields may have different relationship
        // types across members. Generate CASE WHEN branches per member.
        if (unionMembers && unionMembers.length > 0) {
          const caseCypher = this.compileUnionRelationshipField(
            node,
            nodeVar,
            unionMembers,
            maxDepth,
            currentDepth,
            params,
            paramCounter,
            policyContext,
          );
          if (caseCypher) parts.push(`${key}: ${caseCypher}`);
          continue;
        }

        const relCypher = this.compileRelationship(
          node,
          nodeVar,
          nodeDef,
          maxDepth,
          currentDepth,
          params,
          paramCounter,
          policyContext,
        );
        if (relCypher) parts.push(`${key}: ${relCypher}`);

        continue;
      }
    }

    return `${nodeVar} { ${parts.join(', ')} }`;
  }

  /**
   * Project a scalar selected through inline fragments on an abstract type
   * (v2.4.8) when at least one fragment's concrete type declares it as a
   * `@cypher` field: `CASE WHEN n:B THEN <B's projection> … END`. Pre-2.4.8
   * the field was looked up on the abstract type, where it doesn't exist,
   * and projected as a stored property — always null.
   *
   * Returns `null` (caller keeps the regular projection, byte-identical)
   * when the abstract type declares the field as `@cypher` itself, when a
   * condition isn't a concrete type, or when no fragment type declares it
   * as `@cypher`.
   */
  private compileFragmentScalar(
    node: SelectionNode,
    key: string,
    nodeVar: string,
    nodeDef: NodeDefinition,
    cypherScope: CypherFieldScope | null,
  ): string | null {
    // v2.5.3 — `fieldByType`: sibling fragments selected different fields
    // under this key, so each type projects its own field.
    const perType = node.fieldByType;
    if (!perType && nodeDef.properties.get(node.fieldName)?.isCypher)
      return null;
    const members: {
      def: NodeDefinition;
      prop: PropertyDefinition;
      field: string;
    }[] = [];
    for (const typeName of node.typeConditions ?? []) {
      const def = this.schema.nodes.get(typeName);
      if (!def) return null;
      const field = perType?.[typeName] ?? node.fieldName;
      assertSafeIdentifier(field, 'selection field');
      const prop = def.properties.get(field);
      if (prop) members.push({ def, prop, field });
    }
    if (
      !perType &&
      !members.some((m) => m.prop.isCypher && m.prop.cypherStatement)
    )
      return null;

    const branches = members.map(({ def, prop, field }) => {
      let expr: string;
      if (prop.isCypher && prop.cypherStatement)
        expr = cypherScope
          ? cypherScope.register(field, prop, def.label)
          : buildInlineCypherFieldExpr(
              prop.cypherStatement,
              nodeVar,
              `${def.typeName}.${field}`,
            );
      else expr = `${nodeVar}.${escapeIdentifier(field)}`;
      return `WHEN ${nodeVar}:${escapeIdentifier(def.label)} THEN ${expr}`;
    });
    return `${escapeIdentifier(key)}: CASE ${branches.join(' ')} END`;
  }

  /**
   * Parse a GraphQL selection set string into SelectionNode[].
   *
   * @param selectionSet - Raw string like "\{ id name drugs \{ id \} \}"
   * @returns Parsed SelectionNode array
   */
  parseSelectionSet(selectionSet: string): SelectionNode[] {
    const cached = this.parseCache.get(selectionSet);
    if (cached) {
      // Touch the entry to mark it most-recently-used. Map insertion
      // order is the LRU iteration order we rely on for eviction.
      this.parseCache.delete(selectionSet);
      this.parseCache.set(selectionSet, cached);
      return cached;
    }

    const trimmed = selectionSet.trim();
    // Wrap in a dummy query so graphql parser can handle it
    const query = `query { dummy ${trimmed} }`;

    let doc: DocumentNode;
    try {
      doc = parse(query);
    } catch (err) {
      throw new OGMError(
        `Failed to parse selectionSet: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const opDef = doc.definitions[0];
    if (opDef.kind !== Kind.OPERATION_DEFINITION) return [];

    const dummyField = opDef.selectionSet.selections[0];
    if (dummyField.kind !== Kind.FIELD || !dummyField.selectionSet) return [];

    const result = this.convertSelectionSet(dummyField.selectionSet);

    // Real-LRU eviction: drop the oldest entry when the cache is full,
    // then insert. Pre-1.7.5 we just stopped caching at saturation,
    // forcing every subsequent miss to re-parse — a silent perf cliff
    // for apps with high selection-set cardinality.
    if (this.parseCache.size >= SelectionCompiler.PARSE_CACHE_MAX_ENTRIES) {
      const oldestKey = this.parseCache.keys().next().value;
      if (oldestKey !== undefined) this.parseCache.delete(oldestKey);
    }
    this.parseCache.set(selectionSet, result);

    return result;
  }

  /**
   * Convert a GraphQL SelectionSetNode into SelectionNode[].
   */
  private convertSelectionSet(
    selectionSet: SelectionSetNode,
    /** Type condition of the enclosing inline fragment, if any (v2.4.8). */
    typeCondition?: string,
  ): SelectionNode[] {
    const nodes: SelectionNode[] = [];
    const seen = new Map<string, SelectionNode>();

    for (const sel of selectionSet.selections) {
      // Handle inline fragments (... on Type { fields }) by merging their
      // fields. v2.4.8 — each merged field remembers the fragment types
      // that selected it (`typeConditions`), so an abstract-type
      // projection can resolve an implementer's own field.
      if (sel.kind === Kind.INLINE_FRAGMENT) {
        const fragment = sel as InlineFragmentNode;
        const condition = fragment.typeCondition?.name.value ?? typeCondition;
        if (fragment.selectionSet)
          for (const merged of this.convertSelectionSet(
            fragment.selectionSet,
            condition,
          ))
            mergeSelection(nodes, seen, merged);

        continue;
      }

      if (sel.kind !== Kind.FIELD) continue;
      const field = sel as FieldNode;
      const fieldName = field.name.value;
      // v2.5.0 — fields are keyed by their OUTPUT name, so the same field
      // under two aliases (`a: kids { .. } b: kids { .. }`) stays two
      // selections. Pre-2.5.0 they collapsed into one.
      // v2.5.3 — a key selected twice is merged (see `mergeSelection`);
      // the repeat's arguments are compared, not re-validated.
      const existing = seen.get(field.alias?.value ?? fieldName);

      const hasChildren = !!field.selectionSet;
      const isConnection = fieldName.endsWith('Connection');

      const node: SelectionNode = {
        fieldName,
        alias: field.alias?.value,
        isScalar: !hasChildren,
        isRelationship: hasChildren && !isConnection,
        isConnection,
      };

      if (typeCondition !== undefined) node.typeConditions = [typeCondition];
      if (field.arguments && field.arguments.length > 0) {
        argumentKeys.set(node, field.arguments.map((a) => print(a)).join(','));
        if (!existing) applyFieldArguments(field, node);
      }

      if (hasChildren && field.selectionSet)
        if (isConnection)
          // For connections, parse edges -> node and edges -> properties
          this.parseConnectionChildren(field.selectionSet, node);
        else node.children = this.convertSelectionSet(field.selectionSet);

      mergeSelection(nodes, seen, node);
    }

    return nodes;
  }

  /**
   * Parse the children of a connection field, extracting node and edge children.
   */
  private parseConnectionChildren(
    selectionSet: SelectionSetNode,
    parentNode: SelectionNode,
  ): void {
    let selectsEdges = false;
    for (const sel of selectionSet.selections) {
      if (sel.kind !== Kind.FIELD) continue;
      const field = sel as FieldNode;
      assertNoArguments(field, `${parentNode.fieldName}.${field.name.value}`);

      if (field.name.value === 'totalCount') parentNode.totalCount = true;
      if (field.name.value === 'edges') selectsEdges = true;

      if (field.name.value === 'edges' && field.selectionSet)
        for (const edgeSel of field.selectionSet.selections) {
          if (edgeSel.kind !== Kind.FIELD) continue;
          const edgeField = edgeSel as FieldNode;
          assertNoArguments(
            edgeField,
            `${parentNode.fieldName}.edges.${edgeField.name.value}`,
          );

          // v2.5.3 — a repeated `edges { node { … } }` merges its
          // sub-selections; pre-2.5.3 the last one replaced the others.
          if (edgeField.name.value === 'node' && edgeField.selectionSet)
            parentNode.children = mergeSelectionLists(
              parentNode.children,
              this.convertSelectionSet(edgeField.selectionSet),
            );

          if (edgeField.name.value === 'properties' && edgeField.selectionSet)
            parentNode.edgeChildren = mergeSelectionLists(
              parentNode.edgeChildren,
              this.convertSelectionSet(edgeField.selectionSet),
            );
        }
    }
    if (parentNode.totalCount && !selectsEdges)
      parentNode.totalCountOnly = true;
  }

  /**
   * Compile a relationship field into a Cypher pattern comprehension.
   */
  private compileRelationship(
    node: SelectionNode,
    parentVar: string,
    parentDef: NodeDefinition,
    maxDepth: number,
    currentDepth: number,
    params?: Record<string, unknown>,
    paramCounter?: { count: number },
    policyContext: PolicyContextBundle | null = null,
  ): string | null {
    if (currentDepth >= maxDepth) return null;

    const relDef = parentDef.relationships.get(node.fieldName);
    if (!relDef) return null;

    const targetDef = resolveTargetDef(relDef.target, this.schema);
    if (!targetDef) return null;

    const childVar = `n${currentDepth}`;
    const pattern = buildRelPattern({
      sourceVar: parentVar,
      relDef,
      targetVar: childVar,
      targetLabel: 'auto',
      schema: this.schema,
    });

    const children = node.children ?? [];
    const innerProjection = this.compile(
      children,
      childVar,
      targetDef,
      maxDepth,
      currentDepth + 1,
      params,
      paramCounter,
      null,
      policyContext,
    );

    // Compile WHERE clause for relationship filtering (Prisma-like select).
    // Combines user `select.where` with the target type's `'read'` policy.
    const whereClause = this.compileNestedWhere({
      node,
      childVar,
      targetDef,
      params,
      paramCounter,
      policyContext,
      contextLabel: `relationship "${node.fieldName}"`,
      userWhere: node.relationshipWhere,
    });

    const comprehension = `[${pattern}${whereClause} | ${innerProjection}]`;

    const paged = node.limit !== undefined || node.offset !== undefined;
    // Wrap singular relationships with head()
    if (!relDef.isArray) {
      if (paged || (node.hasArguments && node.orderBy))
        throw new OGMError(
          `options (sort, limit, offset) are not supported on singular relationship "${node.fieldName}".`,
        );
      return `head(${comprehension})`;
    }

    // Wrap with apoc.coll.sortMulti() if orderBy is present.
    // Requires the APOC plugin installed on the Neo4j instance.
    const sorted =
      node.orderBy && node.orderBy.length > 0
        ? this.compileSortedComprehension(
            `${pattern}${whereClause}`,
            innerProjection,
            childVar,
            targetDef,
            node.orderBy,
          )
        : comprehension;

    return paged
      ? `${sorted}${this.compileSlice(node, params, paramCounter)}`
      : sorted;
  }

  /**
   * `[$start..$end]` list slice for selectionSet `options.offset` /
   * `options.limit` (v2.5.0), with both bounds bound as parameters.
   */
  private compileSlice(
    node: SelectionNode,
    params?: Record<string, unknown>,
    paramCounter?: { count: number },
  ): string {
    if (!params || !paramCounter)
      throw new OGMError(
        `options.limit / options.offset on "${node.fieldName}" need a parameter map; ` +
          `compile through a Model or pass params and paramCounter.`,
      );
    const bind = (value: number): string => {
      const name = `sel_param${paramCounter.count++}`;
      params[name] = neo4jInt(value);
      return `$${name}`;
    };
    const start = node.offset ?? 0;
    const startRef = node.offset !== undefined ? bind(start) : '';
    const endRef = node.limit !== undefined ? bind(start + node.limit) : '';
    return `[${startRef}..${endRef}]`;
  }

  /**
   * A pattern comprehension sorted with `apoc.coll.sortMulti` (v2.4.8).
   * Each element is wrapped as `{ __node: <projection>, __skN: <sort
   * value> }` — sortMulti only reads top-level map keys — and unwrapped
   * after the sort, the same synthetic-key approach `compileConnection`
   * uses. Pre-2.4.8 the projected maps were sorted by the field NAMES,
   * which the projection often doesn't contain (`select: { id: true }`,
   * `orderBy: { rank: 'DESC' }`), so the list wasn't sorted at all.
   */
  private compileSortedComprehension(
    patternWithWhere: string,
    innerProjection: string,
    childVar: string,
    targetDef: NodeDefinition,
    orderBy: ReadonlyArray<{ field: string; direction: 'ASC' | 'DESC' }>,
  ): string {
    const sortParts: string[] = [];
    const sortKeys: string[] = [];
    orderBy.forEach(({ field, direction }, i) => {
      assertSafeIdentifier(field, 'orderBy sort key');
      const propDef = targetDef.properties.get(field);
      if (!propDef)
        throw new OGMError(
          `Invalid sort field "${field}": not a scalar property of ${targetDef.typeName}.`,
        );
      const value =
        propDef?.isCypher && propDef.cypherStatement
          ? buildInlineCypherFieldExpr(
              propDef.cypherStatement,
              childVar,
              `${targetDef.typeName}.${field}`,
            )
          : `${childVar}.${escapeIdentifier(field)}`;
      sortParts.push(`__sk${i}: ${value}`);
      // apoc.coll.sortMulti convention: ^ prefix = ASC, no prefix = DESC
      sortKeys.push(direction === 'ASC' ? `'^__sk${i}'` : `'__sk${i}'`);
    });
    const wrapped = `[${patternWithWhere} | { __node: ${innerProjection}, ${sortParts.join(', ')} }]`;
    return `[__sk IN apoc.coll.sortMulti(${wrapped}, [${sortKeys.join(', ')}]) | __sk.__node]`;
  }

  /**
   * Compile a relationship field within a union-target context.
   *
   * Different union members can have the same field name (e.g., "populations")
   * but different underlying Neo4j relationship types. This generates a
   * CASE WHEN expression that checks the node's labels and uses the correct
   * relationship type for each member.
   *
   * Example output:
   *   CASE
   *     WHEN n0:FormPresentationIcon THEN [(n0)-[:FP_POP]->(p:Population) | p { .id }]
   *     WHEN n0:AdministrationRateIcon THEN [(n0)-[:AR_POP]->(p:Population) | p { .id }]
   *     ELSE []
   *   END
   */
  private compileUnionRelationshipField(
    node: SelectionNode,
    nodeVar: string,
    unionMembers: string[],
    maxDepth: number,
    currentDepth: number,
    params?: Record<string, unknown>,
    paramCounter?: { count: number },
    policyContext: PolicyContextBundle | null = null,
  ): string | null {
    if (currentDepth >= maxDepth) return null;

    // v2.5.0 — fields on union members don't apply per-field arguments;
    // refuse them instead of dropping them.
    if (node.hasArguments)
      throw new OGMError(
        `selectionSet arguments on "${node.fieldName}" are not supported when selected through a union type.`,
      );

    const branches: string[] = [];
    let isSingular = false;

    for (const memberName of unionMembers) {
      const memberDef = this.schema.nodes.get(memberName);
      if (!memberDef) continue;

      const relDef = memberDef.relationships.get(node.fieldName);
      if (!relDef) continue;

      const targetDef = resolveTargetDef(relDef.target, this.schema);
      if (!targetDef) continue;

      // Track whether this is a singular (non-array) relationship
      if (!relDef.isArray) isSingular = true;

      const childVar = `n${currentDepth}`;
      const children = node.children ?? [];
      const innerProjection = this.compile(
        children,
        childVar,
        targetDef,
        maxDepth,
        currentDepth + 1,
        params,
        paramCounter,
        null,
        policyContext,
      );

      const pattern = buildRelPattern({
        sourceVar: nodeVar,
        relDef,
        targetVar: childVar,
        targetLabel: 'auto',
        schema: this.schema,
      });

      // Inject the union member's `'read'` policy into the comprehension WHERE.
      const memberPolicyWhere = this.compileNestedWhere({
        node,
        childVar,
        targetDef,
        params,
        paramCounter,
        policyContext,
        contextLabel: `union member "${memberName}" of "${node.fieldName}"`,
        // Union branches don't have a user select.where in the
        // SelectionNode model — only policies contribute here.
        userWhere: undefined,
      });

      // Wrap singular relationships with head() to return object instead of array
      const comprehension = isSingular
        ? `head([${pattern}${memberPolicyWhere} | ${innerProjection}])`
        : `[${pattern}${memberPolicyWhere} | ${innerProjection}]`;
      const memberLabel = escapeIdentifier(memberName);
      branches.push(`WHEN ${nodeVar}:${memberLabel} THEN ${comprehension}`);
    }

    if (branches.length === 0) return null;

    const elseClause = isSingular ? 'null' : '[]';
    return `CASE ${branches.join(' ')} ELSE ${elseClause} END`;
  }

  /**
   * Compile a connection field into a Cypher pattern comprehension with edge properties.
   */
  private compileConnection(
    node: SelectionNode,
    parentVar: string,
    parentDef: NodeDefinition,
    maxDepth: number,
    currentDepth: number,
    params?: Record<string, unknown>,
    paramCounter?: { count: number },
    policyContext: PolicyContextBundle | null = null,
  ): string | null {
    if (currentDepth >= maxDepth) return null;

    // Strip 'Connection' suffix to find the relationship field
    const baseFieldName = node.fieldName.replace(/Connection$/, '');
    const relDef = parentDef.relationships.get(baseFieldName);
    if (!relDef) return null;

    const targetDef = resolveTargetDef(relDef.target, this.schema);
    if (!targetDef) return null;

    const childVar = `n${currentDepth}`;
    const edgeVar = `e${currentDepth}`;
    const pattern = buildRelPattern({
      sourceVar: parentVar,
      relDef,
      targetVar: childVar,
      edgeVar,
      targetLabel: 'auto',
      schema: this.schema,
    });

    const mapParts: string[] = [];
    const projectionKeys: string[] = [];

    // Compile node projection
    if (node.children && node.children.length > 0) {
      const nodeProjection = this.compile(
        node.children,
        childVar,
        targetDef,
        maxDepth,
        currentDepth + 1,
        params,
        paramCounter,
        null,
        policyContext,
      );
      mapParts.push(`node: ${nodeProjection}`);
      projectionKeys.push('node');
    }

    // Compile edge properties projection
    if (node.edgeChildren && node.edgeChildren.length > 0) {
      const edgeFields = node.edgeChildren
        .filter((c) => c.isScalar)
        .map((c) => `.${escapeIdentifier(c.fieldName)}`)
        .join(', ');
      mapParts.push(`properties: ${edgeVar} { ${edgeFields} }`);
      projectionKeys.push('properties');
    }

    // Inject synthetic sort scalars at the top level of the edge map so
    // apoc.coll.sortMulti (which only accepts top-level keys) can order the
    // collection. The outer list comprehension strips them on the way out.
    const sortKeyTokens: string[] = [];
    if (node.connectionOrderBy && node.connectionOrderBy.length > 0)
      node.connectionOrderBy.forEach(({ field, direction, scope }, i) => {
        assertSafeIdentifier(field, 'connection orderBy field');
        const sourceVar = scope === 'edge' ? edgeVar : childVar;
        const syntheticKey = `__sk${i}`;
        mapParts.push(
          `${syntheticKey}: ${sourceVar}.${escapeIdentifier(field)}`,
        );
        // apoc.coll.sortMulti convention: ^ prefix = ASC, no prefix = DESC
        sortKeyTokens.push(
          direction === 'ASC' ? `'^${syntheticKey}'` : `'${syntheticKey}'`,
        );
      });

    const innerMap = `{ ${mapParts.join(', ')} }`;

    // Add WHERE clause(s) if connectionWhere is present. Node-side filter is
    // AND-combined with the target type's `'read'` policy; edge-side filter
    // is compiled against a synthetic NodeDefinition built from the
    // relationship-properties type. Both fragments AND-merge into a single
    // WHERE clause inside the pattern comprehension.
    let whereClause = '';
    if (node.connectionWhere && Object.keys(node.connectionWhere).length > 0) {
      const cw = node.connectionWhere as Record<string, unknown>;
      const hasNodeKey = isPlainObject(cw.node);
      const hasEdgeKey = isPlainObject(cw.edge);
      const hasNodeNotKey = isPlainObject(cw.node_NOT);
      const hasEdgeNotKey = isPlainObject(cw.edge_NOT);

      // Connection-level AND/OR/NOT in the typed `select.where`
      // connection filter is codegen-emitted but not yet runtime-
      // supported on the selection path (the `where:` argument on
      // model methods supports it via WhereCompiler). Throw loudly
      // so silent-drop never produces wrong results.
      if (cw.AND !== undefined || cw.OR !== undefined || cw.NOT !== undefined)
        throw new OGMError(
          `Connection-level AND/OR/NOT inside select.where for "${node.fieldName}" is not yet supported. ` +
            `Move the logical operators inside the \`node\` filter, or use the top-level \`where\` argument.`,
        );

      // Resolve the node-side and edge-side branches. Bare-object input
      // (no `node`/`edge`/`*_NOT` keys) is the legacy node-where
      // shorthand from pre-1.7.1 callers — keep treating it as node-
      // where so existing code keeps working.
      const userNodeWhere = hasNodeKey
        ? (cw.node as Record<string, unknown>)
        : !hasEdgeKey && !hasNodeNotKey && !hasEdgeNotKey
          ? cw
          : undefined;
      const userEdgeWhere = hasEdgeKey
        ? (cw.edge as Record<string, unknown>)
        : undefined;
      const userNodeNot = hasNodeNotKey
        ? (cw.node_NOT as Record<string, unknown>)
        : undefined;
      const userEdgeNot = hasEdgeNotKey
        ? (cw.edge_NOT as Record<string, unknown>)
        : undefined;

      const fragments: string[] = [];

      if (this.whereCompiler && targetDef) {
        // Node-side (always run when whereCompiler is wired so policy still
        // injects even when the user only filters on the edge).
        const nodeFragment = this.compileNestedWhere({
          node,
          childVar,
          targetDef,
          params,
          paramCounter,
          policyContext,
          contextLabel: `connection "${node.fieldName}"`,
          userWhere: userNodeWhere,
        });
        if (nodeFragment) fragments.push(nodeFragment.replace(/^ WHERE /, ''));

        // Node-side negation. We compile it WITHOUT policy injection
        // (policy was already attached above) and wrap the body in
        // `NOT (...)`. Compiling with a fresh nested where call is the
        // simplest way to reuse all the existing operator support.
        if (userNodeNot) {
          const notFragment = this.compileNestedWhere({
            node,
            childVar,
            targetDef,
            params,
            paramCounter,
            // The target policy is already AND-stitched on the main
            // node-side fragment (outside this negation); compile the
            // filter alone, with traversals inside it still enforcing.
            policyContext,
            userOnly: true,
            contextLabel: `connection "${node.fieldName}" node_NOT`,
            userWhere: userNodeNot,
          });
          if (notFragment)
            fragments.push(`NOT (${notFragment.replace(/^ WHERE /, '')})`);
        }

        // Edge-side
        if (userEdgeWhere && relDef.properties) {
          const edgeFragment = this.compileEdgeWhere({
            edgeVar,
            propsTypeName: relDef.properties,
            userWhere: userEdgeWhere,
            params,
            paramCounter,
            contextLabel: `connection "${node.fieldName}" edge`,
          });
          if (edgeFragment)
            fragments.push(edgeFragment.replace(/^ WHERE /, ''));
        }

        // Edge-side negation
        if (userEdgeNot && relDef.properties) {
          const edgeNotFragment = this.compileEdgeWhere({
            edgeVar,
            propsTypeName: relDef.properties,
            userWhere: userEdgeNot,
            params,
            paramCounter,
            contextLabel: `connection "${node.fieldName}" edge_NOT`,
          });
          if (edgeNotFragment)
            fragments.push(`NOT (${edgeNotFragment.replace(/^ WHERE /, '')})`);
        }
      } else {
        // Fallback for callers that didn't wire a WhereCompiler: simple
        // node-where only, edge-where silently ignored (legacy behavior).
        const simpleWhere = this.compileSimpleWhere(
          userNodeWhere ?? cw,
          childVar,
          params,
          paramCounter,
        );
        if (simpleWhere) fragments.push(simpleWhere);
      }

      whereClause = fragments.length ? ` WHERE ${fragments.join(' AND ')}` : '';
    } else if (this.whereCompiler && targetDef)
      // No user where but we still need the policy injected if active.
      whereClause = this.compileNestedWhere({
        node,
        childVar,
        targetDef,
        params,
        paramCounter,
        policyContext,
        contextLabel: `connection "${node.fieldName}"`,
        userWhere: undefined,
      });

    // v2.4.8 — `totalCount` counts the very comprehension `edges` lists
    // (same pattern, same `where`, same target `read` policy), so it can
    // never count a node the caller cannot see. Pre-2.4.8 it was dropped.
    const totalCount = node.totalCount
      ? `totalCount: size([${pattern}${whereClause} | 1])`
      : '';
    if (node.totalCountOnly) return `{ ${totalCount} }`;
    const withTotal = totalCount ? `, ${totalCount}` : '';

    if (sortKeyTokens.length === 0)
      return `{ edges: [${pattern}${whereClause} | ${innerMap}]${withTotal} }`;

    // Re-project only the user-facing keys so synthetic __skN scalars don't
    // leak out of the projection.
    const outerProjection =
      projectionKeys.length > 0
        ? `{ ${projectionKeys.map((k) => `${k}: x.${k}`).join(', ')} }`
        : `{}`;
    return `{ edges: [x IN apoc.coll.sortMulti([${pattern}${whereClause} | ${innerMap}], [${sortKeyTokens.join(
      ', ',
    )}]) | ${outerProjection}]${withTotal} }`;
  }

  /**
   * AND-combine an optional user where (`select.where` / `connectionWhere`)
   * with the target type's `'read'` policy and emit a `WHERE …` fragment
   * (with leading space). Returns `''` when nothing applies.
   *
   * The returned where lives inside a pattern comprehension so any
   * `@cypher` field used by the policy MUST throw — the comprehension
   * cannot host CALL { ... } subqueries. The error message points to the
   * documented limitation.
   */
  private compileNestedWhere(args: {
    node: SelectionNode;
    childVar: string;
    targetDef: NodeDefinition;
    params: Record<string, unknown> | undefined;
    paramCounter: { count: number } | undefined;
    policyContext: PolicyContextBundle | null;
    contextLabel: string;
    userWhere: Record<string, unknown> | undefined;
    /**
     * Compile the caller's filter only — no clause for the target itself
     * (its policy is applied elsewhere, outside a negation). Traversals
     * inside the filter still enforce their own targets' policies.
     */
    userOnly?: boolean;
  }): string {
    const {
      node,
      childVar,
      targetDef,
      params,
      paramCounter,
      policyContext,
      contextLabel,
      userWhere,
      userOnly,
    } = args;
    if (!this.whereCompiler || !params || !paramCounter) {
      // Without these, the policy can't be compiled — fall back to user-only
      // (matches v1.6.0 behavior when WhereCompiler isn't wired).
      if (userWhere && Object.keys(userWhere).length > 0)
        // We can't compile via whereCompiler without paramCounter; let
        // the fallback simple where path handle it.
        return '';

      return '';
    }

    // v2.3.0 — the caller's filter and the target's `'read'` policy come
    // from the shared `WhereCompiler.compileTargetBody`: a concrete
    // target's own clause, or for an interface / union target a CASE over
    // each member's own clause (pre-2.3.0 this resolved the ABSTRACT type,
    // which carries none of its members' policies). The filter compiles
    // under a live bundle even when the target has no policy, so
    // traversals inside it keep enforcing at any depth.
    let parts: {
      user: string;
      policy: string;
      params: Record<string, unknown>;
      preludes: string[];
    };
    if (userOnly) {
      const compiled = this.whereCompiler.compile(
        userWhere,
        childVar,
        targetDef,
        paramCounter,
        policyContext
          ? { policyContext: traversalBundle(policyContext) }
          : undefined,
      );
      parts = {
        user: compiled.cypher,
        policy: '',
        params: compiled.params,
        preludes: compiled.preludes ?? [],
      };
    } else
      parts = this.whereCompiler.compileTargetBody(
        userWhere,
        childVar,
        targetDef,
        paramCounter,
        policyContext ?? undefined,
      );

    // Pattern comprehensions cannot host CALL { ... } subqueries.
    if (parts.preludes.length > 0) {
      if (parts.policy)
        throw new OGMError(
          `Policy on "${targetDef.typeName}" requires @cypher field projection, ` +
            `which is not supported inside nested-selection enforcement (${contextLabel}). ` +
            `Refactor the policy to use stored properties or a relationship traversal.`,
        );
      throw new OGMError(
        `Filtering ${contextLabel} by an @cypher field is not supported. ` +
          `@cypher fields can only appear in top-level WHERE filters, not inside select.where on relationships.`,
      );
    }

    mergeParams(params, parts.params);
    const cypher = stitchUserAndPolicy(parts.user, parts.policy);
    void node;
    return cypher ? ` WHERE ${cypher}` : '';
  }

  /**
   * Compile a connection's `edge`-side WHERE filter against the relationship
   * properties type. Reuses `WhereCompiler.compile()` by synthesizing a
   * `NodeDefinition` from the `RelationshipPropertiesDefinition` — full
   * operator support (scalar ops, AND/OR/NOT, `mode`) flows through for free.
   *
   * Edges have no policy enforcement (policies bind to node typeNames), so
   * this never resolves a policy context. `@cypher` field projections are
   * rejected with the same error pattern as nested-node selection where:
   * pattern comprehensions cannot host CALL { ... } subqueries.
   */
  private compileEdgeWhere(args: {
    edgeVar: string;
    propsTypeName: string;
    userWhere: Record<string, unknown>;
    params: Record<string, unknown> | undefined;
    paramCounter: { count: number } | undefined;
    contextLabel: string;
  }): string {
    const {
      edgeVar,
      propsTypeName,
      userWhere,
      params,
      paramCounter,
      contextLabel,
    } = args;
    if (!this.whereCompiler || !params || !paramCounter) return '';

    const propsDef = this.schema.relationshipProperties.get(propsTypeName);
    if (!propsDef) return '';

    const syntheticDef: NodeDefinition = {
      typeName: propsDef.typeName,
      label: propsDef.typeName,
      labels: [],
      pluralName: '',
      properties: propsDef.properties,
      relationships: new Map(),
      fulltextIndexes: propsDef.fulltextIndexes ?? [],
      implementsInterfaces: [],
    };

    const compiled = this.whereCompiler.compile(
      userWhere,
      edgeVar,
      syntheticDef,
      paramCounter,
    );

    if (compiled.preludes && compiled.preludes.length > 0)
      throw new OGMError(
        `Filtering ${contextLabel} by an @cypher field is not supported. ` +
          `@cypher fields can only appear in top-level WHERE filters, not inside select.where on relationship edges.`,
      );

    if (compiled.cypher) {
      mergeParams(params, compiled.params);
      return ` WHERE ${compiled.cypher}`;
    }
    return '';
  }

  /**
   * Compile a __typename expression for a node.
   * For union targets: picks the label matching a union member name.
   * For concrete types: returns a string constant.
   */
  private compileTypename(nodeVar: string, nodeDef: NodeDefinition): string {
    const unionMembers = this.schema.unions?.get(nodeDef.typeName);
    if (unionMembers && unionMembers.length > 0) {
      const memberList = unionMembers.map((m) => `'${m}'`).join(', ');
      return `head([__label IN labels(${nodeVar}) WHERE __label IN [${memberList}]])`;
    }
    const interfaceDef = this.schema.interfaces?.get(nodeDef.typeName);
    if (
      interfaceDef &&
      interfaceDef.implementedBy &&
      interfaceDef.implementedBy.length > 0
    ) {
      const memberList = interfaceDef.implementedBy
        .map((m) => `'${m}'`)
        .join(', ');
      return `head([__label IN labels(${nodeVar}) WHERE __label IN [${memberList}]])`;
    }
    return `'${nodeDef.typeName}'`;
  }

  /**
   * Compile a simple where object into a Cypher WHERE clause fragment.
   * This is a minimal implementation for connection where filters.
   */
  private compileSimpleWhere(
    where: Record<string, unknown>,
    nodeVar: string,
    params?: Record<string, unknown>,
    paramCounter?: { count: number },
  ): string {
    if (!params || !paramCounter)
      throw new OGMError(
        'compileSimpleWhere requires params and paramCounter for safe parameterization',
      );

    const conditions: string[] = [];
    for (const [key, value] of Object.entries(where)) {
      // Handle nested { node: { ... } } pattern
      if (key === 'node' && isPlainObject(value))
        return this.compileSimpleWhere(value, nodeVar, params, paramCounter);

      if (key.endsWith('_IN') && Array.isArray(value)) {
        const fieldName = key.slice(0, -3);
        assertSafeIdentifier(fieldName, 'connection where');
        const paramName = `sel_param${paramCounter.count++}`;
        params[paramName] = value;
        conditions.push(
          `${nodeVar}.${escapeIdentifier(fieldName)} IN $${paramName}`,
        );
      } else if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        assertSafeIdentifier(key, 'connection where');
        const paramName = `sel_param${paramCounter.count++}`;
        params[paramName] = value;
        conditions.push(`${nodeVar}.${escapeIdentifier(key)} = $${paramName}`);
      }
    }
    return conditions.join(' AND ');
  }
}

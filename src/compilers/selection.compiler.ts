import {
  Kind,
  parse,
  print,
  valueFromASTUntyped,
  type ValueNode,
  type DirectiveNode,
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
  RelationshipDefinition,
  SchemaMetadata,
} from '../schema/types';
import { buildRelPattern, resolveTargetDef } from '../schema/utils';
import {
  nodeLabelExpr,
  nodeLabelList,
  typeLabelExpr,
  typenameByLabels,
} from '../schema/labels';
import {
  CypherFieldScope,
  buildInlineCypherFieldExpr,
  cypherFieldAsList,
} from '../utils/cypher-field-projection';
import {
  assertSafeIdentifier,
  assertSortDirection,
  escapeIdentifier,
  isPlainObject,
  mergeParams,
} from '../utils/validation';
import { lenientStrictMode, StrictMode } from '../utils/strict-mode';
import { normalizeConnectionOrderBy } from './connection-order-by';
import {
  AGGREGATE_SUFFIX,
  aggregateKind,
  aggregateSelectionTypeName,
  assertAggregateOp,
  fieldAggregateMap,
  propertyRef,
} from './relationship-aggregate';
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
   * Connection only: the selectionSet `sort` argument as parsed (v2.7.0 —
   * pre-2.7.0 it threw). Its shape is checked when parsed; it is checked
   * against the schema and normalized into `connectionOrderBy` entries
   * when compiled, then sorted exactly as the typed `select` `orderBy`.
   */
  connectionSort?: unknown;
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
  /**
   * Connection only (v2.5.3): selectionSet aliases of the connection's own
   * keys. Pre-2.5.3 they were ignored and the keys always came back as
   * `edges`, `node`, `properties` and `totalCount`.
   */
  connectionAliases?: {
    totalCount?: string;
    edges?: string;
    node?: string;
    properties?: string;
  };
  /**
   * Connection only, strict mode (v2.6.0): further `edges` selections under
   * OTHER response keys (`a: edges { … } b: edges { … }`). Each carries its
   * own `children`, `edgeChildren` and `connectionAliases` (`edges` = its
   * key); the connection's pattern, filter and policy are shared. 2.x
   * merges them into the first `edges` under the first alias.
   */
  extraEdges?: SelectionNode[];
  /**
   * Strict mode (v2.6.0): the same response key selected with DIFFERENT
   * arguments by inline fragments whose types can never be the same object
   * (`... on Dog { pals(where: A) } ... on Cat { pals(where: B) }`) — valid
   * GraphQL. Each variant keeps its own arguments and is projected per
   * concrete type. 2.x keeps the first selection for every type.
   */
  typeVariants?: SelectionNode[];
  /**
   * Connection edge set only, strict mode (v2.6.0): `node` / `properties`
   * selected under further response keys inside one `edges`
   * (`edges { a: node { … } b: node { … } }`), each with its own
   * selection. 2.x merges them into the first key.
   */
  extraNodes?: EdgeKeySelection[];
  extraProperties?: EdgeKeySelection[];
  /**
   * v2.7.0 — `<rel>Aggregate(directed: false)`: aggregate over the
   * relationship in either direction (upstream's `directed` argument,
   * default `true`). Only relationship aggregates accept it.
   */
  directed?: boolean;
  /**
   * Connection only (v2.8.0): the `pageInfo` selections, one per response
   * key. Pre-2.8.0 `pageInfo` was silently dropped although the generated
   * connection type declares it.
   */
  pageInfo?: PageInfoSelection[];
  /**
   * Connection edge set only (v2.8.0): the `cursor` selections of `edges`,
   * one per response key. Pre-2.8.0 `cursor` was silently dropped.
   */
  cursors?: ConnectionKeySelection[];
}

/**
 * v2.8.0 — one selected key inside a connection (`cursor` of `edges`, or a
 * field of `pageInfo`): its response key, the field it selects and whether
 * it was given a sub-selection (a shape mismatch: reported, never projected).
 */
export interface ConnectionKeySelection {
  key: string;
  field: string;
  subSelection?: boolean;
}

/**
 * v2.8.0 — a connection's `pageInfo` under one response key. `fields` is
 * absent when `pageInfo` was selected without a sub-selection (a shape
 * mismatch: reported, never projected).
 */
export interface PageInfoSelection {
  key: string;
  fields?: ConnectionKeySelection[];
}

/** v2.8.0 — the fields of the generated `PageInfo` type. */
export const PAGE_INFO_FIELDS: ReadonlySet<string> = new Set([
  'hasNextPage',
  'hasPreviousPage',
  'startCursor',
  'endCursor',
]);

/** v2.8.0 — merge selections by response key (first one wins). */
function mergeKeySelections(
  base: ConnectionKeySelection[] | undefined,
  extra: ConnectionKeySelection[] | undefined,
): ConnectionKeySelection[] | undefined {
  if (!extra || extra.length === 0) return base;
  const out = [...(base ?? [])];
  for (const sel of extra)
    if (!out.some((s) => s.key === sel.key)) out.push(sel);
  return out;
}

/** v2.8.0 — merge `pageInfo` selections by response key, fields unioned. */
function mergePageInfo(
  base: PageInfoSelection[] | undefined,
  extra: PageInfoSelection[] | undefined,
): PageInfoSelection[] | undefined {
  if (!extra || extra.length === 0) return base;
  const out = (base ?? []).map((p) => ({ ...p }));
  for (const sel of extra) {
    const same = out.find((p) => p.key === sel.key);
    if (!same) out.push({ ...sel });
    else if (sel.fields)
      same.fields = mergeKeySelections(same.fields ?? [], sel.fields);
  }
  return out;
}

/** One extra `node` / `properties` key of an edge set (v2.6.0, strict). */
export interface EdgeKeySelection {
  key: string;
  children: SelectionNode[];
}

/**
 * v2.5.3 — the printed arguments of a parsed selectionSet field, so a
 * response key selected twice merges its sub-selections only when both
 * selections carry the same arguments.
 */
const argumentKeys = new WeakMap<SelectionNode, string>();

/** A strict-mode warning found while parsing a selectionSet (v2.6.0). */
interface ParseWarning {
  code: string;
  detail: string;
  problem: string;
  fix: string;
}

/**
 * v2.6.0 — the strict-mode warnings of each parsed selectionSet, replayed
 * on cache hits (see `SelectionCompiler.replayParseWarnings`).
 */
const parseWarnings = new WeakMap<SelectionNode[], ParseWarning[]>();

/**
 * v2.6.0 — strict-mode state of one selectionSet parse, threaded through
 * the converters and merge helpers: the OGM's `strict` flag and the
 * warnings found so far (recorded on the parsed result).
 */
interface ParseContext {
  strict: boolean;
  warnings: ParseWarning[];
  /**
   * The concrete object types a fragment type condition can apply to: the
   * type itself, an interface's implementers or a union's members.
   */
  possibleTypes: (typeName: string) => readonly string[];
}

/**
 * v2.6.0 — whether two selections of one response key can apply to the
 * same object. A selection outside any fragment applies to every object;
 * fragment-only selections overlap when their type conditions share a
 * possible concrete type. Only overlapping selections with different
 * arguments conflict (GraphQL's "fields in set can merge" rule).
 */
function canApplyToSameObject(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
  ctx: ParseContext,
): boolean {
  if (!a || !b) return true;
  const types = new Set(a.flatMap((t) => ctx.possibleTypes(t)));
  return b.some((t) => ctx.possibleTypes(t).some((p) => types.has(p)));
}

/**
 * v2.6.0 — strict merge of a response key selected with different
 * arguments: a conflict throws (as GraphQL validation does) when the two
 * selections can apply to the same object; otherwise the incoming
 * selection becomes (or joins) a per-type variant.
 */
function mergeTypeVariant(
  existing: SelectionNode,
  incoming: SelectionNode,
  key: string,
  ctx: ParseContext,
): void {
  const groups = [existing, ...(existing.typeVariants ?? [])];
  for (const group of groups)
    if (
      !sameArguments(group, incoming) &&
      canApplyToSameObject(group.typeConditions, incoming.typeConditions, ctx)
    )
      throw new OGMError(
        `Fields "${key}" conflict because they have differing arguments. ` +
          `Use different aliases on the fields to fetch both.`,
      );
  const same = groups.find((g) => sameArguments(g, incoming));
  if (!same) {
    existing.typeVariants = [...(existing.typeVariants ?? []), incoming];
    return;
  }
  if (same.typeConditions && incoming.typeConditions)
    same.typeConditions = [
      ...new Set([...same.typeConditions, ...incoming.typeConditions]),
    ];
  mergeSameArguments(same, incoming, ctx);
}

function parseWarn(ctx: ParseContext, warning: ParseWarning): void {
  if (
    !ctx.warnings.some(
      (w) => w.code === warning.code && w.detail === warning.detail,
    )
  )
    ctx.warnings.push(warning);
}

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
  ctx: ParseContext,
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
  if (
    ctx.strict &&
    (!sameArguments(existing, incoming) || existing.typeVariants)
  ) {
    mergeTypeVariant(existing, incoming, key, ctx);
    return;
  }
  const priorTypes = existing.typeConditions;
  if (existing.typeConditions && incoming.typeConditions)
    existing.typeConditions = [
      ...new Set([...existing.typeConditions, ...incoming.typeConditions]),
    ];
  // Also selected outside any fragment → unconditional.
  else delete existing.typeConditions;
  if (!sameArguments(existing, incoming)) {
    // v2.6.0 — GraphQL rejects one response key selected with different
    // arguments when both selections can apply to the same object; 2.x
    // keeps the first selection and drops the second. Fragments on types
    // that can never be the same object are valid GraphQL: no warning
    // (strict projects each per type, see `mergeTypeVariant`).
    if (!canApplyToSameObject(priorTypes, incoming.typeConditions, ctx)) return;
    parseWarn(ctx, {
      code: 'selection-key-arguments',
      detail: key,
      problem:
        `The selectionSet selects "${key}" twice with different arguments; ` +
        `2.x keeps the first selection and drops the second.`,
      fix: 'reject the conflict, as GraphQL validation does',
    });
    return;
  }
  mergeSameArguments(existing, incoming, ctx);
}

/** Merge a repeat of a response key with the same arguments (v2.5.3). */
function mergeSameArguments(
  existing: SelectionNode,
  incoming: SelectionNode,
  ctx: ParseContext,
): void {
  const key = incoming.alias ?? incoming.fieldName;
  if (existing.isConnection) {
    if (ctx.strict) {
      mergeConnectionEdgeSets(existing, incoming, ctx);
      return;
    }
    if (
      !existing.totalCountOnly &&
      !incoming.totalCountOnly &&
      edgesKeyOf(existing) !== edgesKeyOf(incoming)
    )
      warnAliasedEdges(ctx, key, edgesKeyOf(existing), edgesKeyOf(incoming));
    else
      for (const which of ['node', 'properties'] as const) {
        const a = which === 'node' ? existing.children : existing.edgeChildren;
        const b = which === 'node' ? incoming.children : incoming.edgeChildren;
        const ka = existing.connectionAliases?.[which] ?? which;
        const kb = incoming.connectionAliases?.[which] ?? which;
        if (a && b && ka !== kb) warnAliasedEdgeKey(ctx, key, which, ka, kb);
      }
  }
  if (incoming.children)
    existing.children = mergeSelectionLists(
      existing.children,
      incoming.children,
      ctx,
    );
  if (incoming.edgeChildren)
    existing.edgeChildren = mergeSelectionLists(
      existing.edgeChildren,
      incoming.edgeChildren,
      ctx,
    );
  if (existing.isConnection) {
    if (incoming.totalCount) existing.totalCount = true;
    // v2.8.0 — `pageInfo` / `cursor` merge by response key.
    const pageInfo = mergePageInfo(existing.pageInfo, incoming.pageInfo);
    if (pageInfo) existing.pageInfo = pageInfo;
    const cursors = mergeKeySelections(existing.cursors, incoming.cursors);
    if (cursors) existing.cursors = cursors;
    if (existing.totalCountOnly && !incoming.totalCountOnly)
      delete existing.totalCountOnly;
    if (incoming.connectionAliases)
      existing.connectionAliases = {
        ...incoming.connectionAliases,
        ...existing.connectionAliases,
      };
  }
}

/** The response key of a connection's (first) `edges` selection. */
function edgesKeyOf(node: SelectionNode): string {
  return node.connectionAliases?.edges ?? 'edges';
}

/** v2.6.0 — 2.x merges differently aliased `edges` under the first alias. */
function warnAliasedEdges(
  ctx: ParseContext,
  connection: string,
  first: string,
  second: string,
): void {
  parseWarn(ctx, {
    code: 'selection-aliased-edges',
    detail: `${connection}:${first}:${second}`,
    problem:
      `"${connection}" selects \`edges\` under two response keys ("${first}", "${second}"); ` +
      `2.x returns only "${first}", with both selections merged into it.`,
    fix: 'return each `edges` alias with its own selection',
  });
}

/** v2.6.0 — 2.x merges differently aliased `node` / `properties` keys. */
function warnAliasedEdgeKey(
  ctx: ParseContext,
  connection: string,
  which: 'node' | 'properties',
  first: string,
  second: string,
): void {
  parseWarn(ctx, {
    code: 'selection-aliased-edge-key',
    detail: `${connection}:${which}:${first}:${second}`,
    problem:
      `"${connection}" selects \`${which}\` under two response keys ("${first}", "${second}") in its edges; ` +
      `2.x returns only "${first}", with both selections merged into it.`,
    fix: `return each \`${which}\` alias with its own selection`,
  });
}

/** The `node` (or `properties`) keys of an edge set, main key first. */
function edgeKeyEntries(
  set: SelectionNode,
  which: 'node' | 'properties',
): EdgeKeySelection[] {
  const main = which === 'node' ? set.children : set.edgeChildren;
  const extras =
    (which === 'node' ? set.extraNodes : set.extraProperties) ?? [];
  return [
    ...(main
      ? [{ key: set.connectionAliases?.[which] ?? which, children: main }]
      : []),
    ...extras,
  ];
}

/** Store `entries` (main key first) back on an edge set (strict). */
function setEdgeKeyEntries(
  set: SelectionNode,
  which: 'node' | 'properties',
  entries: EdgeKeySelection[],
): void {
  const [main, ...rest] = entries;
  const extrasProp = which === 'node' ? 'extraNodes' : 'extraProperties';
  if (which === 'node') set.children = main?.children;
  else set.edgeChildren = main?.children;
  if (!main)
    if (which === 'node') delete set.children;
    else delete set.edgeChildren;

  if (main && main.key !== which)
    set.connectionAliases = { ...set.connectionAliases, [which]: main.key };
  else if (set.connectionAliases) {
    delete set.connectionAliases[which];
    if (Object.keys(set.connectionAliases).length === 0)
      delete set.connectionAliases;
  }
  if (rest.length > 0) set[extrasProp] = rest;
  else delete set[extrasProp];
}

/** Merge two edge sets' `node` / `properties` keys by response key (strict). */
function mergeEdgeKeys(
  into: SelectionNode,
  from: SelectionNode,
  ctx: ParseContext,
): void {
  for (const which of ['node', 'properties'] as const) {
    const merged = edgeKeyEntries(into, which).map((e) => ({ ...e }));
    for (const entry of edgeKeyEntries(from, which)) {
      const same = merged.find((m) => m.key === entry.key);
      if (same)
        same.children = mergeSelectionLists(same.children, entry.children, ctx);
      else merged.push({ ...entry });
    }
    setEdgeKeyEntries(into, which, merged);
  }
  // v2.8.0 — `cursor` keys merge by response key too.
  const cursors = mergeKeySelections(into.cursors, from.cursors);
  if (cursors) into.cursors = cursors;
}

/** A connection's edges selection as a standalone edge set (strict). */
function asEdgeSet(node: SelectionNode): SelectionNode | null {
  if (node.totalCountOnly) return null;
  const set: SelectionNode = {
    fieldName: node.fieldName,
    isScalar: false,
    isRelationship: false,
    isConnection: true,
  };
  if (node.children) set.children = node.children;
  if (node.edgeChildren) set.edgeChildren = node.edgeChildren;
  if (node.extraNodes) set.extraNodes = node.extraNodes;
  if (node.extraProperties) set.extraProperties = node.extraProperties;
  if (node.cursors) set.cursors = node.cursors;
  const { totalCount: _total, ...aliases } = node.connectionAliases ?? {};
  if (Object.keys(aliases).length > 0) set.connectionAliases = aliases;
  return set;
}

/**
 * v2.6.0 — strict merge of a connection selected twice (same arguments):
 * edge sets merge by response key, so `a: edges` and `b: edges` stay apart.
 */
function mergeConnectionEdgeSets(
  existing: SelectionNode,
  incoming: SelectionNode,
  ctx: ParseContext,
): void {
  const sets = new Map<string, SelectionNode>();
  const add = (set: SelectionNode) => {
    const k = edgesKeyOf(set);
    const prev = sets.get(k);
    if (!prev) {
      sets.set(k, {
        ...set,
        ...(set.connectionAliases
          ? { connectionAliases: { ...set.connectionAliases } }
          : {}),
      });
      return;
    }
    // v2.6.0 — `node` / `properties` keys merge by response key too.
    mergeEdgeKeys(prev, set, ctx);
  };
  for (const node of [existing, incoming]) {
    const main = asEdgeSet(node);
    if (main) add(main);
    for (const extra of node.extraEdges ?? []) add(extra);
  }
  const totalAlias =
    existing.connectionAliases?.totalCount ??
    incoming.connectionAliases?.totalCount;
  if (incoming.totalCount) existing.totalCount = true;
  const pageInfo = mergePageInfo(existing.pageInfo, incoming.pageInfo);
  if (pageInfo) existing.pageInfo = pageInfo;
  const [main, ...rest] = [...sets.values()];
  if (main) {
    delete existing.totalCountOnly;
    if (main.cursors) existing.cursors = main.cursors;
    else delete existing.cursors;
    if (main.children) existing.children = main.children;
    else delete existing.children;
    if (main.edgeChildren) existing.edgeChildren = main.edgeChildren;
    else delete existing.edgeChildren;
    if (main.extraNodes) existing.extraNodes = main.extraNodes;
    else delete existing.extraNodes;
    if (main.extraProperties) existing.extraProperties = main.extraProperties;
    else delete existing.extraProperties;
  }
  const aliases = {
    ...(main?.connectionAliases ?? {}),
    ...(totalAlias !== undefined ? { totalCount: totalAlias } : {}),
  };
  if (Object.keys(aliases).length > 0) existing.connectionAliases = aliases;
  else delete existing.connectionAliases;
  if (rest.length > 0) existing.extraEdges = rest;
  else delete existing.extraEdges;
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
  ctx: ParseContext,
): SelectionNode[] {
  const list: SelectionNode[] = [];
  const seen = new Map<string, SelectionNode>();
  for (const node of [...(base ?? []), ...extra])
    mergeSelection(list, seen, node, ctx);
  return list;
}

/** selectionSet field arguments the OGM honours, by field kind (v2.5.0). */
const RELATIONSHIP_ARGUMENTS = new Set(['where', 'options']);
// v2.7.0 — `sort` on connection fields (#25); pre-2.7.0 it threw.
const CONNECTION_ARGUMENTS = new Set(['where', 'sort']);
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

/**
 * v2.6.0 — whether `@include` / `@skip` keep a selectionSet field or inline
 * fragment. 2.x ignores both directives (the selection is always kept) and
 * warns; strict honours a literal `if: true | false` and rejects anything
 * else, `$variables` included (selectionSet strings have no variables).
 */
function keptByDirectives(
  directives: readonly DirectiveNode[] | undefined,
  where: string,
  ctx: ParseContext,
): boolean {
  const relevant = (directives ?? []).filter(
    (d) => d.name.value === 'include' || d.name.value === 'skip',
  );
  if (relevant.length === 0) return true;
  if (!ctx.strict) {
    parseWarn(ctx, {
      code: 'selection-include-skip',
      detail: where,
      problem:
        `@include / @skip on "${where}" in a selectionSet is ignored in 2.x: ` +
        `the selection is always kept.`,
      fix: 'honour @include / @skip with a literal `if: true | false`',
    });
    return true;
  }
  let kept = true;
  for (const directive of relevant) {
    const name = directive.name.value;
    const args = directive.arguments ?? [];
    const arg = args.length === 1 ? args[0] : undefined;
    if (!arg || arg.name.value !== 'if')
      throw new OGMError(
        `@${name} on "${where}" takes exactly one argument: if: true | false.`,
      );
    if (arg.value.kind === Kind.VARIABLE)
      throw new OGMError(
        `GraphQL variables are not supported in selectionSet directives (@${name} on "${where}": ` +
          `$${arg.value.name.value}). Use a literal true or false.`,
      );
    if (arg.value.kind !== Kind.BOOLEAN)
      throw new OGMError(
        `@${name}(if:) on "${where}" must be a literal true or false.`,
      );
    if (name === 'include' ? !arg.value.value : arg.value.value) kept = false;
  }
  return kept;
}

function assertNoArguments(field: FieldNode, where: string): void {
  if (field.arguments && field.arguments.length > 0)
    throw new OGMError(
      `Unsupported argument "${field.arguments[0].name.value}" on "${where}". ` +
        `selectionSet arguments are supported only on relationship fields (where, options), ` +
        `relationship aggregates (where, directed) and connection fields (where, sort).`,
    );
}

/**
 * v2.7.0 — the escaped output key of a selection inside a relationship
 * aggregate (its alias, validated, or its field name).
 */
function outputKey(node: SelectionNode): string {
  if (node.alias !== undefined && node.alias !== node.fieldName) {
    assertSafeIdentifier(node.alias, 'selection alias');
    return escapeIdentifier(node.alias);
  }
  return escapeIdentifier(node.fieldName);
}

/** v2.8.0 — the base64 alphabet, for {@link cursorExpr}. */
const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** v2.8.0 — base64 of `arrayconnection` (15 bytes: no padding). */
const CURSOR_PREFIX_B64 = 'YXJyYXljb25uZWN0aW9u';
/** v2.8.0 — the cursor of offset 0: base64 of `arrayconnection:0`. */
const FIRST_CURSOR = 'YXJyYXljb25uZWN0aW9uOjA=';

/**
 * v2.8.0 — a Cypher expression for upstream `@neo4j/graphql`'s connection
 * cursor of the integer offset `index`: `offsetToCursor(index)` from
 * `graphql-relay`, i.e. base64 of `arrayconnection:<index>`.
 *
 * Neo4j 5.x has no base64 function (APOC's is optional), so it is encoded
 * here: the 15-byte prefix is a constant, and the rest, `:` and the
 * decimal digits, is encoded three bytes at a time from the character
 * codes (`:` = 58, `0`–`9` = 48–57). Variables carry `depth` so nested
 * connections never shadow each other.
 */
function cursorExpr(index: string, depth: number): string {
  const [l, c, a, n, g] = ['l', 'c', 'a', 'n', 'g'].map(
    (v) => `__c${v}${depth}`,
  );
  const sym = (i: string) => `substring('${BASE64_ALPHABET}', ${i}, 1)`;
  return (
    `'${CURSOR_PREFIX_B64}' + head([${l} IN [[${c} IN split(':' + toString(${index}), '') | ` +
    `CASE ${c} WHEN ':' THEN 58 ELSE 48 + toInteger(${c}) END]] | ` +
    `reduce(${a} = '', ${n} IN [${g} IN range(0, size(${l}) - 1, 3) | ` +
    `[${l}[${g}] * 65536 + coalesce(${l}[${g} + 1], 0) * 256 + coalesce(${l}[${g} + 2], 0), size(${l}) - ${g}]] | ` +
    `${a} + ${sym(`${n}[0] / 262144`)} + ${sym(`${n}[0] / 4096 % 64`)} + ` +
    `CASE WHEN ${n}[1] > 1 THEN ${sym(`${n}[0] / 64 % 64`)} ELSE '=' END + ` +
    `CASE WHEN ${n}[1] > 2 THEN ${sym(`${n}[0] % 64`)} ELSE '=' END)])`
  );
}

/** First letter uppercased, as the generated type names spell fields. */
function pascal(fieldName: string): string {
  return fieldName.charAt(0).toUpperCase() + fieldName.slice(1);
}

/**
 * v2.7.0 — what an unsupported connection argument can be replaced with
 * (#25): the typed `select` equivalent, a relationship field to page, and
 * the pre-2.5.0 behaviour (the argument was ignored).
 */
function unsupportedConnectionArgumentHint(label: string): string {
  const rel = label.replace(/Connection$/, '');
  return (
    ` The typed select API takes the same connection arguments: ` +
    `select: { ${label}: { where: {...}, orderBy: [...], select: {...} } }. ` +
    `To page, select the relationship field instead: ${rel}(options: { offset, limit }). ` +
    `Before 2.5.0 the argument was ignored; remove it to keep that result.`
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
    // v2.7.0 — `directed` on a relationship aggregate (`postsAggregate`).
    // Whether the field IS an aggregate is known only when compiled
    // against its type; a real relationship rejects it there.
    if (
      name === 'directed' &&
      node.isRelationship &&
      label.endsWith(AGGREGATE_SUFFIX)
    ) {
      assertNoVariables(arg.value, `${label}(${name})`);
      if (arg.value.kind !== Kind.BOOLEAN)
        throw new OGMError(
          `Argument "directed" on selectionSet field "${label}" must be true or false.`,
        );
      node.directed = arg.value.value;
      continue;
    }
    if (!allowed || !allowed.has(name))
      throw new OGMError(
        `Unsupported argument "${name}" on selectionSet field "${label}". ` +
          `Supported: where and options (sort, limit, offset) on relationship fields, ` +
          `where and directed on relationship aggregates (<field>Aggregate), where and sort on connection fields.` +
          (node.isConnection ? unsupportedConnectionArgumentHint(label) : ''),
      );
    assertNoVariables(arg.value, `${label}(${name})`);
    const value = valueFromASTUntyped(arg.value);
    if (name === 'sort') {
      // v2.7.0 — the typed connection `orderBy` entries (#25). The shape
      // is checked now (so the `selectionSet` setter throws on a bad one);
      // fields are checked against the schema when compiled.
      normalizeConnectionOrderBy(value, label, 'sort');
      node.connectionSort = value;
      continue;
    }
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
 * v2.6.3 — a selected field its type does not declare (#23). Pre-2.6.3 —
 * and in 2.x default mode — a scalar-shaped one is projected as a raw
 * property (`.nmae`, null) and one with a sub-selection is left out of
 * the result without an error.
 */
export interface UnknownSelectedField {
  /** What the field was looked up on: a type name or an edge description. */
  owner: string;
  field: string;
  /** Selected with a sub-selection (dropped) rather than as a scalar (raw). */
  subSelection: boolean;
  /** Edge-properties field: projected from the relationship, not the node. */
  edge?: boolean;
  /**
   * `<rel>Aggregate` on a type with relationship `<rel>`: the supported
   * alternatives, appended to the message.
   */
  hint?: string;
  /**
   * v2.8.0 — what 2.x does with it, when not the default unknown-field
   * outcome (fields inside a connection's `pageInfo`).
   */
  outcome?: string;
  /**
   * v2.8.0 — the field is KNOWN but selected in the wrong shape (a scalar
   * with a sub-selection, a relationship without one): `expected` says
   * what the field is and how to select it, `outcome` what 2.x does.
   */
  shape?: { expected: string; outcome: string };
}

/** v2.8.0 — 2.x outcome of a selection the compiler drops. */
export const LEFT_OUT = '2.x leaves it out of the result';
/** v2.8.0 — 2.x outcome of a selection projected as a raw property. */
export const RAW_PROPERTY =
  '2.x projects it as a raw node property (null unless one is stored)';

/** v2.8.0 — whether a property holds a scalar / enum, not a node type. */
export function isScalarProperty(
  prop: PropertyDefinition,
  schema: SchemaMetadata,
): boolean {
  return (
    !schema.nodes.has(prop.type) &&
    !schema.interfaces?.has(prop.type) &&
    !schema.unions?.has(prop.type)
  );
}

/** v2.8.0 — `String`, `[String]` … as the schema declares a property. */
export function propertyTypeName(prop: PropertyDefinition): string {
  return prop.isArray ? `[${prop.type}]` : prop.type;
}

/**
 * v2.8.0 — the problems of a connection's `pageInfo` and `cursor`
 * selections (`node` and its strict-mode extra edge sets): `pageInfo`
 * without fields, a field `PageInfo` does not declare, a scalar given a
 * sub-selection. The compiler leaves each of them out of the result.
 *
 * @param typePrefix `<Parent><Field>`, so owners name the generated
 *   `<Parent><Field>Connection` / `<Parent><Field>Relationship` types
 */
export function connectionKeyIssues(
  node: SelectionNode,
  typePrefix: string,
  api: 'selectionSet' | 'select' = 'selectionSet',
): UnknownSelectedField[] {
  const out: UnknownSelectedField[] = [];
  const asScalar = (field: string) =>
    api === 'selectionSet'
      ? `select it as "${field}"`
      : `select it with \`${field}: true\``;
  for (const sel of node.pageInfo ?? []) {
    if (!sel.fields) {
      out.push({
        owner: `type "${typePrefix}Connection"`,
        field: 'pageInfo',
        subSelection: false,
        shape: {
          expected:
            api === 'selectionSet'
              ? 'is an object (PageInfo) and needs a sub-selection, e.g. "pageInfo { hasNextPage endCursor }"'
              : 'is an object (PageInfo): select it with `pageInfo: true` or `pageInfo: { select: { hasNextPage: true, … } }`',
          outcome: LEFT_OUT,
        },
      });
      continue;
    }
    for (const f of sel.fields) {
      const known = f.field === '__typename' || PAGE_INFO_FIELDS.has(f.field);
      if (!known)
        out.push({
          owner: 'type "PageInfo"',
          field: f.field,
          subSelection: !!f.subSelection,
          outcome: LEFT_OUT,
        });
      else if (f.subSelection)
        out.push({
          owner: 'type "PageInfo"',
          field: f.field,
          subSelection: true,
          shape: {
            expected: `is a scalar field (${f.field.startsWith('has') ? 'Boolean' : 'String'}) and takes no sub-selection: ${asScalar(f.field)}`,
            outcome: LEFT_OUT,
          },
        });
    }
  }
  for (const set of [node, ...(node.extraEdges ?? [])])
    for (const c of set.cursors ?? [])
      if (c.subSelection)
        out.push({
          owner: `type "${typePrefix}Relationship"`,
          field: 'cursor',
          subSelection: true,
          shape: {
            expected: `is a scalar field (String) and takes no sub-selection: ${asScalar('cursor')}`,
            outcome: LEFT_OUT,
          },
        });
  return out;
}

/** v2.6.3 — record an unknown field once per owner + field. */
function pushUnknown(
  out: UnknownSelectedField[],
  unknown: UnknownSelectedField,
): void {
  if (!out.some((u) => u.owner === unknown.owner && u.field === unknown.field))
    out.push(unknown);
}

/**
 * v2.6.3 — the hint for a `<rel>Aggregate` field reported unknown. Since
 * v2.7.0 a `<rel>Aggregate { … }` selection is supported (and known), so
 * only the scalar-shaped one — selected without aggregates — gets here.
 */
export function aggregateFieldHint(
  field: string,
  relationships: ReadonlyMap<string, unknown>,
): string | undefined {
  if (!field.endsWith('Aggregate')) return undefined;
  const rel = field.slice(0, -'Aggregate'.length);
  if (!relationships.has(rel)) return undefined;
  return (
    `"${field}" needs a selection of aggregates, ` +
    `e.g. "${field} { count }" (the aggregate of relationship "${rel}").`
  );
}

/**
 * v2.6.3 — report an unknown selected field: throw under `strict: true`,
 * warn once per owner + field otherwise (output unchanged).
 *
 * @param api `selectionSet` or `select`
 */
export function reportUnknownSelectedField(
  strictMode: StrictMode,
  api: 'selectionSet' | 'select',
  unknown: UnknownSelectedField,
): void {
  const { owner, field, subSelection, edge, hint, shape } = unknown;
  // v2.8.0 — a known field in the wrong shape (Bug 3).
  if (shape) {
    if (strictMode.strict)
      throw new OGMError(
        `Field "${field}" in ${api} on ${owner} ${shape.expected}.`,
      );
    strictMode.warn(
      api === 'selectionSet' ? 'selection-field-shape' : 'select-field-shape',
      `${owner}.${field}`,
      `The ${api} selects "${field}" on ${owner} in the wrong shape: it ${shape.expected}; ${shape.outcome}.`,
      `reject ${api} fields selected in the wrong shape`,
    );
    return;
  }
  const suffix = hint ? ` ${hint}` : '';
  if (strictMode.strict)
    throw new OGMError(
      `Unknown field "${field}" in ${api} on ${owner}.${suffix}`,
    );
  const outcome =
    unknown.outcome ??
    (subSelection
      ? LEFT_OUT
      : `2.x projects it as a raw ${edge ? 'relationship' : 'node'} property (null unless one is stored)`);
  strictMode.warn(
    api === 'selectionSet' ? 'selection-unknown-field' : 'select-unknown-field',
    `${owner}.${field}`,
    `The ${api} selects "${field}", which is not a field of ${owner}; ${outcome}.${suffix}`,
    `reject unknown ${api} fields`,
  );
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
  /** v2.6.0 — strict mode + warn-once log, shared per OGM. */
  private strictMode: StrictMode;

  constructor(
    private schema: SchemaMetadata,
    whereCompiler?: WhereCompiler,
    strictMode?: StrictMode,
  ) {
    this.whereCompiler = whereCompiler;
    this.strictMode = strictMode ?? lenientStrictMode();
  }

  /**
   * v2.6.0 — re-log (through the warn-once log) the strict-mode warnings
   * found when `parsed` was first parsed. Parsed selections are cached —
   * here and in `Model`'s cross-OGM cache — so a cache hit must still warn
   * on an OGM instance that has not seen the shape yet.
   */
  replayParseWarnings(parsed: SelectionNode[]): void {
    for (const w of parseWarnings.get(parsed) ?? [])
      this.strictMode.warn(w.code, w.detail, w.problem, w.fix);
  }

  /** Clear the parse cache. Useful in tests to prevent cross-test pollution. */
  clearCache(): void {
    this.parseCache.clear();
    this.unknownFieldsCache = new WeakMap();
  }

  /**
   * v2.6.3 — the unknown fields found in each parsed selection, per root
   * type (parsed selections are cached and reused, so the tree is walked
   * once per selection and type).
   */
  private unknownFieldsCache = new WeakMap<
    SelectionNode[],
    Map<string, UnknownSelectedField[]>
  >();

  /**
   * v2.6.3 — check every field name of a parsed selectionSet against the
   * schema (#23): root fields, nested relationship selections, connection
   * `node` and edge `properties` selections, and inline fragments (against
   * each fragment's type condition). Known: a property (`@cypher`
   * included), a relationship, `<rel>Connection` and `__typename`.
   *
   * An unknown field throws under `strict: true`; in 2.x default mode it
   * warns once (per OGM, type and field) and the compiled Cypher is
   * unchanged. Runs on every call, so a cached selection still warns on an
   * OGM that has not seen it.
   *
   * @param mutationResponse the selection is a mutation response's node
   *   selection: a root `info { … }` (the mutation counters) is allowed.
   */
  assertKnownFields(
    selection: SelectionNode[],
    rootDef: NodeDefinition,
    mutationResponse = false,
  ): void {
    const key = `${rootDef.typeName}\u0000${mutationResponse ? 'm' : ''}`;
    let byRoot = this.unknownFieldsCache.get(selection);
    let found = byRoot?.get(key);
    if (!found) {
      found = [];
      this.collectUnknownFields(selection, rootDef, found, mutationResponse, 0);
      if (!byRoot) {
        byRoot = new Map();
        this.unknownFieldsCache.set(selection, byRoot);
      }
      byRoot.set(key, found);
    }
    for (const unknown of found)
      reportUnknownSelectedField(this.strictMode, 'selectionSet', unknown);
  }

  /** Walk one selection level against `def` (see `assertKnownFields`). */
  private collectUnknownFields(
    selection: readonly SelectionNode[],
    def: NodeDefinition,
    out: UnknownSelectedField[],
    allowInfo: boolean,
    depth: number,
  ): void {
    // Selection trees are finite; the bound only guards a pathological one.
    if (depth > 50) return;
    for (const node of selection)
      for (const variant of [node, ...(node.typeVariants ?? [])])
        this.collectUnknownField(variant, def, out, allowInfo, depth);
  }

  private collectUnknownField(
    node: SelectionNode,
    def: NodeDefinition,
    out: UnknownSelectedField[],
    allowInfo: boolean,
    depth: number,
  ): void {
    if (
      allowInfo &&
      node.fieldName === 'info' &&
      !node.typeConditions &&
      !def.properties.has('info') &&
      !def.relationships.has('info')
    )
      return;
    // A field selected through inline fragments is a field of each
    // fragment's type condition (an interface-level field must exist on
    // the interface; a union condition accepts any member's field, as the
    // compiler does). Unknown condition types are not checked here.
    const owners: { def: NodeDefinition; field: string }[] = node.typeConditions
      ? node.typeConditions.flatMap((t) => {
          const d = resolveTargetDef(t, this.schema);
          return d
            ? [{ def: d, field: node.fieldByType?.[t] ?? node.fieldName }]
            : [];
        })
      : [{ def, field: node.fieldName }];
    for (const owner of owners) {
      const { field } = owner;
      if (field === '__typename') continue;
      const hasChildren = !node.isScalar;
      const prop = owner.def.properties.get(field);
      if (prop) {
        // v2.8.0 — a scalar given a sub-selection is left out of the result.
        if (hasChildren && isScalarProperty(prop, this.schema))
          pushUnknown(out, {
            owner: `type "${owner.def.typeName}"`,
            field,
            subSelection: true,
            shape: {
              expected: `is a scalar field (${propertyTypeName(prop)}) and takes no sub-selection: select it as "${field}"`,
              outcome: LEFT_OUT,
            },
          });
        continue;
      }
      if (node.isConnection && hasChildren) {
        const base = field.replace(/Connection$/, '');
        if (owner.def.relationships.has(base)) {
          for (const rel of this.relationshipsOf(owner.def, base))
            this.collectConnectionUnknowns(
              node,
              owner.def,
              base,
              rel,
              out,
              depth,
            );
          continue;
        }
      }
      if (owner.def.relationships.has(field)) {
        if (hasChildren && !node.isConnection)
          for (const rel of this.relationshipsOf(owner.def, field)) {
            const target = resolveTargetDef(rel.target, this.schema);
            if (target)
              this.collectUnknownFields(
                node.children ?? [],
                target,
                out,
                false,
                depth + 1,
              );
          }
        // v2.8.0 — a relationship without a sub-selection is projected
        // as a raw property (null).
        else if (!hasChildren)
          pushUnknown(out, {
            owner: `type "${owner.def.typeName}"`,
            field,
            subSelection: false,
            shape: {
              expected: `is a relationship to ${owner.def.relationships.get(field)!.target} and needs a sub-selection, e.g. "${field} { … }"`,
              outcome: RAW_PROPERTY,
            },
          });
        continue;
      }
      // A scalar-shaped `<rel>Connection` of a relationship is a known
      // name; v2.8.0 — selected without its sub-selection it is projected
      // as a raw property (null), so it is reported.
      if (
        field.endsWith('Connection') &&
        owner.def.relationships.has(field.replace(/Connection$/, ''))
      ) {
        pushUnknown(out, {
          owner: `type "${owner.def.typeName}"`,
          field,
          subSelection: false,
          shape: {
            expected: `is a connection and needs a sub-selection, e.g. "${field} { edges { node { … } } }"`,
            outcome: RAW_PROPERTY,
          },
        });
        continue;
      }
      // v2.7.0 — `<rel>Aggregate { … }` of a relationship is a known field
      // (compiled by `compileAggregate`, which validates its own
      // sub-selection). Only the scalar-shaped one, which has no meaning,
      // stays unknown.
      if (hasChildren && this.isAggregateField(owner.def, field)) continue;
      pushUnknown(out, {
        owner: `type "${owner.def.typeName}"`,
        field,
        subSelection: hasChildren,
        hint: aggregateFieldHint(field, owner.def.relationships),
      });
    }
  }

  /**
   * The relationship definitions `field` stands for on `def`: a union's
   * merged definition carries one member's, but the compiler projects
   * each member's own (`compileUnionRelationshipField`).
   */
  private relationshipsOf(
    def: NodeDefinition,
    field: string,
  ): RelationshipDefinition[] {
    const members = this.schema.unions?.get(def.typeName);
    if (members && members.length > 0) {
      const rels: RelationshipDefinition[] = [];
      for (const m of members) {
        const rel = this.schema.nodes.get(m)?.relationships.get(field);
        if (rel) rels.push(rel);
      }
      if (rels.length > 0) return rels;
    }
    const rel = def.relationships.get(field);
    return rel ? [rel] : [];
  }

  /** Check a connection's `node` and edge `properties` selections. */
  private collectConnectionUnknowns(
    node: SelectionNode,
    owner: NodeDefinition,
    base: string,
    rel: RelationshipDefinition,
    out: UnknownSelectedField[],
    depth: number,
  ): void {
    const sets = [node, ...(node.extraEdges ?? [])];
    const target = resolveTargetDef(rel.target, this.schema);
    if (target)
      for (const set of sets)
        for (const children of [
          set.children ?? [],
          ...(set.extraNodes ?? []).map((e) => e.children),
        ])
          this.collectUnknownFields(children, target, out, false, depth + 1);
    this.collectPageInfoAndCursorIssues(node, owner, base, out);
    const props = rel.properties
      ? this.schema.relationshipProperties.get(rel.properties)
      : undefined;
    const edgeOwner = props
      ? `relationship properties type "${props.typeName}"`
      : `the "${base}" relationship of type "${owner.typeName}" (no @relationshipProperties)`;
    for (const set of sets)
      for (const children of [
        set.edgeChildren ?? [],
        ...(set.extraProperties ?? []).map((e) => e.children),
      ])
        for (const child of children) {
          const edgeProp = props?.properties.get(child.fieldName);
          // v2.8.0 — an edge property given a sub-selection is left out.
          if (edgeProp && !child.isScalar)
            pushUnknown(out, {
              owner: edgeOwner,
              field: child.fieldName,
              subSelection: true,
              edge: true,
              shape: {
                expected: `is a scalar field (${propertyTypeName(edgeProp)}) and takes no sub-selection: select it as "${child.fieldName}"`,
                outcome: LEFT_OUT,
              },
            });
          else if (child.fieldName !== '__typename' && !edgeProp)
            pushUnknown(out, {
              owner: edgeOwner,
              field: child.fieldName,
              subSelection: !child.isScalar,
              edge: true,
            });
        }
  }

  /**
   * v2.8.0 — check a connection's `pageInfo` and `cursor` selections:
   * `pageInfo` without a sub-selection, a field `PageInfo` does not declare
   * and a sub-selection on a scalar are reported (the compiler leaves them
   * out of the result).
   */
  private collectPageInfoAndCursorIssues(
    node: SelectionNode,
    owner: NodeDefinition,
    base: string,
    out: UnknownSelectedField[],
  ): void {
    for (const issue of connectionKeyIssues(
      node,
      `${owner.typeName}${pascal(base)}`,
    ))
      pushUnknown(out, issue);
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
            params,
            paramCounter,
            policyContext,
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
          // v2.14.0 — strict item 24: a list field projects the whole list.
          const asList = cypherFieldAsList(
            this.strictMode,
            nodeDef.typeName,
            node.fieldName,
            propDef,
          );
          if (cypherScope) {
            const alias = cypherScope.register(
              node.fieldName,
              propDef,
              undefined,
              asList,
            );
            parts.push(`${escapeIdentifier(key)}: ${alias}`);
          } else
            parts.push(
              `${escapeIdentifier(key)}: ${buildInlineCypherFieldExpr(
                propDef.cypherStatement,
                nodeVar,
                `${nodeDef.typeName}.${node.fieldName}`,
                asList
                  ? (propDef.cypherColumnName ?? node.fieldName)
                  : undefined,
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

      // v2.6.0 — strict: one key selected with different arguments by
      // fragments on disjoint types, projected per concrete type.
      if (node.typeVariants && node.typeVariants.length > 0) {
        const variantCypher = this.compileTypeVariants(
          node,
          nodeVar,
          maxDepth,
          currentDepth,
          params,
          paramCounter,
          policyContext,
        );
        if (variantCypher) {
          parts.push(`${key}: ${variantCypher}`);
          continue;
        }
      }

      // v2.5.3 — a relationship / connection field selected through an
      // inline fragment on an abstract type that doesn't declare it.
      // (Union relationship fields keep their per-member CASE below.)
      if (
        isAbstract &&
        node.typeConditions &&
        (node.isConnection || !(unionMembers && unionMembers.length > 0)) &&
        !nodeDef.relationships.has(
          node.isConnection
            ? node.fieldName.replace(/Connection$/, '')
            : node.fieldName,
        )
      ) {
        const fragmentCypher = this.compileFragmentRelationship(
          node,
          nodeVar,
          maxDepth,
          currentDepth,
          params,
          paramCounter,
          policyContext,
        );
        if (fragmentCypher) {
          parts.push(`${key}: ${fragmentCypher}`);
          continue;
        }
      }

      // v2.7.0 — `<rel>Aggregate { count node { … } edge { … } }`. Pre-2.7.0
      // it matched no relationship and was silently dropped (issue #23).
      if (
        node.isRelationship &&
        this.isAggregateField(nodeDef, node.fieldName)
      ) {
        const aggregateCypher =
          unionMembers && unionMembers.length > 0
            ? this.compileUnionAggregate(
                node,
                nodeVar,
                unionMembers,
                maxDepth,
                currentDepth,
                params,
                paramCounter,
                policyContext,
              )
            : this.compileAggregate(
                node,
                nodeVar,
                nodeDef,
                maxDepth,
                currentDepth,
                params,
                paramCounter,
                policyContext,
              );
        if (aggregateCypher) parts.push(`${key}: ${aggregateCypher}`);
        continue;
      }

      if (node.isConnection) {
        const connectionCypher =
          unionMembers && unionMembers.length > 0
            ? this.compileUnionConnection(
                node,
                nodeVar,
                nodeDef,
                unionMembers,
                maxDepth,
                currentDepth,
                params,
                paramCounter,
                policyContext,
              )
            : this.compileConnection(
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
            nodeDef.typeName,
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
   *
   * v2.5.4 — under a policy context, each `@cypher` branch is also guarded
   * by that member's own `read` clause (`WHEN n:B AND <B read> THEN …`),
   * so a member's statement only projects for a node that passes the
   * member's policy. The node filter (`compileTargetPolicyClause`) already
   * requires every carried member's clause; this is defense in depth.
   * Without a policy context the branches are unchanged.
   */
  private compileFragmentScalar(
    node: SelectionNode,
    key: string,
    nodeVar: string,
    nodeDef: NodeDefinition,
    cypherScope: CypherFieldScope | null,
    params?: Record<string, unknown>,
    paramCounter?: { count: number },
    policyContext: PolicyContextBundle | null = null,
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
      if (prop.isCypher && prop.cypherStatement) {
        // v2.14.0 — strict item 24 (see the main projection path).
        const asList = cypherFieldAsList(
          this.strictMode,
          def.typeName,
          field,
          prop,
        );
        expr = cypherScope
          ? cypherScope.register(field, prop, nodeLabelList(def), asList)
          : buildInlineCypherFieldExpr(
              prop.cypherStatement,
              nodeVar,
              `${def.typeName}.${field}`,
              asList ? (prop.cypherColumnName ?? field) : undefined,
            );
      } else expr = `${nodeVar}.${escapeIdentifier(field)}`;
      const guard =
        prop.isCypher && prop.cypherStatement
          ? this.memberReadGuard(
              def,
              nodeVar,
              params,
              paramCounter,
              policyContext,
            )
          : '';
      return `WHEN ${nodeVar}:${nodeLabelExpr(def)}${guard} THEN ${expr}`;
    });
    return `${escapeIdentifier(key)}: CASE ${branches.join(' ')} END`;
  }

  /**
   * ` AND <member read clause>` guarding a fragment `@cypher` branch
   * (v2.5.4); `''` without a policy context, when the member has no read
   * clause, or when that clause needs `@cypher` preludes a projection
   * cannot host (the node filter still enforces it).
   */
  private memberReadGuard(
    def: NodeDefinition,
    nodeVar: string,
    params: Record<string, unknown> | undefined,
    paramCounter: { count: number } | undefined,
    policyContext: PolicyContextBundle | null,
  ): string {
    if (!policyContext || !this.whereCompiler || !params || !paramCounter)
      return '';
    const clause = this.whereCompiler.compileTargetPolicyClause(
      def.typeName,
      nodeVar,
      'read',
      policyContext,
      paramCounter,
    );
    if (clause.cypher === null || clause.preludes.length > 0) return '';
    mergeParams(params, clause.params);
    return ` AND ${clause.cypher}`;
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
      this.replayParseWarnings(cached);
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

    const ctx: ParseContext = {
      strict: this.strictMode.strict,
      warnings: [],
      possibleTypes: (typeName) => this.possibleTypes(typeName),
    };
    const result = this.convertSelectionSet(
      dummyField.selectionSet,
      undefined,
      ctx,
    );
    if (ctx.warnings.length > 0) {
      parseWarnings.set(result, ctx.warnings);
      this.replayParseWarnings(result);
    }

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
   * v2.6.0 — the concrete types a fragment on `typeName` can apply to (see
   * `ParseContext.possibleTypes`). Unknown names stand for themselves.
   */
  private possibleTypes(typeName: string): readonly string[] {
    if (this.schema.nodes.has(typeName)) return [typeName];
    const iface = this.schema.interfaces?.get(typeName);
    if (iface) return iface.implementedBy;
    return this.schema.unions?.get(typeName) ?? [typeName];
  }

  /**
   * Convert a GraphQL SelectionSetNode into SelectionNode[].
   */
  private convertSelectionSet(
    selectionSet: SelectionSetNode,
    /** Type condition of the enclosing inline fragment, if any (v2.4.8). */
    typeCondition: string | undefined,
    ctx: ParseContext,
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
        if (
          !keptByDirectives(
            fragment.directives,
            `... on ${condition ?? '(inline fragment)'}`,
            ctx,
          )
        )
          continue;
        if (fragment.selectionSet)
          for (const merged of this.convertSelectionSet(
            fragment.selectionSet,
            condition,
            ctx,
          ))
            mergeSelection(nodes, seen, merged, ctx);

        continue;
      }

      if (sel.kind !== Kind.FIELD) continue;
      const field = sel as FieldNode;
      const fieldName = field.name.value;
      if (
        !keptByDirectives(
          field.directives,
          field.alias?.value ?? fieldName,
          ctx,
        )
      )
        continue;
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
          this.parseConnectionChildren(field.selectionSet, node, ctx);
        else
          node.children = this.convertSelectionSet(
            field.selectionSet,
            undefined,
            ctx,
          );

      mergeSelection(nodes, seen, node, ctx);
    }

    return nodes;
  }

  /**
   * Parse the children of a connection field, extracting node and edge children.
   */
  private parseConnectionChildren(
    selectionSet: SelectionSetNode,
    parentNode: SelectionNode,
    ctx: ParseContext,
  ): void {
    let selectsEdges = false;
    // v2.6.0 — the response key of the first `edges`, and (strict) the edge
    // sets of `edges` selected under other keys.
    let firstEdgesKey: string | undefined;
    const extras = new Map<string, SelectionNode>();
    // v2.6.0 — the first `node` / `properties` key of each edge set.
    const firstKeys = new Map<
      SelectionNode,
      { node?: string; properties?: string }
    >();
    const connectionName = parentNode.alias ?? parentNode.fieldName;
    /**
     * Where a `node` / `properties` selection under `key` goes: the edge
     * set's own (first) key, or — strict, another key — its own entry.
     */
    const edgeKeyTarget = (
      set: SelectionNode,
      which: 'node' | 'properties',
      key: string,
    ): EdgeKeySelection | null => {
      const firsts = firstKeys.get(set) ?? {};
      firstKeys.set(set, firsts);
      firsts[which] ??= key;
      if (firsts[which] === key) return null;
      if (!ctx.strict) {
        warnAliasedEdgeKey(ctx, connectionName, which, firsts[which]!, key);
        return null;
      }
      const prop = which === 'node' ? 'extraNodes' : 'extraProperties';
      const list = (set[prop] ??= []);
      let entry = list.find((e) => e.key === key);
      if (!entry) {
        assertSafeIdentifier(key, 'selection alias');
        entry = { key, children: [] };
        list.push(entry);
      }
      return entry;
    };
    for (const sel of selectionSet.selections) {
      if (sel.kind !== Kind.FIELD) continue;
      const field = sel as FieldNode;
      assertNoArguments(field, `${parentNode.fieldName}.${field.name.value}`);
      if (
        !keptByDirectives(
          field.directives,
          `${parentNode.fieldName}.${field.name.value}`,
          ctx,
        )
      )
        continue;

      if (field.name.value === 'totalCount') {
        parentNode.totalCount = true;
        this.recordConnectionAlias(parentNode, 'totalCount', field);
      }
      // v2.8.0 — `pageInfo { … }`; pre-2.8.0 it was silently dropped.
      if (field.name.value === 'pageInfo') {
        const key = field.alias?.value ?? 'pageInfo';
        if (key !== 'pageInfo') assertSafeIdentifier(key, 'selection alias');
        parentNode.pageInfo = mergePageInfo(parentNode.pageInfo, [
          {
            key,
            ...(field.selectionSet
              ? {
                  fields: this.parseConnectionKeys(
                    field.selectionSet,
                    `${parentNode.fieldName}.pageInfo`,
                    ctx,
                  ),
                }
              : {}),
          },
        ]);
      }
      let target = parentNode;
      if (field.name.value === 'edges') {
        selectsEdges = true;
        const edgesKey = field.alias?.value ?? 'edges';
        firstEdgesKey ??= edgesKey;
        if (edgesKey !== firstEdgesKey)
          if (ctx.strict) {
            let extra = extras.get(edgesKey);
            if (!extra) {
              extra = {
                fieldName: parentNode.fieldName,
                isScalar: false,
                isRelationship: false,
                isConnection: true,
              };
              extras.set(edgesKey, extra);
            }
            target = extra;
          } else
            warnAliasedEdges(
              ctx,
              parentNode.alias ?? parentNode.fieldName,
              firstEdgesKey,
              edgesKey,
            );
        this.recordConnectionAlias(target, 'edges', field);
      }

      if (field.name.value === 'edges' && field.selectionSet)
        for (const edgeSel of field.selectionSet.selections) {
          if (edgeSel.kind !== Kind.FIELD) continue;
          const edgeField = edgeSel as FieldNode;
          assertNoArguments(
            edgeField,
            `${parentNode.fieldName}.edges.${edgeField.name.value}`,
          );
          if (
            !keptByDirectives(
              edgeField.directives,
              `${parentNode.fieldName}.edges.${edgeField.name.value}`,
              ctx,
            )
          )
            continue;

          // v2.8.0 — `cursor`; pre-2.8.0 it was silently dropped.
          if (edgeField.name.value === 'cursor') {
            const key = edgeField.alias?.value ?? 'cursor';
            if (key !== 'cursor') assertSafeIdentifier(key, 'selection alias');
            target.cursors = mergeKeySelections(target.cursors, [
              {
                key,
                field: 'cursor',
                ...(edgeField.selectionSet ? { subSelection: true } : {}),
              },
            ]);
          }

          // v2.5.3 — a repeated `edges { node { … } }` merges its
          // sub-selections; pre-2.5.3 the last one replaced the others.
          if (edgeField.name.value === 'node' && edgeField.selectionSet) {
            const extra = edgeKeyTarget(
              target,
              'node',
              edgeField.alias?.value ?? 'node',
            );
            const parsed = this.convertSelectionSet(
              edgeField.selectionSet,
              undefined,
              ctx,
            );
            if (extra)
              extra.children = mergeSelectionLists(extra.children, parsed, ctx);
            else {
              this.recordConnectionAlias(target, 'node', edgeField);
              target.children = mergeSelectionLists(
                target.children,
                parsed,
                ctx,
              );
            }
          }

          if (edgeField.name.value === 'properties' && edgeField.selectionSet) {
            const extra = edgeKeyTarget(
              target,
              'properties',
              edgeField.alias?.value ?? 'properties',
            );
            const parsed = this.convertSelectionSet(
              edgeField.selectionSet,
              undefined,
              ctx,
            );
            if (extra)
              extra.children = mergeSelectionLists(extra.children, parsed, ctx);
            else {
              this.recordConnectionAlias(target, 'properties', edgeField);
              target.edgeChildren = mergeSelectionLists(
                target.edgeChildren,
                parsed,
                ctx,
              );
            }
          }
        }
    }
    if (parentNode.totalCount && !selectsEdges)
      parentNode.totalCountOnly = true;
    if (extras.size > 0) parentNode.extraEdges = [...extras.values()];
  }

  /**
   * Keep the selectionSet alias of a connection key (v2.5.3). The first
   * alias given for a key wins.
   */
  private recordConnectionAlias(
    node: SelectionNode,
    key: 'totalCount' | 'edges' | 'node' | 'properties',
    field: FieldNode,
  ): void {
    const alias = field.alias?.value;
    if (alias === undefined || alias === key) return;
    assertSafeIdentifier(alias, 'selection alias');
    node.connectionAliases ??= {};
    node.connectionAliases[key] ??= alias;
  }

  /**
   * v2.8.0 — the fields of a `pageInfo { … }` selection (inline fragments
   * flattened), each with its response key. Whether a field exists is
   * checked by `assertKnownFields`, not here.
   */
  private parseConnectionKeys(
    selectionSet: SelectionSetNode,
    where: string,
    ctx: ParseContext,
  ): ConnectionKeySelection[] {
    let out: ConnectionKeySelection[] = [];
    for (const sel of selectionSet.selections) {
      if (sel.kind === Kind.INLINE_FRAGMENT) {
        if (keptByDirectives(sel.directives, `${where} (inline fragment)`, ctx))
          out =
            mergeKeySelections(
              out,
              this.parseConnectionKeys(sel.selectionSet, where, ctx),
            ) ?? out;
        continue;
      }
      if (sel.kind !== Kind.FIELD) continue;
      const name = sel.name.value;
      assertNoArguments(sel, `${where}.${name}`);
      if (!keptByDirectives(sel.directives, `${where}.${name}`, ctx)) continue;
      const key = sel.alias?.value ?? name;
      if (key !== name) assertSafeIdentifier(key, 'selection alias');
      out =
        mergeKeySelections(out, [
          {
            key,
            field: name,
            ...(sel.selectionSet ? { subSelection: true } : {}),
          },
        ]) ?? out;
    }
    return out;
  }

  /**
   * Compile a relationship or connection field selected through inline
   * fragments on an abstract type that does not declare it (v2.5.3):
   * `CASE WHEN n:D THEN <D's projection> … END`, each branch compiled
   * against the implementer — with its arguments and the target type's
   * read policy. Pre-2.5.3 the field was looked up on the abstract type,
   * not found, and silently dropped together with its arguments.
   *
   * Returns `null` (unchanged behaviour) when no fragment type declares it.
   */
  private compileFragmentRelationship(
    node: SelectionNode,
    nodeVar: string,
    maxDepth: number,
    currentDepth: number,
    params?: Record<string, unknown>,
    paramCounter?: { count: number },
    policyContext: PolicyContextBundle | null = null,
  ): string | null {
    const { branches, singular } = this.fragmentRelationshipBranches(
      node,
      node.typeConditions ?? [],
      nodeVar,
      maxDepth,
      currentDepth,
      params,
      paramCounter,
      policyContext,
    );
    if (branches.length === 0) return null;
    return `CASE ${branches.join(' ')} ELSE ${singular ? 'null' : '[]'} END`;
  }

  /**
   * v2.6.0 — strict: a relationship / connection key with per-type
   * variants (`SelectionNode.typeVariants`): one `CASE` whose branches
   * compile each variant, with its own arguments and the target's read
   * policy, against the concrete types its fragments apply to.
   */
  private compileTypeVariants(
    node: SelectionNode,
    nodeVar: string,
    maxDepth: number,
    currentDepth: number,
    params?: Record<string, unknown>,
    paramCounter?: { count: number },
    policyContext: PolicyContextBundle | null = null,
  ): string | null {
    const branches: string[] = [];
    let singular = false;
    for (const variant of [node, ...(node.typeVariants ?? [])]) {
      const types = [
        ...new Set(
          (variant.typeConditions ?? []).flatMap((t) => this.possibleTypes(t)),
        ),
      ];
      const part = this.fragmentRelationshipBranches(
        variant,
        types,
        nodeVar,
        maxDepth,
        currentDepth,
        params,
        paramCounter,
        policyContext,
      );
      branches.push(...part.branches);
      singular ||= part.singular;
    }
    if (branches.length === 0) return null;
    return `CASE ${branches.join(' ')} ELSE ${singular ? 'null' : '[]'} END`;
  }

  /** `WHEN n:T THEN <projection>` per type of `typeNames` declaring the field. */
  private fragmentRelationshipBranches(
    node: SelectionNode,
    typeNames: readonly string[],
    nodeVar: string,
    maxDepth: number,
    currentDepth: number,
    params?: Record<string, unknown>,
    paramCounter?: { count: number },
    policyContext: PolicyContextBundle | null = null,
  ): { branches: string[]; singular: boolean } {
    const relField = node.isConnection
      ? node.fieldName.replace(/Connection$/, '')
      : node.fieldName;
    const branches: string[] = [];
    let singular = node.isConnection;
    for (const typeName of typeNames) {
      const def = this.schema.nodes.get(typeName);
      // v2.7.0 — a relationship aggregate selected through a fragment.
      if (
        def &&
        node.isRelationship &&
        this.isAggregateField(def, node.fieldName)
      ) {
        singular = true;
        const expr = this.compileAggregate(
          node,
          nodeVar,
          def,
          maxDepth,
          currentDepth,
          params,
          paramCounter,
          policyContext,
        );
        if (expr)
          branches.push(`WHEN ${nodeVar}:${nodeLabelExpr(def)} THEN ${expr}`);
        continue;
      }
      const relDef = def?.relationships.get(relField);
      if (!def || !relDef) continue;
      if (!relDef.isArray) singular = true;
      const expr = node.isConnection
        ? this.compileConnection(
            node,
            nodeVar,
            def,
            maxDepth,
            currentDepth,
            params,
            paramCounter,
            policyContext,
          )
        : this.compileRelationship(
            node,
            nodeVar,
            def,
            maxDepth,
            currentDepth,
            params,
            paramCounter,
            policyContext,
          );
      if (expr)
        branches.push(`WHEN ${nodeVar}:${nodeLabelExpr(def)} THEN ${expr}`);
    }
    return { branches, singular };
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
    if (this.beyondMaxDepth(node, currentDepth, maxDepth)) return null;

    const relDef = parentDef.relationships.get(node.fieldName);
    if (!relDef) return null;
    if (node.directed !== undefined)
      throw new OGMError(
        `Unsupported argument "directed" on selectionSet field "${node.fieldName}": ` +
          `only relationship aggregates (<field>Aggregate) accept it.`,
      );

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
   * vNEXT — strict item 33: whether a relationship / connection /
   * aggregate selection at `currentDepth` lies beyond `maxDepth`. 2.x
   * leaves such a selection out of the result (warning once); strict mode
   * throws instead of silently truncating the result.
   */
  private beyondMaxDepth(
    node: SelectionNode,
    currentDepth: number,
    maxDepth: number,
  ): boolean {
    if (currentDepth < maxDepth) return false;
    const field = node.alias ?? node.fieldName;
    if (this.strictMode.strict)
      throw new OGMError(
        `Selection "${field}" is nested deeper than the maximum selection depth (${maxDepth}). ` +
          `Select fewer levels, or raise the model's \`maxDepth\`.`,
      );
    this.strictMode.warn(
      'selection-max-depth',
      `${maxDepth}\u0000${field}`,
      `Selection "${field}" is nested deeper than the maximum selection depth (${maxDepth}); 2.x leaves it out of the result.`,
      'reject selections nested deeper than the maximum depth',
    );
    return true;
  }

  /**
   * v2.7.0 — whether `fieldName` is a relationship aggregate of `def`
   * (`postsAggregate` for a relationship `posts`). A field or relationship
   * actually NAMED `postsAggregate` keeps its own meaning.
   */
  private isAggregateField(def: NodeDefinition, fieldName: string): boolean {
    if (!fieldName.endsWith(AGGREGATE_SUFFIX)) return false;
    if (def.relationships.has(fieldName) || def.properties.has(fieldName))
      return false;
    return def.relationships.has(fieldName.slice(0, -AGGREGATE_SUFFIX.length));
  }

  /**
   * v2.7.0 — a relationship aggregate selected on a UNION type (not
   * through a fragment): one `CASE` branch per member that declares the
   * relationship (members selected by fragments when there are any),
   * `null` for the others.
   */
  private compileUnionAggregate(
    node: SelectionNode,
    nodeVar: string,
    unionMembers: string[],
    maxDepth: number,
    currentDepth: number,
    params?: Record<string, unknown>,
    paramCounter?: { count: number },
    policyContext: PolicyContextBundle | null = null,
  ): string | null {
    const members = node.typeConditions
      ? [
          ...new Set(node.typeConditions.flatMap((t) => this.possibleTypes(t))),
        ].filter((m) => unionMembers.includes(m))
      : unionMembers;
    const { branches } = this.fragmentRelationshipBranches(
      node,
      members,
      nodeVar,
      maxDepth,
      currentDepth,
      params,
      paramCounter,
      policyContext,
    );
    if (branches.length === 0) return null;
    return `CASE ${branches.join(' ')} ELSE null END`;
  }

  /**
   * v2.7.0 — compile a relationship aggregate selection,
   * `postsAggregate(where: …, directed: …) { count node { title { longest } }
   * edge { weight { sum } } }`, with upstream `@neo4j/graphql` 5.x shape and
   * semantics (see `relationship-aggregate.ts`).
   *
   * Every aggregate reads the same filtered pattern a nested selection of
   * the relationship would: `where` through the `WhereCompiler` against the
   * target type, AND the target type's `read` policy (a per-member clause
   * for an interface / union target) and, under strict mode, the member
   * restriction of an abstract target — so a node the context cannot read
   * never changes `count`, `min`, `max` or any other aggregate, and an edge
   * aggregate only measures edges to readable targets. Everything is an
   * expression (`COUNT { }`, `reduce` over a pattern comprehension), valid
   * at any depth on Neo4j 5.x: no aggregating function, no `CALL`.
   */
  private compileAggregate(
    node: SelectionNode,
    parentVar: string,
    parentDef: NodeDefinition,
    maxDepth: number,
    currentDepth: number,
    params?: Record<string, unknown>,
    paramCounter?: { count: number },
    policyContext: PolicyContextBundle | null = null,
  ): string | null {
    if (this.beyondMaxDepth(node, currentDepth, maxDepth)) return null;
    const label = node.fieldName;
    const relDef = parentDef.relationships.get(
      label.slice(0, -AGGREGATE_SUFFIX.length),
    );
    if (!relDef) return null;
    const targetDef = resolveTargetDef(relDef.target, this.schema);
    if (!targetDef) return null;
    if (node.limit !== undefined || node.offset !== undefined || node.orderBy)
      throw new OGMError(
        `options (sort, limit, offset) are not supported on relationship aggregate "${label}"; ` +
          `it takes where and directed.`,
      );

    const childVar = `n${currentDepth}`;
    const edgeVar = `e${currentDepth}`;
    const pattern = buildRelPattern({
      sourceVar: parentVar,
      relDef,
      targetVar: childVar,
      edgeVar,
      targetLabel: 'auto',
      schema: this.schema,
      undirected: node.directed === false,
    });
    const where = this.compileNestedWhere({
      node,
      childVar,
      targetDef,
      params,
      paramCounter,
      policyContext,
      contextLabel: `relationship aggregate "${label}"`,
      userWhere: node.relationshipWhere,
    });
    const filtered = `${pattern}${where}`;
    const typeName = `${parentDef.typeName}${relDef.target}${pascal(relDef.fieldName)}`;
    const isUnionTarget = !!this.schema.unions?.get(relDef.target)?.length;

    const parts: string[] = [];
    for (const child of node.children ?? []) {
      const key = outputKey(child);
      const field = child.fieldName;
      if (child.isScalar && field === 'count') {
        parts.push(`${key}: COUNT { ${filtered} }`);
        continue;
      }
      if (child.isScalar && field === '__typename') {
        parts.push(`${key}: '${typeName}AggregationSelection'`);
        continue;
      }
      if (field === 'node' || field === 'edge') {
        if (child.isScalar)
          throw new OGMError(
            `"${field}" on relationship aggregate "${label}" needs a selection of fields.`,
          );
        let props: Map<string, PropertyDefinition>;
        if (field === 'node') {
          if (isUnionTarget)
            throw new OGMError(
              `Relationship aggregate "${label}" targets the union ${relDef.target}, which has no node aggregates; ` +
                `select count or edge.`,
            );
          props = targetDef.properties;
        } else {
          const propsDef = relDef.properties
            ? this.schema.relationshipProperties.get(relDef.properties)
            : undefined;
          if (!propsDef)
            throw new OGMError(
              `Relationship aggregate "${label}" has no edge aggregates: ` +
                `"${relDef.fieldName}" has no @relationshipProperties.`,
            );
          props = propsDef.properties;
        }
        parts.push(
          `${key}: ${this.compileAggregateFields(
            child,
            props,
            field === 'node' ? childVar : edgeVar,
            filtered,
            `${typeName}${field === 'node' ? 'Node' : 'Edge'}AggregateSelection`,
            `${label}.${field}`,
            currentDepth,
          )}`,
        );
        continue;
      }
      throw new OGMError(
        `Unknown field "${field}" on relationship aggregate "${label}" of ${parentDef.typeName}. ` +
          `Select count, node { … }${relDef.properties ? ' or edge { … }' : ''}.`,
      );
    }
    if (parts.length === 0)
      throw new OGMError(
        `Relationship aggregate "${label}" selects nothing; select count, node { … } or edge { … }.`,
      );
    return `{ ${parts.join(', ')} }`;
  }

  /**
   * v2.7.0 — the `node { … }` / `edge { … }` map of a relationship
   * aggregate: one `{ shortest, longest, min, max, average, sum }` map per
   * selected field, over the non-null values of `<var>.<field>` along the
   * filtered pattern.
   */
  private compileAggregateFields(
    selection: SelectionNode,
    props: Map<string, PropertyDefinition>,
    varName: string,
    filtered: string,
    typeName: string,
    where: string,
    depth: number,
  ): string {
    const parts: string[] = [];
    for (const field of selection.children ?? []) {
      const key = outputKey(field);
      if (field.isScalar && field.fieldName === '__typename') {
        parts.push(`${key}: '${typeName}'`);
        continue;
      }
      const prop = props.get(field.fieldName);
      const kind = prop ? aggregateKind(prop) : null;
      if (!prop || !kind)
        throw new OGMError(
          prop
            ? `Field "${field.fieldName}" (${prop.isArray ? `[${prop.type}]` : prop.type}${prop.isCypher ? ', @cypher' : ''}) on ${where} has no aggregates` +
                (prop.isArray
                  ? ': list fields are not aggregated. (Its generated aggregate member is deprecated and goes in 3.0.)'
                  : '.')
            : `Unknown field "${field.fieldName}" on ${where}.`,
        );
      if (field.isScalar || !field.children || field.children.length === 0)
        throw new OGMError(
          `"${field.fieldName}" on ${where} needs a selection of aggregates.`,
        );
      const typenameKeys: string[] = [];
      const entries: [string, string][] = [];
      for (const op of field.children) {
        if (!op.isScalar)
          throw new OGMError(
            `Aggregate "${op.fieldName}" on ${where}.${field.fieldName} takes no selection.`,
          );
        if (op.fieldName === '__typename') {
          typenameKeys.push(outputKey(op));
          continue;
        }
        assertAggregateOp(kind, op.fieldName, `${where}.${field.fieldName}`);
        entries.push([outputKey(op), op.fieldName]);
      }
      parts.push(
        `${key}: ${fieldAggregateMap(
          kind,
          `[${filtered} | ${propertyRef(varName, prop)}]`,
          entries,
          aggregateSelectionTypeName(prop),
          typenameKeys,
          depth,
        )}`,
      );
    }
    return `{ ${parts.join(', ')} }`;
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
    // v2.5.3 — a list slice bound must fit in 32 bits (and a JS number
    // past 2^63 overflows the driver's Integer). No list is that long, so
    // clamping keeps the result; pre-2.5.3 the query failed.
    const INT32_MAX = 2_147_483_647;
    const start = Math.min(node.offset ?? 0, INT32_MAX);
    const startRef = node.offset !== undefined ? bind(start) : '';
    const endRef =
      node.limit !== undefined
        ? bind(Math.min(start + node.limit, INT32_MAX))
        : '';
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
    unionName: string,
    unionMembers: string[],
    maxDepth: number,
    currentDepth: number,
    params?: Record<string, unknown>,
    paramCounter?: { count: number },
    policyContext: PolicyContextBundle | null = null,
  ): string | null {
    if (this.beyondMaxDepth(node, currentDepth, maxDepth)) return null;

    // v2.5.0 — fields on union members don't apply per-field arguments;
    // refuse them instead of dropping them.
    if (node.hasArguments)
      throw new OGMError(
        `selectionSet arguments on "${node.fieldName}" are not supported when selected through a union type.`,
      );

    // v2.8.0 — the typed select `where` / `orderBy` of a relationship under
    // a union parent. Pre-2.8.0 (and in 2.x default mode) neither reached
    // the per-member branches: every related node came back, unsorted.
    // Honouring them changes rows, so 2.x warns; strict applies them per
    // member (the `where` AND the target's `read` policy).
    const strict = this.strictMode.strict;
    const hasWhere =
      !!node.relationshipWhere &&
      Object.keys(node.relationshipWhere).length > 0;
    const hasOrderBy = !!node.orderBy && node.orderBy.length > 0;
    if (!strict) {
      if (hasWhere)
        this.strictMode.warn(
          'select-union-where',
          `${unionName}.${node.fieldName}`,
          `The select \`where\` on "${node.fieldName}", selected under the union "${unionName}", ` +
            `is ignored in 2.x: every related node is returned.`,
          "apply it to each member (with the target type's read policy)",
        );
      if (hasOrderBy)
        this.strictMode.warn(
          'select-union-orderBy',
          `${unionName}.${node.fieldName}`,
          `The select \`orderBy\` on "${node.fieldName}", selected under the union "${unionName}", ` +
            `is ignored in 2.x: the related nodes are not sorted.`,
          "sort each member's related nodes",
        );
    }

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
        // v2.8.0 — strict: the typed select `where`, compiled against
        // this member's target. 2.x: the policy alone (unchanged).
        userWhere: strict && hasWhere ? node.relationshipWhere : undefined,
      });

      // v2.8.0 — strict: the typed select `orderBy`, per member.
      if (strict && hasOrderBy && relDef.isArray) {
        branches.push(
          `WHEN ${nodeVar}:${typeLabelExpr(memberName, this.schema)} THEN ${this.compileSortedComprehension(
            `${pattern}${memberPolicyWhere}`,
            innerProjection,
            childVar,
            targetDef,
            node.orderBy!,
          )}`,
        );
        continue;
      }
      if (strict && hasOrderBy)
        throw new OGMError(
          `orderBy is not supported on singular relationship "${node.fieldName}" of union member "${memberName}". ` +
            `Sorting is only valid for array relationships.`,
        );

      // Wrap singular relationships with head() to return object instead of array
      const comprehension = isSingular
        ? `head([${pattern}${memberPolicyWhere} | ${innerProjection}])`
        : `[${pattern}${memberPolicyWhere} | ${innerProjection}]`;
      const memberLabel = typeLabelExpr(memberName, this.schema);
      branches.push(`WHEN ${nodeVar}:${memberLabel} THEN ${comprehension}`);
    }

    if (branches.length === 0) return null;

    const elseClause = isSingular ? 'null' : '[]';
    return `CASE ${branches.join(' ')} ELSE ${elseClause} END`;
  }

  /**
   * v2.9.0 — a `<rel>Connection` selected under a union parent. The union's
   * merged definition carries the relationship of the FIRST member that
   * declares it, so every member's connection is compiled with that
   * member's type, direction, target and edge properties: a member whose
   * relationship differs gets the wrong edges, or none.
   *
   * 2.x keeps that Cypher (byte-identical) and warns once per union field
   * when a member differs. Strict gives each differing member its own
   * branch, compiled against its own relationship (target `read` policy
   * included; an argument it cannot take throws), and keeps the
   * first member's connection in `ELSE`. A node that also carries the label
   * of a member sharing the first relationship stays in `ELSE`.
   */
  private compileUnionConnection(
    node: SelectionNode,
    nodeVar: string,
    unionDef: NodeDefinition,
    unionMembers: string[],
    maxDepth: number,
    currentDepth: number,
    params?: Record<string, unknown>,
    paramCounter?: { count: number },
    policyContext: PolicyContextBundle | null = null,
  ): string | null {
    const compileFor = (def: NodeDefinition): string | null =>
      this.compileConnection(
        node,
        nodeVar,
        def,
        maxDepth,
        currentDepth,
        params,
        paramCounter,
        policyContext,
      );
    const relField = node.fieldName.replace(/Connection$/, '');
    const base = unionDef.relationships.get(relField);
    const fallback = compileFor(unionDef);
    if (!base || !fallback) return fallback;

    const differing: NodeDefinition[] = [];
    const sharing: NodeDefinition[] = [];
    for (const memberName of unionMembers) {
      const def = this.schema.nodes.get(memberName);
      const rel = def?.relationships.get(relField);
      if (!def || !rel) continue;
      const same =
        rel.type === base.type &&
        rel.direction === base.direction &&
        rel.target === base.target &&
        rel.properties === base.properties;
      (same ? sharing : differing).push(def);
    }
    if (differing.length === 0) return fallback;

    if (!this.strictMode.strict) {
      this.strictMode.warn(
        'select-union-connection',
        `${unionDef.typeName}.${node.fieldName}`,
        `"${node.fieldName}", selected under the union "${unionDef.typeName}", is read in 2.x through the relationship ` +
          `of its first member "${sharing[0]?.typeName ?? unionDef.typeName}" for every member, so the edges of ` +
          `${differing.map((d) => `"${d.typeName}"`).join(', ')} are wrong or missing.`,
        'read each member through its own relationship',
      );
      return fallback;
    }

    const excluded = sharing
      .map((def) => ` AND NOT ${nodeVar}:${nodeLabelExpr(def)}`)
      .join('');
    const branches: string[] = [];
    for (const def of differing) {
      const expr = compileFor(def);
      if (expr)
        branches.push(
          `WHEN ${nodeVar}:${nodeLabelExpr(def)}${excluded} THEN ${expr}`,
        );
    }
    if (branches.length === 0) return fallback;
    return `CASE ${branches.join(' ')} ELSE ${fallback} END`;
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
    if (this.beyondMaxDepth(node, currentDepth, maxDepth)) return null;

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
    // v2.5.3 — selectionSet aliases of the connection keys (validated when
    // parsed); unaliased output is byte-identical.
    const aliases = node.connectionAliases ?? {};
    const nodeKey = aliases.node ? escapeIdentifier(aliases.node) : 'node';
    const propertiesKey = aliases.properties
      ? escapeIdentifier(aliases.properties)
      : 'properties';
    const edgesKey = aliases.edges ? escapeIdentifier(aliases.edges) : 'edges';
    const totalCountKey = aliases.totalCount
      ? escapeIdentifier(aliases.totalCount)
      : 'totalCount';

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
      mapParts.push(`${nodeKey}: ${nodeProjection}`);
      projectionKeys.push(nodeKey);
    }

    // Compile edge properties projection
    if (node.edgeChildren && node.edgeChildren.length > 0) {
      const edgeFields = node.edgeChildren
        .filter((c) => c.isScalar)
        .map((c) => {
          if (c.alias === undefined || c.alias === c.fieldName)
            return `.${escapeIdentifier(c.fieldName)}`;
          assertSafeIdentifier(c.alias, 'selection alias');
          return `${escapeIdentifier(c.alias)}: ${edgeVar}.${escapeIdentifier(c.fieldName)}`;
        })
        .join(', ');
      mapParts.push(`${propertiesKey}: ${edgeVar} { ${edgeFields} }`);
      projectionKeys.push(propertiesKey);
    }

    // v2.6.0 — strict: further `node` / `properties` keys of these edges.
    for (const [k, expr] of this.extraEdgeKeyParts(
      node,
      childVar,
      edgeVar,
      targetDef,
      maxDepth,
      currentDepth,
      params,
      paramCounter,
      policyContext,
    )) {
      mapParts.push(`${k}: ${expr}`);
      projectionKeys.push(k);
    }

    // Inject synthetic sort scalars at the top level of the edge map so
    // apoc.coll.sortMulti (which only accepts top-level keys) can order the
    // collection. The outer list comprehension strips them on the way out.
    const sortKeyTokens: string[] = [];
    // v2.7.0 — a selectionSet `sort` is checked against this connection's
    // target and relationship, then takes the typed `orderBy` path below.
    const connectionOrderBy =
      node.connectionSort !== undefined
        ? normalizeConnectionOrderBy(
            node.connectionSort,
            node.fieldName,
            'sort',
            {
              targetDef,
              relDef,
              schema: this.schema,
            },
          )
        : node.connectionOrderBy;
    if (
      node.connectionSort !== undefined &&
      connectionOrderBy &&
      connectionOrderBy.length > 0 &&
      node.extraEdges &&
      node.extraEdges.length > 0
    )
      throw new OGMError(
        `sort on "${node.fieldName}" is not supported with \`edges\` selected under several response keys. ` +
          `Select the connection once per alias instead (a: ${node.fieldName}(sort: ...) { edges { ... } }).`,
      );
    if (connectionOrderBy && connectionOrderBy.length > 0)
      connectionOrderBy.forEach(({ field, direction, scope }, i) => {
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
      let userNodeWhere = hasNodeKey
        ? (cw.node as Record<string, unknown>)
        : !hasEdgeKey && !hasNodeNotKey && !hasEdgeNotKey
          ? cw
          : undefined;

      const fragments: string[] = [];

      // v2.12.0 — the upstream member-keyed shape of a union connection
      // where (`{ Member: { node: … } }`), compiled per member. Pre-2.12.0
      // the bare object stayed the node filter and its member key
      // compiled as a property, so nothing matched.
      const unionMembers =
        this.whereCompiler &&
        targetDef &&
        paramCounter &&
        params &&
        userNodeWhere === cw
          ? this.whereCompiler.compileSelectionUnionMembers(
              cw,
              childVar,
              edgeVar,
              relDef,
              paramCounter,
              policyContext ?? undefined,
              `connection "${node.fieldName}"`,
            )
          : null;
      if (unionMembers) {
        mergeParams(params!, unionMembers.params);
        fragments.push(unionMembers.cypher);
        userNodeWhere = unionMembers.rest;
      }
      const userEdgeWhere = hasEdgeKey
        ? (cw.edge as Record<string, unknown>)
        : undefined;
      const userNodeNot = hasNodeNotKey
        ? (cw.node_NOT as Record<string, unknown>)
        : undefined;
      const userEdgeNot = hasEdgeNotKey
        ? (cw.edge_NOT as Record<string, unknown>)
        : undefined;

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
      ? `${totalCountKey}: size([${pattern}${whereClause} | 1])`
      : '';
    // v2.8.0 — `pageInfo`, over the same filtered list (`''` unselected).
    const pageInfo = this.compilePageInfo(
      node.pageInfo,
      `size([${pattern}${whereClause} | 1])`,
      currentDepth,
    );
    if (node.totalCountOnly) return `{ ${totalCount}${pageInfo} }`;
    // v2.6.0 — strict: `edges` selected under further response keys, each
    // its own list over the same pattern and filter. Empty otherwise.
    const extraEdges = (node.extraEdges ?? [])
      .map((extra) => {
        const keys: string[] = [];
        const map = this.compileEdgeSetMap(
          extra,
          childVar,
          edgeVar,
          targetDef,
          maxDepth,
          currentDepth,
          params,
          paramCounter,
          policyContext,
          keys,
        );
        return `, ${escapeIdentifier(edgesKeyOf(extra))}: ${this.withCursors(
          `[${pattern}${whereClause} | ${map}]`,
          keys,
          extra.cursors,
          currentDepth,
        )}`;
      })
      .join('');
    const withTotal = `${extraEdges}${totalCount ? `, ${totalCount}` : ''}${pageInfo}`;

    // Re-project only the user-facing keys so synthetic __skN scalars don't
    // leak out of the projection.
    const outerProjection =
      projectionKeys.length > 0
        ? `{ ${projectionKeys.map((k) => `${k}: x.${k}`).join(', ')} }`
        : `{}`;
    const edgesList =
      sortKeyTokens.length === 0
        ? `[${pattern}${whereClause} | ${innerMap}]`
        : `[x IN apoc.coll.sortMulti([${pattern}${whereClause} | ${innerMap}], [${sortKeyTokens.join(
            ', ',
          )}]) | ${outerProjection}]`;
    // v2.8.0 — `cursor`: each edge's offset in the (sorted) list.
    return `{ ${edgesKey}: ${this.withCursors(
      edgesList,
      projectionKeys,
      node.cursors,
      currentDepth,
    )}${withTotal} }`;
  }

  /**
   * v2.8.0 — add each selected `cursor` key to the edges of `list`, with
   * upstream `@neo4j/graphql` 5.x semantics: the cursor of an edge is
   * `offsetToCursor(<its offset in the list>)`. Without `first` / `after`
   * (unsupported) the list is the whole filtered, sorted connection, so the
   * offsets run from 0. `keys` are the (escaped) keys every edge map
   * carries. Returns `list` unchanged when no cursor is selected.
   */
  private withCursors(
    list: string,
    keys: readonly string[],
    cursors: ConnectionKeySelection[] | undefined,
    depth: number,
  ): string {
    const selected = (cursors ?? []).filter((c) => !c.subSelection);
    if (selected.length === 0) return list;
    const e = `__ce${depth}`;
    const i = `__ci${depth}`;
    const fields = keys.map((k) => `${k}: ${e}[${i}].${k}`);
    const rawKeys = keys.map((k) =>
      k.startsWith('`') ? k.slice(1, -1).replace(/``/g, '`') : k,
    );
    for (const c of selected) {
      const key = escapeIdentifier(c.key);
      if (rawKeys.includes(c.key))
        throw new OGMError(
          `The connection edges select "${c.key}" twice, as cursor and as another field. ` +
            `Use a different alias for one of them.`,
        );
      fields.push(`${key}: ${cursorExpr(i, depth)}`);
    }
    return `head([${e} IN [${list}] | [${i} IN range(0, size(${e}) - 1) | { ${fields.join(', ')} }]])`;
  }

  /**
   * v2.8.0 — the `, <key>: { … }` entries of a connection's `pageInfo`
   * selections (`''` when none), with upstream `@neo4j/graphql` 5.x
   * semantics for a connection read without `first` / `after`: every
   * filtered edge is on the page, so `hasNextPage` and `hasPreviousPage`
   * are `false`, and `startCursor` / `endCursor` are the cursors of the
   * first and last edge — `null` when there is none. `count` is the size
   * of the very list `edges` and `totalCount` come from (same pattern,
   * `where` and target `read` policy). Fields with no meaning on
   * `PageInfo` are left out (`assertKnownFields` reports them).
   */
  private compilePageInfo(
    selections: PageInfoSelection[] | undefined,
    count: string,
    depth: number,
  ): string {
    if (!selections || selections.length === 0) return '';
    const c = `__pc${depth}`;
    let out = '';
    for (const sel of selections) {
      if (!sel.fields) continue;
      const parts: string[] = [];
      let usesCount = false;
      for (const f of sel.fields) {
        if (f.subSelection) continue;
        const key = escapeIdentifier(f.key);
        if (f.field === '__typename') parts.push(`${key}: 'PageInfo'`);
        else if (f.field === 'hasNextPage' || f.field === 'hasPreviousPage')
          parts.push(`${key}: false`);
        else if (f.field === 'startCursor') {
          usesCount = true;
          parts.push(`${key}: CASE WHEN ${c} > 0 THEN '${FIRST_CURSOR}' END`);
        } else if (f.field === 'endCursor') {
          usesCount = true;
          parts.push(
            `${key}: CASE WHEN ${c} > 0 THEN ${cursorExpr(`${c} - 1`, depth)} END`,
          );
        }
      }
      const map = `{ ${parts.join(', ')} }`;
      out += `, ${escapeIdentifier(sel.key)}: ${
        usesCount ? `head([${c} IN [${count}] | ${map}])` : map
      }`;
    }
    return out;
  }

  /**
   * v2.6.0 — the `{ node: …, properties: … }` map of one strict-mode extra
   * edge set (see `SelectionNode.extraEdges`), mirroring `compileConnection`.
   */
  private compileEdgeSetMap(
    set: SelectionNode,
    childVar: string,
    edgeVar: string,
    targetDef: NodeDefinition,
    maxDepth: number,
    currentDepth: number,
    params?: Record<string, unknown>,
    paramCounter?: { count: number },
    policyContext: PolicyContextBundle | null = null,
    /** v2.8.0 — receives the (escaped) keys of the map, for `cursor`. */
    keysOut: string[] = [],
  ): string {
    const parts: string[] = [];
    const aliases = set.connectionAliases ?? {};
    const nodeKey = aliases.node ? escapeIdentifier(aliases.node) : 'node';
    const propertiesKey = aliases.properties
      ? escapeIdentifier(aliases.properties)
      : 'properties';
    if (set.children && set.children.length > 0) keysOut.push(nodeKey);
    if (set.edgeChildren && set.edgeChildren.length > 0)
      keysOut.push(propertiesKey);
    if (set.children && set.children.length > 0)
      parts.push(
        `${nodeKey}: ${this.compile(
          set.children,
          childVar,
          targetDef,
          maxDepth,
          currentDepth + 1,
          params,
          paramCounter,
          null,
          policyContext,
        )}`,
      );
    if (set.edgeChildren && set.edgeChildren.length > 0) {
      const edgeFields = set.edgeChildren
        .filter((c) => c.isScalar)
        .map((c) => {
          if (c.alias === undefined || c.alias === c.fieldName)
            return `.${escapeIdentifier(c.fieldName)}`;
          assertSafeIdentifier(c.alias, 'selection alias');
          return `${escapeIdentifier(c.alias)}: ${edgeVar}.${escapeIdentifier(c.fieldName)}`;
        })
        .join(', ');
      parts.push(`${propertiesKey}: ${edgeVar} { ${edgeFields} }`);
    }
    for (const [k, expr] of this.extraEdgeKeyParts(
      set,
      childVar,
      edgeVar,
      targetDef,
      maxDepth,
      currentDepth,
      params,
      paramCounter,
      policyContext,
    )) {
      parts.push(`${k}: ${expr}`);
      keysOut.push(k);
    }
    return `{ ${parts.join(', ')} }`;
  }

  /**
   * v2.6.0 — strict: the projections of an edge set's further `node` /
   * `properties` keys (`SelectionNode.extraNodes` / `extraProperties`),
   * as `[escapedKey, expression]` pairs. Empty in 2.x default mode.
   */
  private extraEdgeKeyParts(
    set: SelectionNode,
    childVar: string,
    edgeVar: string,
    targetDef: NodeDefinition,
    maxDepth: number,
    currentDepth: number,
    params?: Record<string, unknown>,
    paramCounter?: { count: number },
    policyContext: PolicyContextBundle | null = null,
  ): [string, string][] {
    const out: [string, string][] = [];
    for (const extra of set.extraNodes ?? [])
      if (extra.children.length > 0)
        out.push([
          escapeIdentifier(extra.key),
          this.compile(
            extra.children,
            childVar,
            targetDef,
            maxDepth,
            currentDepth + 1,
            params,
            paramCounter,
            null,
            policyContext,
          ),
        ]);
    for (const extra of set.extraProperties ?? []) {
      const fields = extra.children
        .filter((c) => c.isScalar)
        .map((c) => {
          if (c.alias === undefined || c.alias === c.fieldName)
            return `.${escapeIdentifier(c.fieldName)}`;
          assertSafeIdentifier(c.alias, 'selection alias');
          return `${escapeIdentifier(c.alias)}: ${edgeVar}.${escapeIdentifier(c.fieldName)}`;
        });
      if (fields.length > 0)
        out.push([
          escapeIdentifier(extra.key),
          `${edgeVar} { ${fields.join(', ')} }`,
        ]);
    }
    return out;
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
      // v2.11.0 — strict item 23: a member whose labels exclude its type
      // name is told apart by its label set.
      const byLabels = typenameByLabels(nodeVar, unionMembers, this.schema);
      if (byLabels) return byLabels;
      const memberList = unionMembers.map((m) => `'${m}'`).join(', ');
      return `head([__label IN labels(${nodeVar}) WHERE __label IN [${memberList}]])`;
    }
    const interfaceDef = this.schema.interfaces?.get(nodeDef.typeName);
    if (
      interfaceDef &&
      interfaceDef.implementedBy &&
      interfaceDef.implementedBy.length > 0
    ) {
      const byLabels = typenameByLabels(
        nodeVar,
        interfaceDef.implementedBy,
        this.schema,
      );
      if (byLabels) return byLabels;
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

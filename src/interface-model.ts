/* eslint-disable @typescript-eslint/no-explicit-any */

import { DocumentNode } from 'graphql';
import { Driver, int as neo4jInt } from 'neo4j-driver';
import { FulltextCompiler } from './compilers/fulltext.compiler';
import {
  SelectionCompiler,
  SelectionNode,
} from './compilers/selection.compiler';
import { WhereCompiler } from './compilers/where.compiler';
import { OGMError, RecordNotFoundError } from './errors';
import { ExecutionContext, Executor } from './execution/executor';
import { ResultMapper } from './execution/result-mapper';
import { PolicyDeniedError } from './policy/errors';
import { hashCtx } from './policy/resolver';
import type {
  Operation,
  PolicyContextBundle,
  ResolvedPolicies,
} from './policy/types';
import type { ModelPolicyBinding, UnsafeOptions } from './model';
import {
  InterfaceDefinition,
  NodeDefinition,
  SchemaMetadata,
  WhereInput,
} from './schema/types';
import { CypherFieldScope } from './utils/cypher-field-projection';
import { compileSortClause } from './utils/cypher-sort-projection';
import {
  assertSafeIdentifier,
  assertSafeLabel,
  escapeIdentifier,
  mergeParams,
} from './utils/validation';

interface FindOptions<TSort = Record<string, 'ASC' | 'DESC'>> {
  limit?: number;
  offset?: number;
  sort?: TSort[];
}

import type { QueryCompilers } from './model';

/**
 * InterfaceModel only needs query compilers (no mutations).
 * Re-exported as a named type for backwards compatibility.
 */
export type InterfaceModelCompilers = QueryCompilers;

/**
 * Public-facing interface for InterfaceModel — used in generated type aliases.
 * Excludes internal class properties so jest.Mocked<XModel> only requires find/aggregate.
 */
export interface InterfaceModelInterface<
  T = any,
  TWhere = any,
  TSort = Record<string, 'ASC' | 'DESC'>,
> {
  find(params?: {
    where?: TWhere;
    selectionSet?: string | DocumentNode;
    options?: FindOptions<TSort>;
    labels?: string[];
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<(T & { __typename: string })[]>;

  aggregate(params: {
    where?: TWhere;
    aggregate: { count?: boolean; [field: string]: boolean | undefined };
    labels?: string[];
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<Record<string, unknown>>;

  findFirst?(params?: {
    where?: TWhere;
    selectionSet?: string | DocumentNode;
    options?: Omit<FindOptions<TSort>, 'limit'>;
    labels?: string[];
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<(T & { __typename: string }) | null>;

  findUnique?(params: {
    where: TWhere;
    selectionSet?: string | DocumentNode;
    labels?: string[];
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<(T & { __typename: string }) | null>;

  findFirstOrThrow?(params?: {
    where?: TWhere;
    selectionSet?: string | DocumentNode;
    options?: Omit<FindOptions<TSort>, 'limit'>;
    labels?: string[];
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<T & { __typename: string }>;

  findUniqueOrThrow?(params: {
    where: TWhere;
    selectionSet?: string | DocumentNode;
    labels?: string[];
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<T & { __typename: string }>;

  count?(params?: {
    where?: TWhere;
    labels?: string[];
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<number>;
}

export class InterfaceModel<
  T = Record<string, unknown>,
  TWhere = any,
  TSort = Record<string, 'ASC' | 'DESC'>,
> implements InterfaceModelInterface<T, TWhere, TSort> {
  private whereCompiler: WhereCompiler;
  private selectionCompiler: SelectionCompiler;
  private fulltextCompiler: FulltextCompiler;
  private executor: Executor;
  private syntheticNodeDef: NodeDefinition;
  private _defaultSelection: SelectionNode[] | undefined;
  private maxDepth: number = 12;
  private _selectionSetStr: string | undefined;

  private policyBinding: ModelPolicyBinding | undefined;
  private logger: import('./execution/executor').OGMLogger | undefined;

  constructor(
    private interfaceDef: InterfaceDefinition,
    private schema: SchemaMetadata,
    driver: Driver,
    compilers?: InterfaceModelCompilers,
    policyBinding?: ModelPolicyBinding,
  ) {
    this.whereCompiler = compilers?.where ?? new WhereCompiler(schema);
    this.selectionCompiler =
      compilers?.selection ?? new SelectionCompiler(schema, this.whereCompiler);
    this.fulltextCompiler = compilers?.fulltext ?? new FulltextCompiler(schema);
    this.executor = new Executor(driver, policyBinding?.logger);
    this.syntheticNodeDef = this.buildSyntheticNodeDef();
    this.policyBinding = policyBinding;
    this.logger = policyBinding?.logger;
  }

  /**
   * Resolve the policy bundle for the interface itself. Per design
   * decision #1, the InterfaceModel uses a CASE-per-label expression
   * that AND's each implementer's `'read'` policy with the interface's
   * own — implemented in `compileInterfacePolicyClause`.
   */
  private resolveInterfacePolicy(
    op: Operation,
    unsafe?: UnsafeOptions,
  ): PolicyContextBundle | null {
    const binding = this.policyBinding;
    if (!binding) return null;

    if (binding.globalBypass) {
      if (this.logger?.warn)
        this.logger.warn(
          '[OGM] policies bypassed via unsafe.bypassPolicies on interface "%s" op "%s"',
          this.interfaceDef.name,
          op,
        );
      return null;
    }

    if (unsafe?.bypassPolicies) {
      if (this.logger?.warn)
        this.logger.warn(
          '[OGM] per-call unsafe.bypassPolicies on interface "%s" op "%s"',
          this.interfaceDef.name,
          op,
        );
      return null;
    }

    const resolved = binding.resolve(this.interfaceDef.name, op, binding.ctx);

    return {
      ctx: binding.ctx,
      operation: op,
      resolved: resolved ?? {
        overridden: false,
        permissives: [],
        restrictives: [],
        evaluated: [],
      },
      defaults: binding.defaults,
      resolveForType: (typeName, targetOp) =>
        binding.resolve(typeName, targetOp, binding.ctx),
    };
  }

  private withInterfaceAuditMetadata(
    context: ExecutionContext | undefined,
    bundle: PolicyContextBundle | null,
    operation: Operation,
    bypassed: boolean,
  ): ExecutionContext | undefined {
    if (!this.policyBinding) return context;
    if (this.policyBinding.defaults.auditMetadata === false) return context;

    const evaluated = bundle?.resolved.evaluated ?? [];
    const metadata: Record<string, unknown> = {
      ogmPolicySetVersion: this.policyBinding.policySetVersion,
      ctxFingerprint: hashCtx(this.policyBinding.ctx),
      modelType: this.interfaceDef.name,
      operation,
      policiesEvaluated: [...evaluated],
      bypassed,
    };
    if (context?.metadata)
      return { ...context, metadata: { ...context.metadata, ...metadata } };
    if (context) return { ...context, metadata };
    return { metadata };
  }

  /**
   * Build a CASE-per-label policy clause. For each implementer with
   * registered `'read'` policies, emit a branch that AND-combines the
   * interface-level policy with the implementer's. Implementers without
   * a registered policy fall back to the interface-level only. Branches
   * with empty permissives evaluate to `false`.
   *
   * Returns a Cypher fragment safe to AND into the WHERE clause; the
   * fragment shares `paramCounter` with the calling pipeline so params
   * don't collide.
   */
  private compileInterfacePolicyClause(
    bundle: PolicyContextBundle | null,
    nodeVar: string,
    paramCounter: { count: number },
    paramsTarget: Record<string, unknown>,
  ): { cypher: string; preludes: string[] } {
    if (!bundle) return { cypher: '', preludes: [] };
    if (bundle.resolved.overridden) return { cypher: '', preludes: [] };

    const branches: string[] = [];
    let allPreludes: string[] = [];
    let anyImplementerHasPolicy = false;
    for (const memberName of this.interfaceDef.implementedBy) {
      const memberDef = this.schema.nodes.get(memberName);
      if (!memberDef) continue;
      const memberPolicy = bundle.resolveForType(memberName, 'read');
      if (memberPolicy) anyImplementerHasPolicy = true;
      // Compose: interface-level + implementer-level. Use the where
      // compiler with a synthesized bundle; the syntheticNodeDef stands
      // in for the interface but properties are looked up on the
      // implementer when AND-stitching.
      const composedResolved: ResolvedPolicies = {
        overridden: false,
        permissives: [
          ...(bundle.resolved?.permissives ?? []),
          ...(memberPolicy?.permissives ?? []),
        ],
        restrictives: [
          ...(bundle.resolved?.restrictives ?? []),
          ...(memberPolicy?.restrictives ?? []),
        ],
        evaluated: [
          ...(bundle.resolved?.evaluated ?? []),
          ...(memberPolicy?.evaluated ?? []),
        ],
      };
      // If neither interface nor implementer have permissives → branch
      // is `false` (default-deny).
      if (
        composedResolved.permissives.length === 0 &&
        composedResolved.restrictives.length === 0
      ) {
        // No policies in this branch → fall through (no constraint).
        // We emit `true` so the CASE doesn't match and exclude this
        // implementer; visibility is the union of explicit branches.
        // But callers expect "no policy → no constraint" so we use
        // `true` here to match the no-policy case.
        branches.push(
          `WHEN ${nodeVar}:${escapeIdentifier(memberName)} THEN true`,
        );
        continue;
      }
      const branchBundle: PolicyContextBundle = {
        ctx: bundle.ctx,
        operation: 'read',
        resolved: composedResolved,
        defaults: bundle.defaults,
        resolveForType: bundle.resolveForType,
      };
      const result = this.whereCompiler.compile(
        undefined,
        nodeVar,
        memberDef,
        paramCounter,
        { policyContext: branchBundle },
      );
      mergeParams(paramsTarget, result.params);
      if (result.preludes && result.preludes.length > 0)
        allPreludes = [...allPreludes, ...result.preludes];
      const branchClause = result.cypher.length > 0 ? result.cypher : 'true';
      branches.push(
        `WHEN ${nodeVar}:${escapeIdentifier(memberName)} THEN ${branchClause}`,
      );
    }

    // No implementer has any policy → no clause; fall back to the
    // interface-level alone (handled via WhereCompiler in the caller).
    if (!anyImplementerHasPolicy && bundle.resolved.permissives.length === 0)
      return { cypher: '', preludes: [] };

    if (branches.length === 0) return { cypher: '', preludes: [] };

    // ELSE false guards the case where a labeled member appears that we
    // didn't enumerate (defense in depth).
    return {
      cypher: `(CASE ${branches.join(' ')} ELSE false END)`,
      preludes: allPreludes,
    };
  }

  /**
   * Throw `PolicyDeniedError` early when default-deny is `'throw'` and
   * no implementer has a permissive that matches.
   */
  private assertNotDeniedAtCompile(
    bundle: PolicyContextBundle | null,
    operation: Operation,
  ): void {
    if (!bundle) return;
    if (bundle.resolved.overridden) return;
    if (bundle.defaults.onDeny !== 'throw') return;
    if (bundle.resolved.permissives.length > 0) return;
    // Check implementer permissives — at least one should exist.
    let anyPerm = false;
    for (const member of this.interfaceDef.implementedBy) {
      const m = bundle.resolveForType(member, 'read');
      if (m && m.permissives.length > 0) {
        anyPerm = true;
        break;
      }
    }
    if (!anyPerm)
      throw new PolicyDeniedError({
        typeName: this.interfaceDef.name,
        operation,
        reason: 'no-permissive-matched',
      });
  }

  async find(params?: {
    where?: TWhere;
    selectionSet?: string | DocumentNode;
    options?: FindOptions<TSort>;
    labels?: string[];
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<(T & { __typename: string })[]> {
    const policyContext = this.resolveInterfacePolicy('read', params?.unsafe);
    this.assertNotDeniedAtCompile(policyContext, 'read');

    const cypherParts: string[] = [];
    const allParams: Record<string, unknown> = {};
    const paramCounter = { count: 0 };

    // MATCH with interface label
    const validatedLabels = (params?.labels ?? []).map((l) =>
      assertSafeLabel(l),
    );
    const labels = [
      escapeIdentifier(this.interfaceDef.label),
      ...validatedLabels,
    ];
    cypherParts.push(`MATCH (n:${labels.join(':')})`);

    // Use cached synthetic NodeDefinition for WHERE compilation
    const syntheticNodeDef = this.syntheticNodeDef;

    // WHERE — user where compiled against the interface's synthetic
    // NodeDefinition (interface props only). Policy is composed via
    // the CASE-per-label clause that AND's interface + implementer.
    const whereResult = this.whereCompiler.compile(
      params?.where as WhereInput | undefined,
      'n',
      syntheticNodeDef,
      paramCounter,
    );
    if (whereResult.preludes && whereResult.preludes.length > 0)
      cypherParts.push(...whereResult.preludes);

    const policyClause = this.compileInterfacePolicyClause(
      policyContext,
      'n',
      paramCounter,
      allParams,
    );
    if (policyClause.preludes.length > 0)
      cypherParts.push(...policyClause.preludes);

    const combinedWhere = combineWhereWithPolicy(
      whereResult.cypher,
      policyClause.cypher,
    );

    if (combinedWhere) {
      cypherParts.push(`WHERE ${combinedWhere}`);
      mergeParams(allParams, whereResult.params);
    } else if (whereResult.preludes && whereResult.preludes.length > 0)
      mergeParams(allParams, whereResult.params);

    // __typename resolution via CASE
    const caseLines = this.interfaceDef.implementedBy.map(
      (typeName) => `WHEN n:${escapeIdentifier(typeName)} THEN '${typeName}'`,
    );
    cypherParts.push(`WITH n, CASE ${caseLines.join(' ')} END AS __typename`);

    // RETURN
    let selection: SelectionNode[];
    if (params?.selectionSet) {
      const selStr =
        typeof params.selectionSet === 'string'
          ? params.selectionSet
          : (params.selectionSet.loc?.source?.body ??
            String(params.selectionSet));
      selection = this.selectionCompiler.parseSelectionSet(selStr);
    } else selection = this.defaultInterfaceSelection();

    // Use SelectionCompiler for proper pattern comprehension (relationship support)
    // The select scope captures any `@cypher` SELECT fields. Its preludes
    // are stitched between the `WITH n, ... AS __typename` and the
    // sort prelude / RETURN. `__typename` must be preserved because it's
    // already in scope and the RETURN re-projects it.
    const selectScope = new CypherFieldScope('n', ['__typename'], '__sel');
    const returnClause = this.selectionCompiler.compile(
      selection,
      'n',
      this.syntheticNodeDef,
      this.maxDepth,
      0,
      allParams,
      paramCounter,
      selectScope,
    );
    // Inject __typename into the projection: "n { .id, .name }" → "n { .id, .name, __typename: __typename }"
    const injected = returnClause.replace(/\}$/, ', __typename: __typename }');

    // OPTIONS — sort `pre` (CALL subqueries + WITH for `@cypher` sorts) is
    // injected BEFORE the RETURN so the projected aliases are in scope; the
    // WITH must preserve `__typename` (already in scope from the typename
    // resolution step above) AND any `__sel_*` aliases that the select
    // prelude has already projected.
    let sortPre = '';
    let sortOrderBy = '';
    if (params?.options?.sort?.length) {
      const compiled = compileSortClause({
        sort: params.options.sort as ReadonlyArray<Record<string, unknown>>,
        nodeVar: 'n',
        propertyLookup: (field) => this.syntheticNodeDef.properties.get(field),
        preserveVars: ['__typename', ...selectScope.carried()],
      });
      sortPre = compiled.pre;
      sortOrderBy = compiled.orderBy;
    }

    if (selectScope.hasAny()) cypherParts.push(...selectScope.emit());
    if (sortPre) cypherParts.push(sortPre);
    cypherParts.push(`RETURN ${injected}`);
    if (sortOrderBy) cypherParts.push(sortOrderBy);

    // Validate offset/limit BEFORE forwarding to the driver — pre-1.7.4
    // we forwarded raw values, so a negative `limit` either errored
    // out at the driver layer or triggered an unbounded scan depending
    // on driver version. Mirror the validation in `Model.compileOptions`.
    if (params?.options?.offset !== undefined) {
      const offset = Math.trunc(Number(params.options.offset));
      if (!Number.isFinite(offset) || offset < 0)
        throw new OGMError('offset must be a non-negative integer');
      allParams.options_offset = neo4jInt(offset);
      cypherParts.push(`SKIP $options_offset`);
    }
    if (params?.options?.limit !== undefined) {
      const limit = Math.trunc(Number(params.options.limit));
      if (!Number.isFinite(limit) || limit < 0)
        throw new OGMError('limit must be a non-negative integer');
      const MAX_LIMIT = 10_000;
      allParams.options_limit = neo4jInt(Math.min(limit, MAX_LIMIT));
      cypherParts.push(`LIMIT $options_limit`);
    }

    const cypher = cypherParts.join('\n');
    const result = await this.executor.execute(
      cypher,
      allParams,
      this.withInterfaceAuditMetadata(
        params?.context,
        policyContext,
        'read',
        Boolean(params?.unsafe?.bypassPolicies),
      ),
    );
    return ResultMapper.mapRecords(result.records, 'n') as (T & {
      __typename: string;
    })[];
  }

  async aggregate(params: {
    where?: TWhere;
    aggregate: { count?: boolean; [field: string]: boolean | undefined };
    labels?: string[];
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<Record<string, unknown>> {
    let policyContext = this.resolveInterfacePolicy('aggregate', params.unsafe);
    if (!policyContext)
      policyContext = this.resolveInterfacePolicy('read', params.unsafe);
    this.assertNotDeniedAtCompile(policyContext, 'aggregate');

    const cypherParts: string[] = [];
    const allParams: Record<string, unknown> = {};
    const paramCounter = { count: 0 };

    const validatedLabels = (params.labels ?? []).map((l) =>
      assertSafeLabel(l),
    );
    const labels = [
      escapeIdentifier(this.interfaceDef.label),
      ...validatedLabels,
    ];
    cypherParts.push(`MATCH (n:${labels.join(':')})`);

    const syntheticNodeDef = this.syntheticNodeDef;
    const whereResult = this.whereCompiler.compile(
      params.where as WhereInput | undefined,
      'n',
      syntheticNodeDef,
      paramCounter,
    );
    if (whereResult.preludes && whereResult.preludes.length > 0)
      cypherParts.push(...whereResult.preludes);

    const policyClause = this.compileInterfacePolicyClause(
      policyContext,
      'n',
      paramCounter,
      allParams,
    );
    if (policyClause.preludes.length > 0)
      cypherParts.push(...policyClause.preludes);

    const combinedWhere = combineWhereWithPolicy(
      whereResult.cypher,
      policyClause.cypher,
    );

    if (combinedWhere) {
      cypherParts.push(`WHERE ${combinedWhere}`);
      mergeParams(allParams, whereResult.params);
    } else if (whereResult.preludes && whereResult.preludes.length > 0)
      mergeParams(allParams, whereResult.params);

    const returnParts: string[] = [];
    if (params.aggregate.count) returnParts.push('count(n) AS count');

    // Type-aware emission: skip `avg` / `sum` for non-numeric fields so
    // result entries don't carry meaningless `null` averages. Pre-1.7.4
    // we emitted the full set unconditionally. The interface variant
    // resolves the type from the `interfaceDef` (interfaces declare
    // their own properties); if the field isn't on the interface, we
    // fall back to `other` so only `min` / `max` are emitted.
    const fieldTypeCategories = new Map<
      string,
      'numeric' | 'temporal' | 'other'
    >();
    const ifaceProps = this.interfaceDef.properties;
    for (const [field, enabled] of Object.entries(params.aggregate)) {
      if (field === 'count' || !enabled) continue;
      assertSafeIdentifier(field, 'aggregate field');
      const category = resolveInterfaceFieldCategory(field, ifaceProps);
      fieldTypeCategories.set(field, category);
      const escaped = escapeIdentifier(field);
      returnParts.push(`min(n.${escaped}) AS ${field}_min`);
      returnParts.push(`max(n.${escaped}) AS ${field}_max`);
      if (category === 'numeric') {
        returnParts.push(`avg(n.${escaped}) AS ${field}_avg`);
        returnParts.push(`sum(n.${escaped}) AS ${field}_sum`);
      }
    }

    cypherParts.push(`RETURN ${returnParts.join(', ')}`);

    const cypher = cypherParts.join('\n');
    const result = await this.executor.execute(
      cypher,
      allParams,
      this.withInterfaceAuditMetadata(
        params.context,
        policyContext,
        'aggregate',
        Boolean(params.unsafe?.bypassPolicies),
      ),
    );

    if (result.records.length === 0)
      return params.aggregate.count ? { count: 0 } : {};

    const record = result.records[0];
    const aggregateResult: Record<string, unknown> = {};
    if (params.aggregate.count)
      aggregateResult.count = ResultMapper.convertNeo4jTypes(
        record.get('count'),
      );

    for (const [field, enabled] of Object.entries(params.aggregate)) {
      if (field === 'count' || !enabled) continue;
      const category = fieldTypeCategories.get(field) ?? 'other';
      const entry: Record<string, unknown> = {
        min: ResultMapper.convertNeo4jTypes(record.get(`${field}_min`)),
        max: ResultMapper.convertNeo4jTypes(record.get(`${field}_max`)),
      };
      if (category === 'numeric') {
        entry.average = ResultMapper.convertNeo4jTypes(
          record.get(`${field}_avg`),
        );
        entry.sum = ResultMapper.convertNeo4jTypes(record.get(`${field}_sum`));
      }
      aggregateResult[field] = entry;
    }

    return aggregateResult;
  }

  // --- findFirst / findUnique ------------------------------------------------

  async findFirst(params?: {
    where?: TWhere;
    selectionSet?: string | DocumentNode;
    options?: Omit<FindOptions<TSort>, 'limit'>;
    labels?: string[];
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<(T & { __typename: string }) | null> {
    const results = await this.find({
      ...params,
      options: { ...params?.options, limit: 1 },
    });
    return results[0] ?? null;
  }

  async findUnique(params: {
    where: TWhere;
    selectionSet?: string | DocumentNode;
    labels?: string[];
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<(T & { __typename: string }) | null> {
    return this.findFirst(params);
  }

  async findFirstOrThrow(params?: {
    where?: TWhere;
    selectionSet?: string | DocumentNode;
    options?: Omit<FindOptions<TSort>, 'limit'>;
    labels?: string[];
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<T & { __typename: string }> {
    const result = await this.findFirst(params);
    if (result === null)
      throw new RecordNotFoundError(
        this.interfaceDef.name,
        params?.where as Record<string, unknown> | undefined,
      );
    return result;
  }

  async findUniqueOrThrow(params: {
    where: TWhere;
    selectionSet?: string | DocumentNode;
    labels?: string[];
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<T & { __typename: string }> {
    const result = await this.findUnique(params);
    if (result === null)
      throw new RecordNotFoundError(
        this.interfaceDef.name,
        params.where as Record<string, unknown>,
      );
    return result;
  }

  // --- count ----------------------------------------------------------------

  async count(params?: {
    where?: TWhere;
    labels?: string[];
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<number> {
    const result = await this.aggregate({
      where: params?.where,
      aggregate: { count: true },
      labels: params?.labels,
      context: params?.context,
      unsafe: params?.unsafe,
    });
    return (result.count as number) ?? 0;
  }

  private buildSyntheticNodeDef(): NodeDefinition {
    return {
      typeName: this.interfaceDef.name,
      label: this.interfaceDef.label,
      labels: [],
      pluralName: '',
      properties: this.interfaceDef.properties,
      relationships: this.interfaceDef.relationships,
      fulltextIndexes: [],
      implementsInterfaces: [],
    };
  }

  set selectionSet(value: string) {
    this._defaultSelection = undefined;
    this._selectionSetStr = value;
  }

  private defaultInterfaceSelection(): SelectionNode[] {
    if (this._defaultSelection) return this._defaultSelection;

    const nodes: SelectionNode[] = [];
    for (const [, prop] of this.interfaceDef.properties) {
      if (prop.isCypher) continue;
      nodes.push({
        fieldName: prop.name,
        isScalar: true,
        isRelationship: false,
        isConnection: false,
      });
    }
    this._defaultSelection = nodes;
    return nodes;
  }
}

/**
 * Combine the user-supplied where body and the interface-level policy
 * clause. Mirror of the WhereCompiler stitching but lives here because
 * the interface model AND-stitches across two compile passes.
 */
function combineWhereWithPolicy(
  userBody: string,
  policyClause: string,
): string {
  if (!userBody && !policyClause) return '';
  if (!userBody) return policyClause;
  if (!policyClause) return userBody;
  return `(${userBody}) AND ${policyClause}`;
}

/**
 * Mirror of `resolveFieldAggregateCategory` (in `model.ts`) for
 * interface-level properties. The interface declares its own
 * properties (the implementer types may add their own, but only
 * interface-level fields are aggregatable through the interface
 * model), so we resolve the category from the interface property map.
 */
function resolveInterfaceFieldCategory(
  fieldName: string,
  ifaceProps: Map<string, { type: string }>,
): 'numeric' | 'temporal' | 'other' {
  const prop = ifaceProps.get(fieldName);
  if (!prop) return 'other';
  if (prop.type === 'Int' || prop.type === 'Float') return 'numeric';
  if (
    prop.type === 'DateTime' ||
    prop.type === 'Date' ||
    prop.type === 'Time' ||
    prop.type === 'LocalDateTime' ||
    prop.type === 'LocalTime'
  )
    return 'temporal';
  return 'other';
}

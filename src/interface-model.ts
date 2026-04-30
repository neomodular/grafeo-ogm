/* eslint-disable @typescript-eslint/no-explicit-any */

import { DocumentNode } from 'graphql';
import { Driver, int as neo4jInt } from 'neo4j-driver';
import { FulltextCompiler } from './compilers/fulltext.compiler';
import {
  SelectionCompiler,
  SelectionNode,
} from './compilers/selection.compiler';
import { WhereCompiler } from './compilers/where.compiler';
import { RecordNotFoundError } from './errors';
import { ExecutionContext, Executor } from './execution/executor';
import { ResultMapper } from './execution/result-mapper';
import {
  InterfaceDefinition,
  NodeDefinition,
  SchemaMetadata,
  WhereInput,
} from './schema/types';
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
  }): Promise<(T & { __typename: string })[]>;

  aggregate(params: {
    where?: TWhere;
    aggregate: { count?: boolean; [field: string]: boolean | undefined };
    labels?: string[];
    context?: ExecutionContext;
  }): Promise<Record<string, unknown>>;

  findFirst?(params?: {
    where?: TWhere;
    selectionSet?: string | DocumentNode;
    options?: Omit<FindOptions<TSort>, 'limit'>;
    labels?: string[];
    context?: ExecutionContext;
  }): Promise<(T & { __typename: string }) | null>;

  findUnique?(params: {
    where: TWhere;
    selectionSet?: string | DocumentNode;
    labels?: string[];
    context?: ExecutionContext;
  }): Promise<(T & { __typename: string }) | null>;

  findFirstOrThrow?(params?: {
    where?: TWhere;
    selectionSet?: string | DocumentNode;
    options?: Omit<FindOptions<TSort>, 'limit'>;
    labels?: string[];
    context?: ExecutionContext;
  }): Promise<T & { __typename: string }>;

  findUniqueOrThrow?(params: {
    where: TWhere;
    selectionSet?: string | DocumentNode;
    labels?: string[];
    context?: ExecutionContext;
  }): Promise<T & { __typename: string }>;

  count?(params?: {
    where?: TWhere;
    labels?: string[];
    context?: ExecutionContext;
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

  constructor(
    private interfaceDef: InterfaceDefinition,
    private schema: SchemaMetadata,
    driver: Driver,
    compilers?: InterfaceModelCompilers,
  ) {
    this.whereCompiler = compilers?.where ?? new WhereCompiler(schema);
    this.selectionCompiler =
      compilers?.selection ?? new SelectionCompiler(schema, this.whereCompiler);
    this.fulltextCompiler = compilers?.fulltext ?? new FulltextCompiler(schema);
    this.executor = new Executor(driver);
    this.syntheticNodeDef = this.buildSyntheticNodeDef();
  }

  async find(params?: {
    where?: TWhere;
    selectionSet?: string | DocumentNode;
    options?: FindOptions<TSort>;
    labels?: string[];
    context?: ExecutionContext;
  }): Promise<(T & { __typename: string })[]> {
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

    // WHERE
    const whereResult = this.whereCompiler.compile(
      params?.where as WhereInput | undefined,
      'n',
      syntheticNodeDef,
      paramCounter,
    );
    if (whereResult.cypher) {
      cypherParts.push(`WHERE ${whereResult.cypher}`);
      mergeParams(allParams, whereResult.params);
    }

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
    const returnClause = this.selectionCompiler.compile(
      selection,
      'n',
      this.syntheticNodeDef,
      this.maxDepth,
      0,
      allParams,
      paramCounter,
    );
    // Inject __typename into the projection: "n { .id, .name }" → "n { .id, .name, __typename: __typename }"
    const injected = returnClause.replace(/\}$/, ', __typename: __typename }');

    // OPTIONS — sort `pre` (CALL subqueries + WITH for `@cypher` sorts) is
    // injected BEFORE the RETURN so the projected aliases are in scope; the
    // WITH must preserve `__typename` (already in scope from the typename
    // resolution step above).
    let sortPre = '';
    let sortOrderBy = '';
    if (params?.options?.sort?.length) {
      const compiled = compileSortClause({
        sort: params.options.sort as ReadonlyArray<Record<string, unknown>>,
        nodeVar: 'n',
        propertyLookup: (field) => this.syntheticNodeDef.properties.get(field),
        preserveVars: ['__typename'],
      });
      sortPre = compiled.pre;
      sortOrderBy = compiled.orderBy;
    }

    if (sortPre) cypherParts.push(sortPre);
    cypherParts.push(`RETURN ${injected}`);
    if (sortOrderBy) cypherParts.push(sortOrderBy);

    if (params?.options?.offset !== undefined) {
      allParams.options_offset = neo4jInt(params.options.offset);
      cypherParts.push(`SKIP $options_offset`);
    }
    if (params?.options?.limit !== undefined) {
      allParams.options_limit = neo4jInt(params.options.limit);
      cypherParts.push(`LIMIT $options_limit`);
    }

    const cypher = cypherParts.join('\n');
    const result = await this.executor.execute(
      cypher,
      allParams,
      params?.context,
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
  }): Promise<Record<string, unknown>> {
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
    if (whereResult.cypher) {
      cypherParts.push(`WHERE ${whereResult.cypher}`);
      mergeParams(allParams, whereResult.params);
    }

    const returnParts: string[] = [];
    if (params.aggregate.count) returnParts.push('count(n) AS count');

    for (const [field, enabled] of Object.entries(params.aggregate)) {
      if (field === 'count' || !enabled) continue;
      assertSafeIdentifier(field, 'aggregate field');
      returnParts.push(`min(n.${escapeIdentifier(field)}) AS ${field}_min`);
      returnParts.push(`max(n.${escapeIdentifier(field)}) AS ${field}_max`);
      returnParts.push(`avg(n.${escapeIdentifier(field)}) AS ${field}_avg`);
    }

    cypherParts.push(`RETURN ${returnParts.join(', ')}`);

    const cypher = cypherParts.join('\n');
    const result = await this.executor.execute(
      cypher,
      allParams,
      params.context,
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
      aggregateResult[field] = {
        min: ResultMapper.convertNeo4jTypes(record.get(`${field}_min`)),
        max: ResultMapper.convertNeo4jTypes(record.get(`${field}_max`)),
        average: ResultMapper.convertNeo4jTypes(record.get(`${field}_avg`)),
      };
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
  }): Promise<(T & { __typename: string }) | null> {
    return this.findFirst(params);
  }

  async findFirstOrThrow(params?: {
    where?: TWhere;
    selectionSet?: string | DocumentNode;
    options?: Omit<FindOptions<TSort>, 'limit'>;
    labels?: string[];
    context?: ExecutionContext;
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
  }): Promise<number> {
    const result = await this.aggregate({
      where: params?.where,
      aggregate: { count: true },
      labels: params?.labels,
      context: params?.context,
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

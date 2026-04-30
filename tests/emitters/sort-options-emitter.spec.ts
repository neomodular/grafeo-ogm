import { emitSortOptions } from '../../src/generator/type-emitters/sort-options-emitter';
import type {
  SchemaMetadata,
  NodeDefinition,
  InterfaceDefinition,
  PropertyDefinition,
} from '../../src/schema/types';

function makeProp(
  name: string,
  type = 'String',
  overrides: Partial<PropertyDefinition> = {},
): PropertyDefinition {
  return {
    name,
    type,
    required: false,
    isArray: false,
    isListItemRequired: false,
    isGenerated: false,
    isUnique: false,
    isCypher: false,
    directives: [],
    ...overrides,
  };
}

function makeNode(
  typeName: string,
  props: PropertyDefinition[],
): NodeDefinition {
  return {
    typeName,
    label: typeName,
    labels: [],
    pluralName: typeName.toLowerCase() + 's',
    properties: new Map(props.map((p) => [p.name, p])),
    relationships: new Map(),
    fulltextIndexes: [],
    implementsInterfaces: [],
  };
}

function makeIface(
  name: string,
  props: PropertyDefinition[],
): InterfaceDefinition {
  return {
    name,
    label: name,
    properties: new Map(props.map((p) => [p.name, p])),
    relationships: new Map(),
    implementedBy: [],
  };
}

function makeSchema(
  nodes: NodeDefinition[] = [],
  interfaces: InterfaceDefinition[] = [],
  enums: Map<string, string[]> = new Map(),
): SchemaMetadata {
  return {
    nodes: new Map(nodes.map((n) => [n.typeName, n])),
    interfaces: new Map(interfaces.map((i) => [i.name, i])),
    relationshipProperties: new Map(),
    enums,
    unions: new Map(),
  };
}

describe('emitSortOptions', () => {
  it('emits stored-scalar Sort fields for a node (baseline)', () => {
    const schema = makeSchema([
      makeNode('Drug', [makeProp('id', 'ID'), makeProp('drugName', 'String')]),
    ]);

    const out = emitSortOptions(schema);

    expect(out).toContain('export type DrugSort = {');
    expect(out).toContain('id?: InputMaybe<SortDirection>;');
    expect(out).toContain('drugName?: InputMaybe<SortDirection>;');
  });

  it('includes scalar-returning @cypher fields in <Node>Sort', () => {
    const schema = makeSchema([
      makeNode('Drug', [
        makeProp('id', 'ID'),
        makeProp('drugName', 'String'),
        makeProp('insensitiveDrugName', 'String', {
          isCypher: true,
          cypherStatement: 'RETURN toLower(this.drugName) AS x',
        }),
      ]),
    ]);

    const out = emitSortOptions(schema);

    expect(out).toContain('insensitiveDrugName?: InputMaybe<SortDirection>;');
  });

  it('skips @cypher fields that return a non-scalar (e.g. Node) type', () => {
    const schema = makeSchema([
      makeNode('Drug', [
        makeProp('id', 'ID'),
        makeProp('parentDrug', 'Drug', {
          isCypher: true,
          cypherStatement: 'MATCH (this)<-[:CHILD_OF]-(p:Drug) RETURN p',
        }),
      ]),
    ]);

    const out = emitSortOptions(schema);

    expect(out).not.toContain('parentDrug?');
  });

  it('skips @cypher fields whose return type is an array', () => {
    const schema = makeSchema([
      makeNode('Drug', [
        makeProp('relatedNames', 'String', {
          isCypher: true,
          isArray: true,
          cypherStatement:
            'MATCH (this)-[:RELATED]->(d) RETURN collect(d.name)',
        }),
      ]),
    ]);

    const out = emitSortOptions(schema);

    expect(out).not.toContain('relatedNames?');
  });

  it('skips @cypher fields returning Point or CartesianPoint', () => {
    const schema = makeSchema([
      makeNode('Drug', [
        makeProp('p', 'Point', {
          isCypher: true,
          cypherStatement: 'RETURN this.location AS p',
        }),
        makeProp('cp', 'CartesianPoint', {
          isCypher: true,
          cypherStatement: 'RETURN this.local AS cp',
        }),
      ]),
    ]);

    const out = emitSortOptions(schema);

    expect(out).not.toContain('p?');
    expect(out).not.toContain('cp?');
  });

  it('treats enum returns as sortable @cypher fields', () => {
    const schema = makeSchema(
      [
        makeNode('Drug', [
          makeProp('priority', 'Priority', {
            isCypher: true,
            cypherStatement: 'RETURN this.tier AS priority',
          }),
        ]),
      ],
      [],
      new Map([['Priority', ['HIGH', 'LOW']]]),
    );

    const out = emitSortOptions(schema);

    expect(out).toContain('priority?: InputMaybe<SortDirection>;');
  });

  it('still skips stored-scalar Point fields by leaving them in (ORDER BY validates at runtime)', () => {
    // Stored Point fields stay in <Node>Sort — runtime ORDER BY by Point is
    // a Neo4j error, but that's pre-existing behavior. The @cypher-only
    // exclusion is intentional.
    const schema = makeSchema([
      makeNode('Drug', [makeProp('location', 'Point')]),
    ]);

    const out = emitSortOptions(schema);

    expect(out).toContain('location?: InputMaybe<SortDirection>;');
  });

  it('emits Sort + Options blocks for interfaces too', () => {
    const schema = makeSchema(
      [],
      [
        makeIface('Entity', [
          makeProp('id', 'ID'),
          makeProp('lname', 'String', {
            isCypher: true,
            cypherStatement: 'RETURN toLower(this.name) AS lname',
          }),
        ]),
      ],
    );

    const out = emitSortOptions(schema);

    expect(out).toContain('export type EntitySort = {');
    expect(out).toContain('id?: InputMaybe<SortDirection>;');
    expect(out).toContain('lname?: InputMaybe<SortDirection>;');
    expect(out).toContain('export type EntityOptions = {');
  });
});

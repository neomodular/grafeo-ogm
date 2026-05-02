import { Driver } from 'neo4j-driver';
import { InterfaceModel } from '../src/interface-model';
import {
  InterfaceDefinition,
  NodeDefinition,
  PropertyDefinition,
  SchemaMetadata,
} from '../src/schema/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function storedProp(name: string, type = 'String'): PropertyDefinition {
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
  };
}

function cypherProp(
  name: string,
  statement: string,
  columnName?: string,
): PropertyDefinition {
  return {
    name,
    type: 'String',
    required: false,
    isArray: false,
    isListItemRequired: false,
    isGenerated: false,
    isUnique: false,
    isCypher: true,
    cypherStatement: statement,
    cypherColumnName: columnName,
    directives: ['cypher'],
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
    implementsInterfaces: ['Entity'],
  };
}

const userNode = makeNode('User', [storedProp('id', 'ID'), storedProp('name')]);
const orgNode = makeNode('Organization', [
  storedProp('id', 'ID'),
  storedProp('name'),
]);

const entityInterface: InterfaceDefinition = {
  name: 'Entity',
  label: 'Entity',
  properties: new Map([
    ['id', storedProp('id', 'ID')],
    ['name', storedProp('name')],
    [
      'lowerName',
      cypherProp(
        'lowerName',
        'RETURN toLower(this.name) AS lowerName',
        'lowerName',
      ),
    ],
  ]),
  relationships: new Map(),
  implementedBy: ['User', 'Organization'],
};

const schema: SchemaMetadata = {
  nodes: new Map([
    ['User', userNode],
    ['Organization', orgNode],
  ]),
  interfaces: new Map([['Entity', entityInterface]]),
  relationshipProperties: new Map(),
  enums: new Map(),
  unions: new Map(),
};

function createMockDriver() {
  const mockSession = {
    run: jest.fn().mockResolvedValue({
      records: [],
      summary: { counters: { updates: () => ({}) } },
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const mockDriver = {
    session: jest.fn().mockReturnValue(mockSession),
  } as unknown as Driver;
  return { mockDriver, mockSession };
}

function getCypher(session: { run: jest.Mock }): string {
  return session.run.mock.calls[0][0] as string;
}

// ---------------------------------------------------------------------------

describe('InterfaceModel — @cypher fields', () => {
  let model: InterfaceModel;
  let mockSession: ReturnType<typeof createMockDriver>['mockSession'];

  beforeEach(() => {
    const { mockDriver, mockSession: ms } = createMockDriver();
    mockSession = ms;
    model = new InterfaceModel(entityInterface, schema, mockDriver);
  });

  it('stitches WHERE preludes between MATCH and WHERE', async () => {
    await model.find({
      where: { lowerName_CONTAINS: 'foo' } as Record<string, unknown>,
    });
    const cypher = getCypher(mockSession);

    const matchIdx = cypher.indexOf('MATCH (n:`Entity`)');
    const callIdx = cypher.indexOf('CALL {');
    const whereIdx = cypher.indexOf('WHERE __where_n_lowerName');
    expect(matchIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(matchIdx);
    expect(whereIdx).toBeGreaterThan(callIdx);

    expect(cypher).toContain('WITH n, `lowerName` AS __where_n_lowerName');
    expect(cypher).toContain('WHERE __where_n_lowerName CONTAINS $param0');
  });

  it('stitches SELECT prelude AFTER the __typename WITH and preserves __typename', async () => {
    await model.find({
      selectionSet: '{ id name lowerName }',
    });
    const cypher = getCypher(mockSession);

    // Order: WITH __typename → SELECT prelude → RETURN.
    const typenameIdx = cypher.indexOf('END AS __typename');
    const selPreludeIdx = cypher.indexOf('`lowerName` AS __sel_n_lowerName');
    const returnIdx = cypher.indexOf('RETURN n {');

    expect(typenameIdx).toBeGreaterThan(-1);
    expect(selPreludeIdx).toBeGreaterThan(typenameIdx);
    expect(returnIdx).toBeGreaterThan(selPreludeIdx);

    // The select prelude's WITH MUST carry forward `__typename`.
    expect(cypher).toMatch(
      /WITH n, __typename, `lowerName` AS __sel_n_lowerName/,
    );

    // The projection references both the alias and the typename.
    expect(cypher).toContain('`lowerName`: __sel_n_lowerName');
    expect(cypher).toContain('__typename: __typename');
  });

  it('combines WHERE + SELECT + sort on the same @cypher field', async () => {
    await model.find({
      where: { lowerName_CONTAINS: 'foo' } as Record<string, unknown>,
      selectionSet: '{ id lowerName }',
      options: {
        sort: [{ lowerName: 'ASC' }] as Record<string, 'ASC' | 'DESC'>[],
      },
    });
    const cypher = getCypher(mockSession);

    // All three preludes are emitted with disjoint alias namespaces.
    expect(cypher).toContain('__where_n_lowerName');
    expect(cypher).toContain('__sel_n_lowerName');
    expect(cypher).toContain('__sort_lowerName');

    // The sort prelude must carry both __typename AND the select alias.
    expect(cypher).toMatch(
      /WITH n, __typename, __sel_n_lowerName, `lowerName` AS __sort_lowerName/,
    );
  });

  it('count()/aggregate() stitches WHERE preludes', async () => {
    await model.count({
      where: { lowerName_CONTAINS: 'foo' } as Record<string, unknown>,
    });
    const cypher = getCypher(mockSession);
    expect(cypher).toContain('CALL {');
    expect(cypher).toContain('WHERE __where_n_lowerName CONTAINS $param0');
  });
});

/**
 * vNEXT — the array-connect UNWIND fast path coerces its `where.node`
 * values like every other filter (`coerceWhereValue`). Pre-vNEXT a BigInt
 * / Int filter given as an integer string or a `bigint` was bound raw, so
 * it never equalled the stored Long and the array connect linked nothing.
 * The Cypher text is unchanged; only the bound values are. The live half
 * is `tests/integration/connect-fast-path-coercion.spec.ts`.
 */
import neo4j from 'neo4j-driver';
import { MutationCompiler } from '../src/compilers/mutation.compiler';
import {
  NodeDefinition,
  PropertyDefinition,
  SchemaMetadata,
} from '../src/schema/types';

function prop(
  name: string,
  overrides: Partial<PropertyDefinition> = {},
): PropertyDefinition {
  return {
    name,
    type: 'String',
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

function nodeDef(
  typeName: string,
  props: PropertyDefinition[],
  rels: NodeDefinition['relationships'] = new Map(),
): NodeDefinition {
  return {
    typeName,
    label: typeName,
    labels: [],
    pluralName: typeName.toLowerCase() + 's',
    properties: new Map(props.map((p) => [p.name, p])),
    relationships: rels,
    fulltextIndexes: [],
    implementsInterfaces: [],
  };
}

const item = nodeDef('Item', [
  prop('id', { isGenerated: true }),
  prop('code', { type: 'BigInt' }),
  prop('n', { type: 'Int' }),
  prop('name'),
]);
const hub = nodeDef(
  'Hub',
  [prop('id', { isGenerated: true })],
  new Map([
    [
      'items',
      {
        fieldName: 'items',
        type: 'HAS',
        direction: 'OUT' as const,
        target: 'Item',
        isArray: true,
        isRequired: true,
      },
    ],
  ]),
);
const schema: SchemaMetadata = {
  nodes: new Map([
    ['Hub', hub],
    ['Item', item],
  ]),
  interfaces: new Map(),
  relationshipProperties: new Map(),
  enums: new Map(),
  unions: new Map(),
};

const whereResult = { cypher: 'WHERE n.id = $param0', params: { param0: 'h' } };

function connectParams(items: Record<string, unknown>[]) {
  const compiler = new MutationCompiler(schema);
  const result = compiler.compileUpdate(
    { id: 'h' },
    undefined,
    { items },
    undefined,
    hub,
    whereResult,
  );
  expect(result.cypher).toContain('UNWIND $connect_items AS connItem');
  return {
    cypher: result.cypher,
    rows: result.params.connect_items as {
      where: { node: Record<string, unknown> };
    }[],
  };
}

describe('array connect fast path coerces where values (vNEXT)', () => {
  it('binds a BigInt string / bigint as a neo4j Integer', () => {
    const { rows } = connectParams([
      { where: { node: { code: '9007199254740993' } } },
      { where: { node: { code: BigInt('9007199254740995') } } },
    ]);
    expect(neo4j.isInt(rows[0].where.node.code)).toBe(true);
    expect(String(rows[0].where.node.code)).toBe('9007199254740993');
    expect(String(rows[1].where.node.code)).toBe('9007199254740995');
  });

  it('coerces `_IN` lists element-wise, also for the bare-where shape', () => {
    const { rows } = connectParams([{ where: { code_IN: ['1', '2'] } }]);
    expect(rows[0].where.node.code_IN).toEqual([neo4j.int(1), neo4j.int(2)]);
  });

  it('keeps numbers, strings of String fields and the Cypher text as before', () => {
    const input = [{ where: { node: { n: 5, name: 'x' } } }];
    const { cypher, rows } = connectParams(input);
    expect(rows[0].where.node).toEqual({ n: 5, name: 'x' });
    // The caller's input is not mutated.
    expect(input[0].where.node).toEqual({ n: 5, name: 'x' });
    expect(cypher).toContain(
      'WHERE target.`n` = connItem.where.node.n AND target.`name` = connItem.where.node.name',
    );
  });
});

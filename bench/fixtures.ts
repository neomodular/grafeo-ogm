/**
 * Shared fixtures for the benchmark suite. Realistic-shape schema +
 * realistic input objects so the numbers reflect actual hot-path cost,
 * not toy cases. Used across every `bench/*.bench.ts` file so that
 * baseline / before / after captures are comparable.
 */

import type {
  NodeDefinition,
  PropertyDefinition,
  RelationshipDefinition,
  RelationshipPropertiesDefinition,
  SchemaMetadata,
} from '../src/schema/types';

function prop(
  name: string,
  type: string = 'String',
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

function rel(
  fieldName: string,
  type: string,
  target: string,
  overrides: Partial<RelationshipDefinition> = {},
): RelationshipDefinition {
  return {
    fieldName,
    type,
    direction: 'OUT',
    target,
    isArray: false,
    isRequired: false,
    ...overrides,
  };
}

function nodeDef(
  typeName: string,
  props: PropertyDefinition[],
  rels: RelationshipDefinition[] = [],
): NodeDefinition {
  return {
    typeName,
    label: typeName,
    labels: [typeName],
    pluralName: typeName.toLowerCase() + 's',
    properties: new Map(props.map((p) => [p.name, p])),
    relationships: new Map(rels.map((r) => [r.fieldName, r])),
    fulltextIndexes: [],
    implementsInterfaces: [],
  };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const statusNode = nodeDef('Status', [
  prop('id', 'ID', { isGenerated: true, isUnique: true }),
  prop('name'),
  prop('createdAt', 'DateTime'),
]);

export const tagNode = nodeDef('Tag', [
  prop('id', 'ID', { isGenerated: true, isUnique: true }),
  prop('label'),
]);

export const authorNode = nodeDef(
  'Author',
  [
    prop('id', 'ID', { isGenerated: true, isUnique: true }),
    prop('name'),
    prop('email'),
  ],
  [rel('hasBooks', 'WROTE', 'Book', { isArray: true })],
);

export const bookStatusProps: RelationshipPropertiesDefinition = {
  typeName: 'BookStatusProps',
  properties: new Map([
    ['since', prop('since', 'DateTime')],
    ['priority', prop('priority', 'Int')],
  ]),
};

export const bookNode = nodeDef(
  'Book',
  [
    prop('id', 'ID', { isGenerated: true, isUnique: true }),
    prop('title'),
    prop('isbn'),
    prop('pageCount', 'Int'),
    prop('publishedAt', 'DateTime'),
    prop('rating', 'Float'),
  ],
  [
    rel('hasStatus', 'HAS_STATUS', 'Status', {
      direction: 'OUT',
      properties: 'BookStatusProps',
    }),
    rel('hasStatusConnection', 'HAS_STATUS', 'Status', {
      direction: 'OUT',
      properties: 'BookStatusProps',
    }),
    rel('writtenBy', 'WROTE', 'Author', { direction: 'IN' }),
    rel('taggedWith', 'TAGGED_WITH', 'Tag', { isArray: true }),
  ],
);

export const schema: SchemaMetadata = {
  nodes: new Map([
    ['Book', bookNode],
    ['Status', statusNode],
    ['Tag', tagNode],
    ['Author', authorNode],
  ]),
  interfaces: new Map(),
  relationshipProperties: new Map([['BookStatusProps', bookStatusProps]]),
  enums: new Map(),
  unions: new Map(),
};

// ---------------------------------------------------------------------------
// Realistic input shapes for benchmarks
// ---------------------------------------------------------------------------

export const SIMPLE_WHERE = { id: 'abc123' };

export const MIXED_OPERATORS_WHERE = {
  id: 'abc123',
  title_CONTAINS: 'foo',
  pageCount_GTE: 100,
  publishedAt_GT: '2024-01-01',
};

export const DEEP_LOGICAL_WHERE = {
  AND: [
    { title_STARTS_WITH: 'A' },
    {
      OR: [
        { rating_GT: 4.0 },
        { AND: [{ pageCount_LT: 200 }, { isbn_CONTAINS: 'X' }] },
      ],
    },
    { NOT: { id: 'banned' } },
  ],
};

export const RELATIONSHIP_SOME_WHERE = {
  hasStatus_SOME: { name: 'Active' },
};

export const CONNECTION_NODE_EDGE_WHERE = {
  hasStatusConnection: {
    node: { name: 'Active' },
    edge: { since: '2020-01-01' },
  },
};

export const SIMPLE_SELECTION_SET = '{ id title }';

export const NESTED_SELECTION_SET =
  '{ id title pageCount hasStatus { id name createdAt } taggedWith { id label } }';

export const DEEP_SELECTION_SET =
  '{ id title hasStatus { id name } writtenBy { id name email hasBooks { id title rating } } taggedWith { id label } hasStatusConnection { edges { node { id name } properties { since priority } } } }';

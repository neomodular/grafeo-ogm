import neo4j, { Integer } from 'neo4j-driver';
import { MutationCompiler } from '../src/compilers/mutation.compiler';
import { OGMError } from '../src/errors';
import {
  NodeDefinition,
  PropertyDefinition,
  RelationshipDefinition,
  SchemaMetadata,
} from '../src/schema/types';

// ─── Helper factories ────────────────────────────────────────────

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
  overrides: Partial<NodeDefinition> = {},
): NodeDefinition {
  return {
    typeName,
    label: typeName,
    labels: [],
    pluralName: typeName.toLowerCase() + 's',
    properties: new Map(props.map((p) => [p.name, p])),
    relationships: new Map(rels.map((r) => [r.fieldName, r])),
    fulltextIndexes: [],
    implementsInterfaces: [],
    ...overrides,
  };
}

// ─── Mock schema ─────────────────────────────────────────────────

const playlistNode = nodeDef('Playlist', [
  prop('id', { isGenerated: true }),
  prop('name'),
  prop('rank', { type: 'Int' }),
]);

const trackNode = nodeDef(
  'Track',
  [
    prop('id', { isGenerated: true }),
    prop('code', { type: 'Int', isUnique: true }),
    prop('title'),
    prop('position', { type: 'Int' }),
    prop('plays', { type: 'BigInt' }),
    prop('rating', { type: 'Float' }),
    prop('tags', { type: 'Int', isArray: true }),
  ],
  [
    rel('playlists', 'IN_PLAYLIST', 'Playlist', {
      isArray: true,
      properties: 'TrackPlaylistProps',
    }),
  ],
);

const schema: SchemaMetadata = {
  nodes: new Map([
    ['Track', trackNode],
    ['Playlist', playlistNode],
  ]),
  interfaces: new Map(),
  relationshipProperties: new Map([
    [
      'TrackPlaylistProps',
      {
        typeName: 'TrackPlaylistProps',
        properties: new Map([
          ['order', prop('order', { type: 'Int' })],
          ['note', prop('note')],
        ]),
      },
    ],
  ]),
  enums: new Map(),
  unions: new Map(),
};

const emptyWhere = { cypher: '', params: {} };

function expectInteger(value: unknown, expected: number): void {
  expect(neo4j.isInt(value)).toBe(true);
  expect((value as Integer).toNumber()).toBe(expected);
}

// ─── Tests ───────────────────────────────────────────────────────

describe('Int/BigInt write coercion (issue #5)', () => {
  let compiler: MutationCompiler;

  beforeEach(() => {
    compiler = new MutationCompiler(schema);
  });

  describe('create', () => {
    it('binds Int properties as Neo4j Integer', () => {
      const result = compiler.compileCreate(
        [{ title: 'Song', position: 3 }],
        trackNode,
      );
      expectInteger(result.params.create0_position, 3);
      expect(result.params.create0_title).toBe('Song');
    });

    it('binds BigInt properties from JS bigint input', () => {
      const result = compiler.compileCreate(
        [{ plays: 9007199254740995n }],
        trackNode,
      );
      expect(neo4j.isInt(result.params.create0_plays)).toBe(true);
      expect((result.params.create0_plays as Integer).toString()).toBe(
        '9007199254740995',
      );
    });

    it('coerces Int list fields element-wise', () => {
      const result = compiler.compileCreate([{ tags: [1, 2, 3] }], trackNode);
      const tags = result.params.create0_tags as unknown[];
      expect(Array.isArray(tags)).toBe(true);
      tags.forEach((tag, i) => expectInteger(tag, i + 1));
    });

    it('leaves Float, String, and schema-unknown fields untouched', () => {
      const result = compiler.compileCreate(
        [{ rating: 4.5, title: 'x', freeform: 7 }],
        trackNode,
      );
      expect(result.params.create0_rating).toBe(4.5);
      expect(result.params.create0_title).toBe('x');
      expect(result.params.create0_freeform).toBe(7);
    });

    it('passes through null and pre-built Integer values', () => {
      const already = neo4j.int(9);
      const result = compiler.compileCreate(
        [{ position: null, code: already }],
        trackNode,
      );
      expect(result.params.create0_position).toBeNull();
      expect(result.params.create0_code).toBe(already);
    });

    it('rejects non-integral numbers for Int fields', () => {
      expect(() =>
        compiler.compileCreate([{ position: 1.5 }], trackNode),
      ).toThrow(OGMError);
    });

    it('coerces edge properties on nested create', () => {
      const result = compiler.compileCreate(
        [
          {
            title: 'Song',
            playlists: {
              create: [
                { node: { name: 'Mix' }, edge: { order: 4, note: 'a' } },
              ],
            },
          },
        ],
        trackNode,
      );
      expectInteger(result.params.create0_playlists_create0_edge_order, 4);
      expect(result.params.create0_playlists_create0_edge_note).toBe('a');
    });
  });

  describe('update', () => {
    it('binds Int properties as Neo4j Integer in SET', () => {
      const result = compiler.compileUpdate(
        {},
        { position: 7, title: 'renamed' },
        undefined,
        undefined,
        trackNode,
        emptyWhere,
      );
      expectInteger(result.params.update_position, 7);
      expect(result.params.update_title).toBe('renamed');
    });

    it('coerces nested update node and edge properties', () => {
      const result = compiler.compileUpdate(
        {},
        {
          playlists: {
            where: { node: { name: 'Mix' } },
            update: { node: { rank: 5 }, edge: { order: 3 } },
          },
        },
        undefined,
        undefined,
        trackNode,
        emptyWhere,
      );
      expectInteger(result.params.update_playlists_0_set_rank, 5);
      expectInteger(result.params.update_playlists_0_edge_order, 3);
    });
  });

  describe('connect', () => {
    it('coerces edge properties on single connect', () => {
      const result = compiler.compileUpdate(
        {},
        undefined,
        { playlists: { where: { node: { name: 'Mix' } }, edge: { order: 2 } } },
        undefined,
        trackNode,
        emptyWhere,
      );
      expectInteger(result.params.connect_playlists_edge_order, 2);
    });

    it('coerces edge properties inside the UNWIND array-connect param', () => {
      const result = compiler.compileUpdate(
        {},
        undefined,
        {
          playlists: [
            { where: { node: { name: 'a' } }, edge: { order: 1 } },
            { where: { node: { name: 'b' } }, edge: { order: 2 } },
          ],
        },
        undefined,
        trackNode,
        emptyWhere,
      );
      const items = result.params.connect_playlists as Array<{
        edge: { order: unknown };
      }>;
      expect(items).toHaveLength(2);
      expectInteger(items[0].edge.order, 1);
      expectInteger(items[1].edge.order, 2);
    });

    it('coerces edge properties on nested connect inside update', () => {
      const result = compiler.compileUpdate(
        {},
        {
          playlists: {
            connect: [{ where: { node: { name: 'Mix' } }, edge: { order: 6 } }],
          },
        },
        undefined,
        undefined,
        trackNode,
        emptyWhere,
      );
      expectInteger(result.params.update_playlists_0_conn0_edge_order, 6);
    });
  });

  describe('upsert (compileMerge)', () => {
    it('coerces the MERGE key and both SET branches', () => {
      const result = compiler.compileMerge(
        { code: 42 },
        { position: 1, title: 'new' },
        { position: 2 },
        trackNode,
      );
      expectInteger(result.params.merge_code, 42);
      expectInteger(result.params.onCreate_position, 1);
      expectInteger(result.params.onMatch_position, 2);
      expect(result.params.onCreate_title).toBe('new');
    });
  });

  describe('createMany', () => {
    it('coerces Int fields inside the UNWIND items param', () => {
      const result = compiler.compileCreateMany(
        [
          { title: 'a', position: 1 },
          { title: 'b', position: 2 },
        ],
        trackNode,
      );
      const items = result.params.items as Array<Record<string, unknown>>;
      expectInteger(items[0].position, 1);
      expectInteger(items[1].position, 2);
      expect(items[0].title).toBe('a');
    });
  });
});

/**
 * v2.13.0 — `extend type` / `extend interface` / `extend union` /
 * `extend enum` are merged into the type they extend. Through v2.12.3 the
 * parser skipped them: the extension's fields and directives vanished and
 * `create` with an extended field threw "Unknown field".
 *
 * Equivalence: a schema written with extensions must behave exactly like
 * the same schema with everything declared inline — same SchemaMetadata,
 * same compiled Cypher, same db push statements, same generated types.
 * Schemas without extensions must parse exactly as before.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'graphql';
import { Driver } from 'neo4j-driver';
import { OGM } from '../src/ogm';
import { OGMError } from '../src/errors';
import { parseSchema } from '../src/schema/parser';
import { mergeTypeExtensions } from '../src/schema/type-extensions';
import { planSchemaSync } from '../src/cli/push-planner';
import { generateTypes } from '../src/generator/generate-types';
import { recordingDriver, Recorded } from './strict-mode.writes.cases';

/** Order-preserving serialization of SchemaMetadata (Maps → entry lists). */
function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v instanceof Map ? { __map: [...v.entries()] } : v,
  );
}

const EXTENDED = /* GraphQL */ `
  extend type Movie
    @fulltext(indexes: [{ name: "MovieTitle", fields: ["title"] }])

  enum Genre {
    DRAMA
  }

  interface Production {
    title: String!
  }

  type Movie @node {
    id: ID! @id
    title: String!
  }

  type Person @node {
    id: ID! @id
    name: String!
  }

  type ActedIn @relationshipProperties {
    role: String
  }

  union SearchResult = Movie

  extend enum Genre {
    COMEDY
  }

  extend interface Production {
    released: Int
  }

  extend type Movie implements Production {
    released: Int
    slug: String @unique
    tagline: String @default(value: "tbd")
    genre: Genre
    embedding: [Float!]
    actors: [Person!]!
      @relationship(type: "ACTED_IN", direction: IN, properties: "ActedIn")
    actorCount: Int
      @cypher(
        statement: "MATCH (this)<-[:ACTED_IN]-(p) RETURN count(p) AS c"
        columnName: "c"
      )
  }

  extend type Movie
    @vector(
      indexes: [
        {
          indexName: "MovieEmb"
          embeddingProperty: "embedding"
          queryName: "similarMovies"
        }
      ]
    )

  extend type ActedIn {
    screenTime: Int
  }

  extend union SearchResult = Person

  extend type Person {
    movies: [Movie!]!
      @relationship(type: "ACTED_IN", direction: OUT, properties: "ActedIn")
  }
`;

const INLINED = /* GraphQL */ `
  enum Genre {
    DRAMA
    COMEDY
  }

  interface Production {
    title: String!
    released: Int
  }

  type Movie implements Production
    @node
    @fulltext(indexes: [{ name: "MovieTitle", fields: ["title"] }])
    @vector(
      indexes: [
        {
          indexName: "MovieEmb"
          embeddingProperty: "embedding"
          queryName: "similarMovies"
        }
      ]
    ) {
    id: ID! @id
    title: String!
    released: Int
    slug: String @unique
    tagline: String @default(value: "tbd")
    genre: Genre
    embedding: [Float!]
    actors: [Person!]!
      @relationship(type: "ACTED_IN", direction: IN, properties: "ActedIn")
    actorCount: Int
      @cypher(
        statement: "MATCH (this)<-[:ACTED_IN]-(p) RETURN count(p) AS c"
        columnName: "c"
      )
  }

  type Person @node {
    id: ID! @id
    name: String!
    movies: [Movie!]!
      @relationship(type: "ACTED_IN", direction: OUT, properties: "ActedIn")
  }

  type ActedIn @relationshipProperties {
    role: String
    screenTime: Int
  }

  union SearchResult = Movie | Person
`;

describe('type extensions — equivalent to inline declarations', () => {
  it('parse to the same SchemaMetadata', () => {
    expect(serialize(parseSchema(EXTENDED))).toBe(
      serialize(parseSchema(INLINED)),
    );
  });

  it('keep the extension fields and directives', () => {
    const schema = parseSchema(EXTENDED);
    const movie = schema.nodes.get('Movie')!;
    expect([...movie.properties.keys()]).toEqual(
      expect.arrayContaining(['slug', 'tagline', 'genre', 'actorCount']),
    );
    expect(movie.properties.get('slug')?.isUnique).toBe(true);
    expect(movie.relationships.get('actors')?.type).toBe('ACTED_IN');
    expect(movie.fulltextIndexes.map((i) => i.name)).toEqual(['MovieTitle']);
    expect(movie.vectorIndexes?.map((i) => i.indexName)).toEqual(['MovieEmb']);
    expect(movie.implementsInterfaces).toEqual(['Production']);
    expect(schema.interfaces.get('Production')?.implementedBy).toEqual([
      'Movie',
    ]);
    expect(schema.enums.get('Genre')).toEqual(['DRAMA', 'COMEDY']);
    expect(schema.unions.get('SearchResult')).toEqual(['Movie', 'Person']);
    expect([
      ...schema.relationshipProperties.get('ActedIn')!.properties.keys(),
    ]).toEqual(['role', 'screenTime']);
  });

  it('compile the same Cypher', async () => {
    const run = async (typeDefs: string) => {
      const records: Recorded[] = [];
      const ogm = new OGM({
        typeDefs,
        driver: recordingDriver(records) as Driver,
        logger: { debug: () => {}, warn: () => {} },
      });
      const Movie = ogm.model('Movie');
      await Movie.create({
        input: [
          {
            title: 'T',
            slug: 's',
            genre: 'COMEDY',
            actors: {
              create: [{ node: { name: 'A' }, edge: { screenTime: 3 } }],
            },
          },
        ],
      });
      await Movie.find({
        where: { slug: 's', actors_SOME: { name: 'A' } },
        selectionSet: `{ title slug tagline actorCount actorsConnection { edges { properties { screenTime } node { name } } } }`,
      });
      await ogm.interfaceModel('Production').find({
        selectionSet: '{ title released }',
      });
      return records.map((r) => [r.cypher, Object.keys(r.params).sort()]);
    };
    const extended = await run(EXTENDED);
    expect(extended.length).toBe(3);
    expect(extended).toEqual(await run(INLINED));
  });

  it('plan the same db push statements', () => {
    const live = { constraints: [], indexes: [] };
    const vector = { MovieEmb: { dimensions: 3 } };
    const statements = (typeDefs: string) =>
      planSchemaSync(parseSchema(typeDefs), live, vector).create.map(
        (s) => s.cypher,
      );
    const extended = statements(EXTENDED);
    expect(extended.join('\n')).toMatch(/Movie_slug_unique/);
    expect(extended.join('\n')).toMatch(/MovieTitle/);
    expect(extended.join('\n')).toMatch(/MovieEmb/);
    expect(extended).toEqual(statements(INLINED));
  });

  it('generate the same types', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grafeo-ext-'));
    try {
      const gen = async (typeDefs: string, name: string) => {
        const outFile = path.join(dir, name);
        await generateTypes({
          typeDefs,
          outFile,
          config: { formatOutput: false },
        });
        return fs.readFileSync(outFile, 'utf-8');
      };
      const extended = await gen(EXTENDED, 'extended.ts');
      expect(extended).toMatch(/slug\?: InputMaybe<Scalars\["String"\]/);
      expect(extended).toBe(await gen(INLINED, 'inlined.ts'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('create accepts an extended field (was "Unknown field")', async () => {
    const records: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: `
        type Book @node { id: ID! @id title: String! }
        extend type Book { isbn: String }
      `,
      driver: recordingDriver(records) as Driver,
    });
    await ogm.model('Book').create({ input: [{ title: 'T', isbn: 'X' }] });
    expect(records[0].cypher).toMatch(/isbn/);
  });
});

describe('type extensions — rejected forms', () => {
  const rejects = (typeDefs: string, message: RegExp) => {
    expect(() => parseSchema(typeDefs)).toThrow(OGMError);
    expect(() => parseSchema(typeDefs)).toThrow(message);
  };

  it('extending an undeclared type', () => {
    rejects(
      'extend type Ghost { name: String }',
      /Cannot extend type "Ghost" because it is not defined/,
    );
  });

  it('extending with the wrong kind', () => {
    rejects(
      'interface I { a: String } extend type I { b: String }',
      /Cannot extend non-object type "I"/,
    );
    rejects(
      'type T @node { a: String } extend interface T { b: String }',
      /Cannot extend non-interface type "T"/,
    );
  });

  it('redeclaring a field', () => {
    rejects(
      'type T @node { a: String } extend type T { a: Int }',
      /Field "T\.a" already exists/,
    );
  });

  it('redeclaring a type directive (would otherwise be silently ignored)', () => {
    rejects(
      `type T @node @fulltext(indexes: [{ name: "A", fields: ["a"] }]) { a: String }
       extend type T @fulltext(indexes: [{ name: "B", fields: ["a"] }])`,
      /already has directive @fulltext/,
    );
  });

  it('redeclaring an enum value, union member or interface', () => {
    rejects('enum E { A } extend enum E { A }', /Enum value "E\.A"/);
    rejects(
      'type A @node { a: String } union U = A extend union U = A',
      /can only include type "A" once/,
    );
    rejects(
      'interface I { a: String } type T implements I @node { a: String } extend type T implements I',
      /can only implement "I" once/,
    );
  });

  it('a duplicate definition in a schema that uses extensions', () => {
    rejects(
      'type T @node { a: String } type T @node { b: String } extend type T { c: String }',
      /only one type named "T"/,
    );
  });
});

describe('schemas without extensions are untouched', () => {
  const schemas: Array<[string, string]> = [
    [
      'examples/schema.graphql',
      fs.readFileSync(
        path.join(__dirname, '..', 'examples', 'schema.graphql'),
        'utf-8',
      ),
    ],
    ['inlined fixture', INLINED],
  ];

  it.each(schemas)(
    '%s: the parsed document is passed through as-is',
    (_n, sdl) => {
      const doc = parse(sdl);
      expect(mergeTypeExtensions(doc)).toBe(doc);
    },
  );
});

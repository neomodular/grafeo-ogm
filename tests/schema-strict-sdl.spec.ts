/**
 * vNEXT — malformed SDL and root operation types (scan-5 S5t-5 / S5t-14).
 *
 * - `@fulltext(indexes: [{ indexName }])` (the `@neo4j/graphql` 4+
 *   spelling) made no index; it is now an alias of `name` (both modes).
 * - strict item 37: `name` and `indexName` that disagree.
 * - strict item 38: `@relationship` without `type` / `direction` dropped
 *   the field silently.
 * - strict item 39: unknown type names were accepted.
 * - strict item 40: `type Query` / `Mutation` / `Subscription` became node
 *   models; `@neo4j/graphql` 5.x treats them as root operation types.
 *
 * Default mode keeps the 2.x result and warns once per OGM instance and
 * shape; strict mode throws at construction (or skips root types).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Driver } from 'neo4j-driver';
import { OGM } from '../src/ogm';
import { OGMError } from '../src/errors';
import { parseSchema, type SchemaWarning } from '../src/schema/parser';
import { generateTypes } from '../src/generator/generate-types';

const driver = {} as Driver;

function build(typeDefs: string, strict?: boolean) {
  const warn = jest.fn();
  const ogm = new OGM({
    typeDefs,
    driver,
    logger: { debug: () => {}, warn },
    ...(strict === undefined ? {} : { strict }),
  });
  return { ogm, warn };
}

const warned = (warn: jest.Mock, needle: string) =>
  warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(needle));

function collect(typeDefs: string) {
  const warnings: SchemaWarning[] = [];
  const schema = parseSchema(typeDefs, { onWarning: (w) => warnings.push(w) });
  return { schema, warnings };
}

describe('@fulltext indexName (alias of name)', () => {
  const sdl = `type Product @node
    @fulltext(indexes: [{ indexName: "ProductName", queryName: "productsByName", fields: ["name"] }]) {
    name: String
  }`;

  it('creates the index under indexName, in both modes, without warning', () => {
    for (const strict of [undefined, false, true]) {
      const schema = parseSchema(sdl, { strict });
      expect(schema.nodes.get('Product')!.fulltextIndexes).toEqual([
        { name: 'ProductName', fields: ['name'] },
      ]);
    }
    expect(collect(sdl).warnings).toEqual([]);
  });

  it('accepts the same value under name and indexName', () => {
    const { schema, warnings } = collect(`type P @node
      @fulltext(indexes: [{ name: "PIdx", indexName: "PIdx", fields: ["t"] }]) { t: String }`);
    expect(schema.nodes.get('P')!.fulltextIndexes).toEqual([
      { name: 'PIdx', fields: ['t'] },
    ]);
    expect(warnings).toEqual([]);
  });

  it('works on @relationshipProperties types too', () => {
    const schema =
      parseSchema(`type A @node { id: ID! b: [B!]! @relationship(type: "R", direction: OUT, properties: "RP") }
      type B @node { id: ID! }
      type RP @relationshipProperties
        @fulltext(indexes: [{ indexName: "RPNote", fields: ["note"] }]) { note: String }`);
    expect(schema.relationshipProperties.get('RP')!.fulltextIndexes).toEqual([
      { name: 'RPNote', fields: ['note'] },
    ]);
  });

  describe('strict item 37: name and indexName disagree', () => {
    const conflict = `type P @node
      @fulltext(indexes: [{ name: "Old", indexName: "New", fields: ["t"] }]) { t: String }`;

    it('default: uses name (2.x) and warns once', () => {
      const { warn } = build(conflict);
      expect(warned(warn, 'name: "Old" and indexName: "New"')).toHaveLength(1);
      expect(warned(warn, 'Enable `strict: true`')).toHaveLength(1);
      // 2.x behaviour kept: the index is the one named by `name`.
      expect(parseSchema(conflict).nodes.get('P')!.fulltextIndexes).toEqual([
        { name: 'Old', fields: ['t'] },
      ]);
    });

    it('strict: throws at OGM construction', () => {
      expect(() => build(conflict, true)).toThrow(OGMError);
      expect(() => build(conflict, true)).toThrow(
        /both name "Old" and indexName "New"/,
      );
    });
  });
});

describe('strict item 38: @relationship without type / direction', () => {
  const sdl = `type Product @node {
    id: ID!
    colour: Colour! @relationship(type: "OF_COLOUR")
    maker: Colour @relationship(direction: OUT)
  }
  type Colour @node { name: String }`;

  it('default: the fields are left out (2.x) and each warns once', () => {
    const { ogm, warn } = build(sdl);
    expect(warned(warn, 'Product.colour has no direction')).toHaveLength(1);
    expect(warned(warn, 'Product.maker has no type')).toHaveLength(1);
    const { schema } = collect(sdl);
    expect([...schema.nodes.get('Product')!.relationships.keys()]).toEqual([]);
    expect(ogm.model('Product')).toBeDefined();
  });

  it('strict: throws naming the field and the missing argument', () => {
    expect(() => build(sdl, true)).toThrow(
      /@relationship on Product\.colour is missing the required direction argument/,
    );
  });

  it('a well-formed @relationship never warns', () => {
    const { warnings } =
      collect(`type A @node { b: B @relationship(type: "R", direction: OUT) }
      type B @node { id: ID }`);
    expect(warnings).toEqual([]);
  });
});

describe('strict item 39: unknown type names', () => {
  const sdl = `type Product @node {
    name: String
    weird: Strng
    maker: Persn @relationship(type: "MADE_BY", direction: OUT)
  }`;

  it('default: fields kept as declared (2.x) and each warns once', () => {
    const { ogm, warn } = build(sdl);
    expect(warned(warn, 'Product.weird has type "Strng"')).toHaveLength(1);
    expect(warned(warn, 'Product.maker has type "Persn"')).toHaveLength(1);
    const node = collect(sdl).schema.nodes.get('Product')!;
    expect(node.properties.get('weird')!.type).toBe('Strng');
    expect(node.relationships.get('maker')!.target).toBe('Persn');
    expect(ogm.model('Product')).toBeDefined();
  });

  it('strict: throws on the first unknown type', () => {
    expect(() => build(sdl, true)).toThrow(
      /Unknown type "Strng" on Product\.weird/,
    );
  });

  it('checks interface fields too', () => {
    expect(() =>
      parseSchema(
        `interface I { x: Nope } type A implements I @node { x: String }`,
        {
          strict: true,
        },
      ),
    ).toThrow(/Unknown type "Nope" on I\.x/);
  });

  it('every defined or built-in type is known (no warnings)', () => {
    const { warnings } = collect(`
      scalar JSON
      enum Colour { RED }
      input Filter { q: String }
      interface Named { name: String }
      union Thing = A | B
      type A implements Named @node {
        name: String
        id: ID
        s: String  i: Int  f: Float  b: Boolean  big: BigInt
        dt: DateTime  d: Date  t: Time  lt: LocalTime  ldt: LocalDateTime
        dur: Duration  p: Point  cp: CartesianPoint
        j: JSON  c: Colour  l: [String!]!
        things: [Thing!]! @relationship(type: "T", direction: OUT)
      }
      type B @node { id: ID }
      extend type B { more: Colour }`);
    expect(warnings).toEqual([]);
  });
});

describe('strict item 40: root operation types', () => {
  const sdl = `type Movie @node { title: String }
    type Query { movies: [Movie!]! }
    type Mutation { touch: Int }`;

  it('default: Query / Mutation stay node models (2.x) and warn once each', () => {
    const { ogm, warn } = build(sdl);
    expect(
      warned(warn, 'type Query is a GraphQL root operation type'),
    ).toHaveLength(1);
    expect(
      warned(warn, 'type Mutation is a GraphQL root operation type'),
    ).toHaveLength(1);
    expect(ogm.model('Query')).toBeDefined();
    expect([...collect(sdl).schema.nodes.keys()]).toEqual([
      'Movie',
      'Query',
      'Mutation',
    ]);
  });

  it('strict: skips them, as @neo4j/graphql 5.x does', () => {
    const { ogm, warn } = build(sdl, true);
    expect(() => ogm.model('Query')).toThrow();
    expect(ogm.model('Movie')).toBeDefined();
    expect(warn).not.toHaveBeenCalled();
    expect([...parseSchema(sdl, { strict: true }).nodes.keys()]).toEqual([
      'Movie',
    ]);
  });

  it('Subscription is a root type too', () => {
    expect(
      parseSchema(`type Subscription { x: Int } type A @node { id: ID }`, {
        strict: true,
      }).nodes.has('Subscription'),
    ).toBe(false);
  });

  describe('generateTypes', () => {
    let dir: string;
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grafeo-root-types-'));
    });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    const gen = (strict?: boolean) =>
      generateTypes({
        typeDefs: sdl,
        outFile: path.join(dir, `out-${String(strict)}.ts`),
        config: { formatOutput: false },
        strict,
      });

    it('default: emits Query model types and reports a STRICT_MODE warning', async () => {
      const result = await gen();
      const out = fs.readFileSync(result.outputPath, 'utf-8');
      expect(out).toContain('QueryModel');
      expect(result.warnings.map((w) => w.code)).toEqual([
        'STRICT_MODE',
        'STRICT_MODE',
      ]);
    });

    it('strict: no Query / Mutation model types, no warnings', async () => {
      const result = await gen(true);
      const out = fs.readFileSync(result.outputPath, 'utf-8');
      expect(out).not.toContain('QueryModel');
      expect(out).not.toContain('MutationModel');
      expect(out).toContain('MovieModel');
      expect(result.warnings).toEqual([]);
    });
  });
});

describe('warn once per OGM instance', () => {
  it('a repeated shape is logged once per instance, again for a new one', () => {
    const sdl = `type Query { a: Int } type A @node { x: Strng }`;
    const first = build(sdl);
    expect(warned(first.warn, 'Query')).toHaveLength(1);
    expect(warned(first.warn, 'Strng')).toHaveLength(1);
    const second = build(sdl);
    expect(warned(second.warn, 'Query')).toHaveLength(1);
  });

  it('a schema with none of the shapes never warns', () => {
    const { warn } =
      build(`type A @node { id: ID! b: [B!]! @relationship(type: "R", direction: OUT) }
      type B @node { id: ID! }`);
    expect(warn).not.toHaveBeenCalled();
  });
});

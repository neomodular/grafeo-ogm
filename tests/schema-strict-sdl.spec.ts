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
import type { Driver } from 'neo4j-driver';
import { OGM } from '../src/ogm';
import { OGMError } from '../src/errors';
import { parseSchema, type SchemaWarning } from '../src/schema/parser';

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

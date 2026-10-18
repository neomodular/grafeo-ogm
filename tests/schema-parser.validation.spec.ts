import { parseSchema } from '../src/schema/parser';
import neo4j, { Integer } from 'neo4j-driver';
import { MutationCompiler } from '../src/compilers/mutation.compiler';
import { OGMError } from '../src/errors';

describe('parseSchema - @relationship(direction:) validation', () => {
  const schemaWith = (direction: string): string => `
    type Author @node {
      id: ID! @id
      books: [Book!]! @relationship(type: "WROTE", direction: ${direction})
    }
    type Book @node {
      id: ID! @id
    }
  `;

  it.each(['IN', 'OUT', '"IN"', '"OUT"'])('accepts direction %s', (dir) => {
    const meta = parseSchema(schemaWith(dir));
    const rel = meta.nodes.get('Author')!.relationships.get('books')!;
    expect(rel.direction).toBe(dir.replace(/"/g, ''));
  });

  // Through v2.4.7 any value was cast to 'IN' | 'OUT': reads treated anything
  // but 'IN' as OUT while writes treated anything but 'OUT' as IN, so a
  // lowercase direction wrote edges reversed and then could not read them.
  it.each(['out', '"out"', '"in"', 'Out', 'BOTH', '"sideways"'])(
    'rejects direction %s with an error naming the field',
    (dir) => {
      expect(() => parseSchema(schemaWith(dir))).toThrow(OGMError);
      expect(() => parseSchema(schemaWith(dir))).toThrow(
        /Author\.books.*direction.*"IN" or "OUT"/,
      );
    },
  );
});

describe('parseSchema - list @default values', () => {
  const listDefaults = `
    enum Color { RED GREEN }
    type Swatch @node {
      id: ID! @id
      colors: [Color!] @default(value: [RED, GREEN])
      tags: [String!]! @default(value: ["a", "b"])
      sizes: [Int!] @default(value: [1, 2])
      weights: [Float!] @default(value: [1.5])
      flags: [Boolean!] @default(value: [true, false])
      seenAt: [DateTime!] @default(value: ["2024-01-01T00:00:00Z"])
      none: [String!] @default(value: [])
    }
  `;

  // Through v2.4.7 the parser had no Kind.LIST branch, so a list default
  // parsed as `undefined` and creates silently wrote nothing.
  it('parses list defaults element-wise', () => {
    const props = parseSchema(listDefaults).nodes.get('Swatch')!.properties;
    expect(props.get('colors')!.defaultValue).toEqual(['RED', 'GREEN']);
    expect(props.get('tags')!.defaultValue).toEqual(['a', 'b']);
    expect(props.get('sizes')!.defaultValue).toEqual(['1', '2']);
    expect(props.get('weights')!.defaultValue).toEqual(['1.5']);
    expect(props.get('flags')!.defaultValue).toEqual(['true', 'false']);
    expect(props.get('seenAt')!.defaultValue).toEqual(['2024-01-01T00:00:00Z']);
    expect(props.get('none')!.defaultValue).toEqual([]);
  });

  it('applies list defaults on create, converted by element type', () => {
    const schema = parseSchema(listDefaults);
    const node = schema.nodes.get('Swatch')!;
    const { cypher, params } = new MutationCompiler(schema).compileCreate(
      [{}],
      node,
    );
    expect(params.create0_colors).toEqual(['RED', 'GREEN']);
    expect(params.create0_tags).toEqual(['a', 'b']);
    const sizes = params.create0_sizes as Integer[];
    expect(sizes.every((s) => neo4j.isInt(s))).toBe(true);
    expect(sizes.map((s) => s.toNumber())).toEqual([1, 2]);
    expect(params.create0_weights).toEqual([1.5]);
    expect(params.create0_flags).toEqual([true, false]);
    expect(params.create0_none).toEqual([]);
    // Temporal list defaults get the element-wise constructor wrapper.
    expect(cypher).toContain(
      '`seenAt`: [wc_t IN $create0_seenAt | datetime(wc_t)]',
    );
  });

  it('rejects a list default on a non-list field', () => {
    expect(() =>
      parseSchema(`
        type Swatch @node {
          id: ID! @id
          name: String @default(value: ["a"])
        }
      `),
    ).toThrow(/Swatch\.name.*list @default.*not a list type/);
  });

  it('rejects nested or non-scalar list default elements', () => {
    expect(() =>
      parseSchema(`
        type Swatch @node {
          id: ID! @id
          tags: [String!] @default(value: [["a"]])
        }
      `),
    ).toThrow(/@default on Swatch\.tags.*may only contain/);
  });
});

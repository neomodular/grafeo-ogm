import { parseSchema } from '../src/schema/parser';
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

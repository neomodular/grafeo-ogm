import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse } from 'graphql';

import { parseSchema } from '../src/schema/parser';

/**
 * Every ```graphql block in the README must be valid SDL. Through v2.4.7
 * the Interfaces example wrote `type User @node implements Entity`, which
 * GraphQL rejects (directives come after `implements`).
 */
const readme = fs.readFileSync(
  path.join(__dirname, '..', 'README.md'),
  'utf-8',
);
const blocks = [...readme.matchAll(/```graphql\n([\s\S]*?)```/g)].map(
  (m) => m[1],
);

describe('README graphql examples', () => {
  it('has examples to check', () => {
    expect(blocks.length).toBeGreaterThan(0);
  });

  it.each(blocks.map((b, i) => [i, b]))('block %i is valid SDL', (_i, b) => {
    expect(() => parse(b as string)).not.toThrow();
  });

  it('the Interfaces example parses and resolves its declared relationship', () => {
    const block = blocks.find((b) => b.includes('interface Entity'));
    expect(block).toBeDefined();
    const meta = parseSchema(block!);
    const entity = meta.interfaces.get('Entity')!;
    expect(entity.implementedBy).toEqual(['User', 'Organization']);
    expect(entity.relationships.get('resources')).toMatchObject({
      type: 'OWNS',
      direction: 'OUT',
    });
    for (const name of entity.implementedBy)
      expect(meta.nodes.get(name)!.labels).toContain('Entity');
  });
});

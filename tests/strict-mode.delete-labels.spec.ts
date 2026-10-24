/**
 * vNEXT — strict item 39: runtime `labels` on `delete()` / `deleteMany()`.
 *
 * 2.x never applied them: `delete({ where, labels: ['Archived'] })` deleted
 * every node `where` matched, archived or not (since v2.19.0 with an
 * `unknown-param` warning, strict item 34, whose strict mode threw).
 *
 * - Default mode: byte-identical Cypher (the labels stay ignored), one
 *   `delete-labels-ignored` warning per OGM, type and method; no
 *   `unknown-param` warning on top.
 * - Strict mode: the labels narrow the delete MATCH, as in find / update.
 */
import { OGMError } from '../src/errors';
import { OGM } from '../src/ogm';
import { Recorded, recordingDriver } from './strict-mode.writes.cases';

const typeDefs = /* GraphQL */ `
  type User @node {
    id: ID! @id @unique
    name: String
    posts: [Post!]! @relationship(type: "WROTE", direction: OUT)
  }
  type Post @node {
    id: ID! @id @unique
  }
`;

/** Not a fresh literal, so TypeScript's excess-property check lets it through. */
const extra = <T extends object>(o: T): T => o;
const where = { id: 'u1' };

function setup(strict?: boolean) {
  const records: Recorded[] = [];
  const warnings: string[] = [];
  const ogm = new OGM({
    typeDefs,
    driver: recordingDriver(records),
    logger: { debug: () => {}, warn: (m: string) => warnings.push(m) },
    ...(strict === undefined ? {} : { strict }),
  });
  return { users: ogm.model('User'), records, warnings };
}

/** Pre-vNEXT Cypher (main @ a962f44). */
const BEFORE = 'MATCH (n:`User`)\nWHERE n.`id` = $param0\nDETACH DELETE n';
const BEFORE_CASCADE =
  'MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)-[:`WROTE`]->(cascade_0:`Post`)\nDETACH DELETE cascade_0\nRETURN count(*) AS _del_posts_0\n}\nDETACH DELETE n';

describe('strict item 39 — labels on delete() / deleteMany()', () => {
  it.each([undefined, false])(
    'strict=%s: delete() ignores labels, byte-identical, and warns once',
    async (strict) => {
      const { users, records, warnings } = setup(strict);
      await users.delete(extra({ where, labels: ['Archived'] }));
      await users.delete(extra({ where, labels: ['Archived'] }));
      expect(records.map((r) => r.cypher)).toEqual([BEFORE, BEFORE]);
      expect(warnings).toEqual([
        '[OGM] User.delete() ignores the runtime "labels": it deletes every node "where" matches, ' +
          'with or without those labels. Enable `strict: true` (default in 3.0) to apply "labels" to ' +
          'the delete() MATCH, as find() and update() do.',
      ]);
    },
  );

  it('default: deleteMany() and a cascade delete() keep their Cypher; one warning per method', async () => {
    const { users, records, warnings } = setup();
    await users.deleteMany(extra({ where, labels: ['Archived'] }));
    await users.delete(
      extra({ where, delete: { posts: {} }, labels: ['Archived'] }),
    );
    expect(records.map((r) => r.cypher)).toEqual([BEFORE, BEFORE_CASCADE]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('User.deleteMany() ignores the runtime');
    expect(warnings.some((w) => w.includes('Unknown parameter'))).toBe(false);
  });

  it('default: another unknown key still warns as unknown-param, labels separately', async () => {
    const { users, warnings } = setup();
    await users.deleteMany(
      extra({ where, labels: ['Archived'], delete: { posts: {} } }),
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain(
      'Unknown parameter "delete" of User.deleteMany()',
    );
    expect(warnings[1]).toContain('ignores the runtime "labels"');
  });

  it('strict: delete(), deleteMany() and a cascade delete() match the labels', async () => {
    const { users, records, warnings } = setup(true);
    await users.delete(extra({ where, labels: ['Archived', 'Old'] }));
    await users.deleteMany(extra({ where, labels: ['Archived'] }));
    await users.delete(
      extra({ where, delete: { posts: {} }, labels: ['Archived'] }),
    );
    expect(records.map((r) => r.cypher)).toEqual([
      'MATCH (n:`User`:`Archived`:`Old`)\nWHERE n.`id` = $param0\nDETACH DELETE n',
      'MATCH (n:`User`:`Archived`)\nWHERE n.`id` = $param0\nDETACH DELETE n',
      BEFORE_CASCADE.replace('MATCH (n:`User`)', 'MATCH (n:`User`:`Archived`)'),
    ]);
    expect(warnings).toEqual([]);
  });

  it('strict: an empty or undefined labels list changes nothing', async () => {
    const { users, records } = setup(true);
    await users.delete(extra({ where, labels: [] }));
    await users.deleteMany(extra({ where, labels: undefined }));
    expect(records.map((r) => r.cypher)).toEqual([BEFORE, BEFORE]);
  });

  it.each([['Archived'], [['Arch`ived']], [[1]]])(
    'strict: invalid labels %j throw OGMError before running',
    async (labels) => {
      const { users, records } = setup(true);
      await expect(users.delete(extra({ where, labels }))).rejects.toThrow(
        OGMError,
      );
      await expect(users.deleteMany(extra({ where, labels }))).rejects.toThrow(
        OGMError,
      );
      expect(records).toEqual([]);
    },
  );
});

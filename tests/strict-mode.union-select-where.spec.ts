/**
 * v2.7.1 — typed select `where` / `orderBy` on a relationship selected under
 * a UNION parent. Each union member's relationship compiles to its own
 * `CASE` branch, which never read the `where` or the `orderBy`: every
 * related node came back, unsorted. Default mode keeps the v2.7.0 Cypher
 * (pinned in `read-ignored-inputs.byte-identical.spec.ts`) and warns once;
 * `strict: true` applies both per member, the `where` AND-ed with the
 * target's read policy. Live: `tests/integration/strict-mode.union-select-where.spec.ts`.
 */
import type { Driver } from 'neo4j-driver';
import { OGMError } from '../src/errors';
import { OGM } from '../src/ogm';
import { permissive, restrictive } from '../src/policy/types';

const typeDefs = /* GraphQL */ `
  type Tag @node {
    id: ID! @id
    name: String
    secret: Boolean
  }
  type Post @node {
    id: ID! @id
    title: String
    tags: [Tag!]! @relationship(type: "TAGGED", direction: OUT)
    cover: Tag @relationship(type: "COVER", direction: OUT)
  }
  type Video @node {
    id: ID! @id
    title: String
    tags: [Tag!]! @relationship(type: "LABELED", direction: OUT)
    cover: Tag @relationship(type: "THUMB", direction: OUT)
  }
  union Media = Post | Video
  type Feed @node {
    id: ID! @id
    items: [Media!]! @relationship(type: "HAS", direction: OUT)
  }
`;

const policies = {
  Tag: [
    permissive({ operations: ['read'], name: 'tag.read', when: () => ({}) }),
    restrictive({
      operations: ['read'],
      name: 'tag.no-secret',
      when: () => ({ secret: false }),
    }),
  ],
};

function make(opts: { strict?: boolean; policies?: boolean } = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const session = {
    run: jest.fn((cypher: string, params: Record<string, unknown>) => {
      calls.push([cypher, params]);
      return Promise.resolve({
        records: [],
        summary: { counters: { updates: () => ({}) } },
      });
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const driver = { session: () => session } as unknown as Driver;
  const logger = { debug: jest.fn(), warn: jest.fn() };
  const ogm = new OGM({
    typeDefs,
    driver,
    logger,
    ...(opts.strict ? { strict: true } : {}),
    ...(opts.policies ? { policies } : {}),
  });
  const bound = opts.policies ? ogm.withContext({}) : ogm;
  return {
    logger,
    feed: bound.model('Feed'),
    last: () => calls[calls.length - 1],
  };
}

const items = (inner: Record<string, unknown>) => ({
  select: { items: { select: { id: true, ...inner } } },
});

const TYPENAME =
  "__typename: head([__label IN labels(n0) WHERE __label IN ['Post', 'Video']])";

describe('typed select where under a union parent', () => {
  it('default: v2.7.0 Cypher, one warning', async () => {
    const { feed, logger, last } = make();
    const args = items({
      tags: { select: { name: true }, where: { name: 'a' } },
    });
    await feed.find(args as never);
    await feed.find(args as never);
    expect(last()[0]).toBe(
      'MATCH (n:`Feed`)\nRETURN n { items: [(n)-[:`HAS`]->(n0) | n0 { ' +
        `${TYPENAME}, .\`id\`, tags: CASE WHEN n0:\`Post\` THEN [(n0)-[:\`TAGGED\`]->(n1:\`Tag\`) | n1 { .\`name\` }] ` +
        'WHEN n0:`Video` THEN [(n0)-[:`LABELED`]->(n1:`Tag`) | n1 { .`name` }] ELSE [] END }] }',
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toBe(
      '[OGM] The select `where` on "tags", selected under the union "Media", is ignored in 2.x: ' +
        'every related node is returned. Enable `strict: true` (default in 3.0) to apply it to each member ' +
        "(with the target type's read policy).",
    );
  });

  it('strict: the where on every member branch', async () => {
    const { feed, logger, last } = make({ strict: true });
    await feed.find(
      items({
        tags: { select: { name: true }, where: { name: 'a' } },
      }) as never,
    );
    const [cypher, params] = last();
    expect(cypher).toContain(
      'tags: CASE WHEN n0:`Post` THEN [(n0)-[:`TAGGED`]->(n1:`Tag`) WHERE n1.`name` = $param0 | n1 { .`name` }] ' +
        'WHEN n0:`Video` THEN [(n0)-[:`LABELED`]->(n1:`Tag`) WHERE n1.`name` = $param1 | n1 { .`name` }] ELSE [] END',
    );
    expect(params).toMatchObject({ param0: 'a', param1: 'a' });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('strict: the where AND the target read policy', async () => {
    const { feed, last } = make({ strict: true, policies: true });
    await feed.find(items({ tags: { where: { name: 'a' } } }) as never);
    const [cypher] = last();
    expect(cypher).toContain(
      'tags: CASE WHEN n0:`Post` THEN [(n0)-[:`TAGGED`]->(n1:`Tag`) WHERE (n1.`name` = $param0) AND (true AND (n1.`secret` = $param1)) | ' +
        'n1 { .`id`, .`name`, .`secret` }] ' +
        'WHEN n0:`Video` THEN [(n0)-[:`LABELED`]->(n1:`Tag`) WHERE (n1.`name` = $param2) AND (true AND (n1.`secret` = $param3)) | ' +
        'n1 { .`id`, .`name`, .`secret` }] ELSE [] END',
    );
  });

  it('strict: a singular relationship where', async () => {
    const { feed, last } = make({ strict: true });
    await feed.find(
      items({
        cover: { select: { name: true }, where: { name: 'a' } },
      }) as never,
    );
    expect(last()[0]).toContain(
      'cover: CASE WHEN n0:`Post` THEN head([(n0)-[:`COVER`]->(n1:`Tag`) WHERE n1.`name` = $param0 | n1 { .`name` }]) ' +
        'WHEN n0:`Video` THEN head([(n0)-[:`THUMB`]->(n1:`Tag`) WHERE n1.`name` = $param1 | n1 { .`name` }]) ELSE null END',
    );
  });
});

describe('typed select orderBy under a union parent', () => {
  it('default: ignored, one warning', async () => {
    const { feed, logger, last } = make();
    await feed.find(
      items({
        tags: { select: { name: true }, orderBy: [{ name: 'DESC' }] },
      }) as never,
    );
    expect(last()[0]).not.toContain('sortMulti');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toContain(
      'The select `orderBy` on "tags", selected under the union "Media", is ignored in 2.x: the related nodes are not sorted.',
    );
  });

  it('strict: each member branch is sorted', async () => {
    const { feed, last } = make({ strict: true });
    await feed.find(
      items({
        tags: { select: { name: true }, orderBy: [{ name: 'DESC' }] },
      }) as never,
    );
    const cypher = last()[0];
    for (const rel of ['TAGGED', 'LABELED'])
      expect(cypher).toContain(
        `[__sk IN apoc.coll.sortMulti([(n0)-[:\`${rel}\`]->(n1:\`Tag\`) | { __node: n1 { .\`name\` }, __sk0: n1.\`name\` }], ['__sk0']) | __sk.__node]`,
      );
  });

  it('a singular relationship rejects orderBy (both modes, as before)', async () => {
    for (const strict of [false, true]) {
      const { feed } = make({ strict });
      await expect(
        feed.find(
          items({
            cover: { select: { name: true }, orderBy: [{ name: 'DESC' }] },
          }) as never,
        ),
      ).rejects.toThrow(OGMError);
    }
  });
});

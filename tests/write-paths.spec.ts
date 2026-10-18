import { Driver } from 'neo4j-driver';
import { OGMError } from '../src/errors';
import { OGM } from '../src/ogm';
import { PolicyDeniedError } from '../src/policy/errors';
import { permissive, restrictive } from '../src/policy/types';

/**
 * Compile-level regressions for nested-write inputs that produced Cypher
 * which wrote nothing (v2.4.8). The live outcomes are pinned in
 * tests/integration/write-paths.spec.ts; this suite pins the shape of the
 * Cypher and — security-critical — that every new path still carries the
 * target-policy predicate.
 */

const typeDefs = /* GraphQL */ `
  interface Pet {
    name: String
  }
  type Dog implements Pet @node {
    id: ID! @id
    name: String
    breed: String
    ownerId: String
    toys: [Tag!]! @relationship(type: "PLAYS", direction: OUT)
  }
  type Cat implements Pet @node {
    id: ID! @id
    name: String
    ownerId: String
  }
  union Media = Book | Film
  type Book @node {
    id: ID! @id
    title: String
  }
  type Film @node {
    id: ID! @id
    title: String
  }
  type Tag @node {
    id: ID! @id
    name: String
    ownerId: String
  }
  type Post @node {
    id: ID! @id
    title: String
    tags: [Tag!]! @relationship(type: "TAGGED", direction: OUT)
  }
  type Owner @node {
    id: ID! @id
    name: String
    pets: [Pet!]! @relationship(type: "OWNS", direction: OUT)
    media: [Media!]! @relationship(type: "HAS_MEDIA", direction: OUT)
    posts: [Post!]! @relationship(type: "WROTE", direction: OUT)
  }
`;

interface Recorded {
  cypher: string;
  params: Record<string, unknown>;
}

function mockDriver(recorded: Recorded[]): Driver {
  const session = {
    run: jest.fn((cypher: string, params: Record<string, unknown>) => {
      recorded.push({ cypher, params });
      return Promise.resolve({
        records: [],
        summary: {
          counters: {
            updates: () => ({
              nodesCreated: 0,
              nodesDeleted: 0,
              relationshipsCreated: 0,
              relationshipsDeleted: 0,
              propertiesSet: 0,
            }),
          },
        },
      });
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  return { session: jest.fn().mockReturnValue(session) } as unknown as Driver;
}

function plainOgm(recorded: Recorded[]): OGM {
  return new OGM({ typeDefs, driver: mockDriver(recorded) });
}

/** Owner writes open; Dog/Cat rows scoped to ownerId; Cat input checked. */
function policyOgm(recorded: Recorded[]): OGM {
  const scoped = (c: unknown) => ({ ownerId: (c as { uid: string }).uid });
  return new OGM({
    typeDefs,
    driver: mockDriver(recorded),
    policies: {
      Owner: [
        permissive({
          operations: ['read', 'create', 'update'],
          when: () => ({}),
        }),
      ],
      Dog: [
        permissive({
          operations: ['read', 'update', 'delete', 'create'],
          when: scoped,
        }),
      ],
      Cat: [
        permissive({
          operations: ['read', 'update', 'create'],
          when: scoped,
        }),
        // WITH CHECK: a Cat may never be named 'forbidden'.
        restrictive({
          name: 'no-forbidden-cat',
          operations: ['create', 'update'],
          when: (_c, input) => input.name !== 'forbidden',
        }),
      ],
      Tag: [permissive({ operations: ['read'], when: scoped })],
    },
  });
}

describe('interface relationships inside create / update (v2.4.8)', () => {
  it('create: a nested connect matches the implementers by their own labels', async () => {
    const recorded: Recorded[] = [];
    await plainOgm(recorded)
      .model('Owner')
      .create({
        input: [
          {
            name: 'o',
            pets: { connect: [{ where: { node: { name: 'Rex' } } }] },
          },
        ],
      });
    const { cypher } = recorded[0];
    expect(cypher).toContain('MATCH (n_cn0)');
    expect(cypher).toContain(
      'WHERE (n_cn0:`Dog` OR n_cn0:`Cat`) AND n_cn0.`name` = $param0',
    );
    expect(cypher).not.toContain(':`Pet`');
  });

  it('create: a flat nested create dispatches to the named implementer', async () => {
    const recorded: Recorded[] = [];
    await plainOgm(recorded)
      .model('Owner')
      .create({
        input: [
          {
            name: 'o',
            pets: {
              create: [{ node: { Dog: { name: 'Rex', breed: 'lab' } } }],
            },
          },
        ],
      });
    const { cypher, params } = recorded[0];
    expect(cypher).toContain(
      'CREATE (n_c0:`Dog` { `id`: randomUUID(), `name`: $create0_pets_create0_name, `breed`: $create0_pets_create0_breed })',
    );
    expect(cypher).toContain('CREATE (n)-[:`OWNS`]->(n_c0)');
    expect(params.create0_pets_create0_breed).toBe('lab');
  });

  it('create: a flat nested create without exactly one implementer key throws', async () => {
    const recorded: Recorded[] = [];
    const Owner = plainOgm(recorded).model('Owner');
    for (const node of [{ name: 'x' }, { Dog: {}, Cat: {} }, { Fish: {} }])
      await expect(() =>
        Owner.create({ input: [{ pets: { create: [{ node }] } }] }),
      ).rejects.toThrow(OGMError);
  });

  it('update: flat nested ops on an interface relationship all compile', async () => {
    const recorded: Recorded[] = [];
    await plainOgm(recorded)
      .model('Owner')
      .update({
        where: { name: 'o' },
        update: {
          pets: [
            { disconnect: [{ where: { node: { name: 'a' } } }] },
            { connect: [{ where: { node: { name: 'b' } } }] },
            {
              where: { node: { name: 'c' } },
              update: { node: { name: 'c2' } },
            },
            { delete: [{ where: { node: { name: 'd' } } }] },
            { create: [{ node: { Cat: { name: 'e' } } }] },
          ],
        },
      });
    const { cypher } = recorded[0];
    expect(cypher).toContain(
      'OPTIONAL MATCH (n)-[r_disc_pets_0_0:`OWNS`]->(n_disc0)',
    );
    expect(cypher).toContain('WHERE (n_conn1:`Dog` OR n_conn1:`Cat`)');
    expect(cypher).toContain('MATCH (n)-[r_pets_2:`OWNS`]->(n_u2)');
    expect(cypher).toContain('SET n_u2.`name` = $update_pets_2_set_name');
    expect(cypher).toContain('CREATE (n_cr4:`Cat`');
    expect(cypher).not.toContain(':`Pet`');
  });

  it('update: per-member interface input dispatches like a union', async () => {
    const recorded: Recorded[] = [];
    await plainOgm(recorded)
      .model('Owner')
      .update({
        where: { name: 'o' },
        update: {
          pets: { Dog: [{ connect: [{ where: { node: { name: 'b' } } }] }] },
        },
      });
    expect(recorded[0].cypher).toContain('MATCH (n_conn0:`Dog`)');
  });

  it('mixing member keys with operation keys throws', async () => {
    const recorded: Recorded[] = [];
    await expect(() =>
      plainOgm(recorded)
        .model('Owner')
        .update({
          update: { pets: { Dog: [{}], connect: [{}] } },
        }),
    ).rejects.toThrow(OGMError);
  });

  it('a flat key on a union relationship throws instead of being ignored', async () => {
    const recorded: Recorded[] = [];
    await expect(() =>
      plainOgm(recorded)
        .model('Owner')
        .update({
          update: {
            media: [{ connect: [{ where: { node: { title: 'x' } } }] }],
          },
        }),
    ).rejects.toThrow(/key its nested input by member type|Unknown key/);
  });

  it('a per-member union blanket disconnect keeps the member label', async () => {
    const recorded: Recorded[] = [];
    await plainOgm(recorded)
      .model('Owner')
      .update({
        where: { name: 'o' },
        update: { media: { Book: [{ disconnect: [{}] }] } },
      });
    expect(recorded[0].cypher).toContain(
      'OPTIONAL MATCH (n)-[r_disc_media_0_0:`HAS_MEDIA`]->(:`Book`)',
    );
  });

  describe('target policies', () => {
    it('a flat nested connect applies every implementer policy (CASE)', async () => {
      const recorded: Recorded[] = [];
      await policyOgm(recorded)
        .withContext({ uid: 'u1' })
        .model('Owner')
        .update({
          where: { name: 'o' },
          update: {
            pets: [{ connect: [{ where: { node: { name: 'b' } } }] }],
          },
        });
      const { cypher } = recorded[0];
      expect(cypher).toMatch(
        /WHERE \(n_conn0:`Dog` OR n_conn0:`Cat`\) AND n_conn0\.`name` = \$param\d+ AND \(CASE WHEN n_conn0:`Dog` THEN \(n_conn0\.`ownerId` = \$param\d+\) WHEN n_conn0:`Cat` THEN \(n_conn0\.`ownerId` = \$param\d+\) ELSE false END\)/,
      );
    });

    it('a flat nested update applies every implementer update policy', async () => {
      const recorded: Recorded[] = [];
      await policyOgm(recorded)
        .withContext({ uid: 'u1' })
        .model('Owner')
        .update({
          where: { name: 'o' },
          update: {
            pets: [
              {
                where: { node: { name: 'c' } },
                update: { node: { name: 'c2' } },
              },
            ],
          },
        });
      expect(recorded[0].cypher).toMatch(
        /\(CASE WHEN n_u0:`Dog` THEN \(n_u0\.`ownerId` = \$param\d+\) WHEN n_u0:`Cat` THEN \(n_u0\.`ownerId` = \$param\d+\) ELSE false END\)/,
      );
    });

    it("a flat nested create is checked against the implementer's create policy", async () => {
      const recorded: Recorded[] = [];
      await expect(() =>
        policyOgm(recorded)
          .withContext({ uid: 'u1' })
          .model('Owner')
          .create({
            input: [
              { pets: { create: [{ node: { Cat: { name: 'forbidden' } } }] } },
            ],
          }),
      ).rejects.toThrow(PolicyDeniedError);
      expect(recorded).toHaveLength(0);
    });

    it('a per-member interface nested create is checked against that member', async () => {
      const recorded: Recorded[] = [];
      await expect(() =>
        policyOgm(recorded)
          .withContext({ uid: 'u1' })
          .model('Owner')
          .create({
            input: [
              { pets: { Cat: { create: [{ node: { name: 'forbidden' } }] } } },
            ],
          }),
      ).rejects.toThrow(PolicyDeniedError);
    });

    it('a flat nested update must pass EVERY implementer write restrictive', async () => {
      const recorded: Recorded[] = [];
      // It may reach a Cat, so the Cat WITH CHECK applies.
      await expect(() =>
        policyOgm(recorded)
          .withContext({ uid: 'u1' })
          .model('Owner')
          .update({
            update: {
              pets: [{ update: { node: { name: 'forbidden' } } }],
            },
          }),
      ).rejects.toThrow(PolicyDeniedError);
      expect(recorded).toHaveLength(0);
    });
  });
});

describe('top-level connect / disconnect on abstract relationships (v2.4.8)', () => {
  it('a flat interface connect matches implementer labels, never the interface label', async () => {
    const recorded: Recorded[] = [];
    await plainOgm(recorded)
      .model('Owner')
      .update({
        where: { name: 'o' },
        connect: { pets: [{ where: { node: { name: 'Rex' } } }] },
      });
    const { cypher } = recorded[0];
    expect(cypher).toContain('MATCH (target_pets_0)');
    expect(cypher).toContain(
      'WHERE (target_pets_0:`Dog` OR target_pets_0:`Cat`) AND target_pets_0.`name` = $param1',
    );
    expect(cypher).not.toContain(':`Pet`');
  });

  it('a per-member union connect unwraps { Member: { where } } and keeps the filter', async () => {
    const recorded: Recorded[] = [];
    await plainOgm(recorded)
      .model('Owner')
      .update({
        where: { name: 'o' },
        connect: { media: { Book: { where: { node: { title: 'x' } } } } },
      });
    const { cypher, params } = recorded[0];
    // Pre-2.4.8: `MATCH (target:\`Media\`)` with NO WHERE at all.
    expect(cypher).toContain('MATCH (target:`Book`)');
    expect(cypher).toContain('WHERE target.`title` = $param1');
    expect(cypher).toContain('RETURN count(*) AS _conn_media_Book');
    expect(params.param1).toBe('x');
    expect(cypher).not.toContain(':`Media`');
  });

  it('per-member array connects for two members get distinct names', async () => {
    const recorded: Recorded[] = [];
    await plainOgm(recorded)
      .model('Owner')
      .update({
        where: { name: 'o' },
        connect: {
          media: {
            Book: [{ where: { node: { title: 'b' } } }],
            Film: [{ where: { node: { title: 'f' } } }],
          },
        },
      });
    const { cypher } = recorded[0];
    expect(cypher).toContain('UNWIND $connect_media_Book AS connItem');
    expect(cypher).toContain('UNWIND $connect_media_Film AS connItem');
    expect(cypher).toContain('MATCH (target:`Film`)');
  });

  it('interface / union disconnects match the member, not the abstract label', async () => {
    const recorded: Recorded[] = [];
    await plainOgm(recorded)
      .model('Owner')
      .update({
        where: { name: 'o' },
        disconnect: {
          pets: [{ where: { node: { name: 'Rex' } } }],
          media: { Film: [{ where: { node: { title: 'f' } } }] },
        },
      });
    const { cypher } = recorded[0];
    expect(cypher).toContain(
      'OPTIONAL MATCH (n)-[r_pets_0:`OWNS`]->(target_pets_0)\nWHERE (target_pets_0:`Dog` OR target_pets_0:`Cat`) AND',
    );
    expect(cypher).toContain(
      'OPTIONAL MATCH (n)-[r_media_Film_0:`HAS_MEDIA`]->(target_media_Film_0:`Film`)',
    );
    expect(cypher).not.toMatch(/:`(Pet|Media)`/);
  });

  it('a blanket abstract disconnect ({} / null) still unlinks the whole relationship', async () => {
    const recorded: Recorded[] = [];
    await plainOgm(recorded)
      .model('Owner')
      .update({ where: { name: 'o' }, disconnect: { media: {}, pets: null } });
    const { cypher } = recorded[0];
    expect(cypher).toContain('OPTIONAL MATCH (n)-[r_media_0:`HAS_MEDIA`]->()');
    expect(cypher).toContain('OPTIONAL MATCH (n)-[r_pets_0:`OWNS`]->()');
  });

  it('a flat union connect throws instead of matching a label no node has', async () => {
    const recorded: Recorded[] = [];
    await expect(() =>
      plainOgm(recorded)
        .model('Owner')
        .update({ connect: { media: [{ where: { node: { title: 'x' } } }] } }),
    ).rejects.toThrow(OGMError);
  });

  describe('target policies', () => {
    it('a flat interface connect applies every implementer read policy', async () => {
      const recorded: Recorded[] = [];
      await policyOgm(recorded)
        .withContext({ uid: 'u1' })
        .model('Owner')
        .update({
          where: { name: 'o' },
          connect: { pets: [{ where: { node: { name: 'Rex' } } }] },
        });
      expect(recorded[0].cypher).toMatch(
        /\(CASE WHEN target_pets_0:`Dog` THEN \(target_pets_0\.`ownerId` = \$param\d+\) WHEN target_pets_0:`Cat` THEN \(target_pets_0\.`ownerId` = \$param\d+\) ELSE false END\)/,
      );
    });

    it("a per-member connect / disconnect applies that member's read policy", async () => {
      const recorded: Recorded[] = [];
      await policyOgm(recorded)
        .withContext({ uid: 'u1' })
        .model('Owner')
        .update({
          where: { name: 'o' },
          connect: { pets: { Dog: { where: { node: { name: 'Rex' } } } } },
          disconnect: { pets: { Cat: [{ where: { node: { name: 'Tom' } } }] } },
        });
      const { cypher } = recorded[0];
      expect(cypher).toMatch(
        /MATCH \(target:`Dog`\)\nWHERE target\.`name` = \$param\d+ AND \(target\.`ownerId` = \$param\d+\)/,
      );
      expect(cypher).toMatch(
        /target_pets_Cat_0\.`name` = \$param\d+ AND \(target_pets_Cat_0\.`ownerId` = \$param\d+\)/,
      );
    });
  });
});

describe('array connect with a bare-property where (v2.4.8)', () => {
  it('binds each item under where.node, the path the UNWIND WHERE reads', async () => {
    const recorded: Recorded[] = [];
    await plainOgm(recorded)
      .model('Owner')
      .update({
        where: { name: 'o' },
        connect: {
          posts: [{ where: { title: 'a' } }, { where: { title: 'b' } }],
        },
      });
    const { cypher, params } = recorded[0];
    expect(cypher).toContain('UNWIND $connect_posts AS connItem');
    expect(cypher).toContain(
      'WHERE target.`title` = connItem.where.node.title',
    );
    expect(params.connect_posts).toEqual([
      { where: { node: { title: 'a' } } },
      { where: { node: { title: 'b' } } },
    ]);
  });

  it('leaves the { node } shape untouched', async () => {
    const recorded: Recorded[] = [];
    await plainOgm(recorded)
      .model('Owner')
      .update({
        where: { name: 'o' },
        connect: { posts: [{ where: { node: { title: 'a' } } }] },
      });
    expect(recorded[0].params.connect_posts).toEqual([
      { where: { node: { title: 'a' } } },
    ]);
  });
});

describe('connect / disconnect nested in a connect / disconnect item (v2.4.8)', () => {
  it('update.connect: the nested connect links the connected node, inside its CALL', async () => {
    const recorded: Recorded[] = [];
    await plainOgm(recorded)
      .model('Owner')
      .update({
        where: { name: 'o' },
        connect: {
          posts: [
            {
              where: { node: { title: 'p' } },
              connect: [{ tags: [{ where: { node: { name: 't' } } }] }],
            },
          ],
        },
      });
    const { cypher } = recorded[0];
    // A connect item with a nested connect never takes the UNWIND path.
    expect(cypher).not.toContain('UNWIND $connect_posts');
    expect(cypher).toContain(
      [
        'MERGE (n)-[:`WROTE`]->(target_posts_0)',
        'WITH n, target_posts_0',
        'CALL {',
        'WITH n, target_posts_0',
        'UNWIND $target_posts_0_connect_tags AS connItem',
        'MATCH (target_posts_0_target:`Tag`)',
        'WHERE target_posts_0_target.`name` = connItem.where.node.name',
        'MERGE (target_posts_0)-[:`TAGGED`]->(target_posts_0_target)',
        'RETURN count(*) AS _conn_target_posts_0_tags',
        '}',
        'RETURN count(*) AS _ccn_posts_0',
        '}',
      ].join('\n'),
    );
  });

  it('create and nested-update connects accept a nested connect too', async () => {
    const recorded: Recorded[] = [];
    const Owner = plainOgm(recorded).model('Owner');
    const nestedConnect = {
      where: { node: { title: 'p' } },
      connect: { tags: { where: { node: { name: 't' } } } },
    };
    await Owner.create({ input: [{ posts: { connect: [nestedConnect] } }] });
    await Owner.update({
      where: { name: 'o' },
      update: { posts: [{ connect: [nestedConnect] }] },
    });
    expect(recorded[0].cypher).toContain(
      'MERGE (n_cn0)-[:`TAGGED`]->(n_cn0_target)',
    );
    expect(recorded[1].cypher).toContain(
      'MERGE (n_conn0)-[:`TAGGED`]->(n_conn0_target)',
    );
  });

  it('update.disconnect: the nested disconnect unlinks the disconnected node onward', async () => {
    const recorded: Recorded[] = [];
    await plainOgm(recorded)
      .model('Owner')
      .update({
        where: { name: 'o' },
        disconnect: {
          posts: [
            {
              where: { node: { title: 'p' } },
              disconnect: { tags: [{ where: { node: { name: 't' } } }] },
            },
          ],
        },
      });
    expect(recorded[0].cypher).toContain(
      [
        'DELETE r_posts_0',
        'WITH n, target_posts_0',
        'CALL {',
        'WITH n, target_posts_0',
        'OPTIONAL MATCH (target_posts_0)-[target_posts_0_r_tags_0:`TAGGED`]->(target_posts_0_target_tags_0:`Tag`)',
        'WHERE target_posts_0_target_tags_0.`name` = $param2',
        'DELETE target_posts_0_r_tags_0',
        'RETURN count(*) AS _target_posts_0_r_tags_0',
        '}',
        'RETURN count(*) AS _r_posts_0',
      ].join('\n'),
    );
  });

  it('nested update: a disconnect item with only a nested disconnect binds its target', async () => {
    const recorded: Recorded[] = [];
    await plainOgm(recorded)
      .model('Owner')
      .update({
        where: { name: 'o' },
        update: {
          posts: [{ disconnect: [{ disconnect: { tags: [{}] } }] }],
        },
      });
    const { cypher } = recorded[0];
    expect(cypher).toContain(
      'OPTIONAL MATCH (n)-[r_disc_posts_0_0:`WROTE`]->(n_disc0:`Post`)',
    );
    expect(cypher).toContain(
      'OPTIONAL MATCH (n_disc0)-[n_disc0_r_tags_0:`TAGGED`]->()',
    );
  });

  it('a nested connect / disconnect under a flat interface relationship throws', async () => {
    const recorded: Recorded[] = [];
    const Owner = plainOgm(recorded).model('Owner');
    await expect(() =>
      Owner.update({
        connect: { pets: [{ where: {}, connect: [{ toys: [] }] }] },
      }),
    ).rejects.toThrow(OGMError);
    await expect(() =>
      Owner.update({
        disconnect: { pets: [{ where: {}, disconnect: { toys: [] } }] },
      }),
    ).rejects.toThrow(OGMError);
  });

  describe('target policies', () => {
    it('every level of a nested connect carries its own target read policy', async () => {
      const recorded: Recorded[] = [];
      await policyOgm(recorded)
        .withContext({ uid: 'u1' })
        .model('Owner')
        .update({
          where: { name: 'o' },
          connect: {
            pets: {
              Dog: [
                {
                  where: { node: { name: 'Rex' } },
                  connect: [{ toys: [{ where: { node: { name: 'ball' } } }] }],
                },
              ],
            },
            posts: [
              {
                where: { node: { title: 'p' } },
                connect: [{ tags: [{ where: { node: { name: 't' } } }] }],
              },
            ],
          },
        });
      const { cypher } = recorded[0];
      expect(cypher).toMatch(
        /target_pets_Dog_0\.`name` = \$param\d+ AND \(target_pets_Dog_0\.`ownerId` = \$param\d+\)/,
      );
      expect(cypher).toMatch(
        /WHERE target_posts_0_target\.`name` = connItem\.where\.node\.name AND \(target_posts_0_target\.`ownerId` = \$param\d+\)/,
      );
    });

    it('a nested disconnect carries the deeper target read policy', async () => {
      const recorded: Recorded[] = [];
      await policyOgm(recorded)
        .withContext({ uid: 'u1' })
        .model('Owner')
        .update({
          where: { name: 'o' },
          disconnect: {
            posts: [{ where: {}, disconnect: { tags: [{}] } }],
          },
        });
      expect(recorded[0].cypher).toMatch(
        /OPTIONAL MATCH \(target_posts_0\)-\[target_posts_0_r_tags_0:`TAGGED`\]->\(target_posts_0_target_tags_0\)\nWHERE \(target_posts_0_target_tags_0\.`ownerId` = \$param\d+\)/,
      );
    });
  });
});

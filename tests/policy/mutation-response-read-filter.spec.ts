/**
 * v2.6.1 — mutation responses apply the root type's `read` policy (finding
 * F6). Pre-2.6.1 create / update / upsert returned every node they wrote,
 * so a context allowed to update (or create) a node it could not read got
 * it back in full. The write still happens; the row is just not returned.
 * The live outcome is pinned in `tests/integration/nls-enforcement.spec.ts`;
 * this suite pins the emitted clause shape.
 */
import { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { override, permissive, restrictive } from '../../src/policy/types';

const schema = `
type Book @node {
  id: ID! @id @unique
  title: String!
  ownerId: String
  secret: Boolean
  hidden: Boolean @cypher(statement: "RETURN this.secret AS h", columnName: "h")
}
`;

interface Recorded {
  cypher: string;
  params: Record<string, unknown>;
}

function createMockDriver(records: Recorded[]): Driver {
  const session = {
    run: jest.fn((cypher: string, params: Record<string, unknown>) => {
      records.push({ cypher, params });
      return Promise.resolve({
        records: [],
        summary: {
          counters: {
            updates: () => ({
              nodesCreated: 0,
              nodesDeleted: 0,
              relationshipsCreated: 0,
              relationshipsDeleted: 0,
            }),
          },
        },
      });
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  return { session: jest.fn().mockReturnValue(session) } as unknown as Driver;
}

const readAll = permissive({ operations: ['read'], when: () => ({}) });
const noSecret = restrictive({
  operations: ['read'],
  when: () => ({ secret: false }),
});
const writeAll = permissive({
  operations: ['create', 'update'],
  when: () => ({}),
});

function build(policies: Record<string, unknown[]> | undefined) {
  const recorded: Recorded[] = [];
  const ogm = new OGM({
    typeDefs: schema,
    driver: createMockDriver(recorded),
    ...(policies ? { policies: policies as never } : {}),
  });
  return { ogm, recorded };
}

const READ_FILTER = 'WITH n\nWHERE (true AND (n.`secret` = $param';

describe('v2.6.1 — mutation responses apply the root read policy', () => {
  it('update: the read clause filters the rows before the projection', async () => {
    const { ogm, recorded } = build({ Book: [readAll, noSecret, writeAll] });
    await ogm
      .withContext({})
      .model('Book')
      .update({
        where: { id: 'b1' },
        update: { title: 'y' },
        selectionSet: '{ id }',
      });
    expect(recorded[0].cypher).toBe(
      [
        'MATCH (n:`Book`)',
        'WHERE (n.`id` = $param0) AND true',
        'SET n.`title` = $update_title',
        'WITH n',
        'WHERE (true AND (n.`secret` = $param1))',
        'RETURN n { .`id` }',
      ].join('\n'),
    );
    expect(recorded[0].params).toMatchObject({ param0: 'b1', param1: false });
  });

  it('create: every created row is filtered after the re-binding UNWIND', async () => {
    const { ogm, recorded } = build({ Book: [readAll, noSecret, writeAll] });
    await ogm
      .withContext({})
      .model('Book')
      .create({
        input: [{ title: 'x' }, { title: 'z' }],
        selectionSet: '{ id }',
      });
    expect(recorded[0].cypher).toBe(
      [
        'CREATE (n:`Book` { `id`: randomUUID(), `title`: $create0_title })',
        'CREATE (n_1:`Book` { `id`: randomUUID(), `title`: $create1_title })',
        'WITH [n, n_1] AS __created',
        'UNWIND __created AS n',
        'WITH n',
        'WHERE (true AND (n.`secret` = $param0))',
        'RETURN n { .`id` }',
      ].join('\n'),
    );
  });

  it('upsert: the read clause runs after the write, before the projection', async () => {
    const { ogm, recorded } = build({ Book: [readAll, noSecret, writeAll] });
    await ogm
      .withContext({})
      .model('Book')
      .upsert({
        where: { id: 'b1' },
        create: { title: 'x' },
        update: { title: 'y' },
        selectionSet: '{ id }',
      });
    expect(recorded[0].cypher).toMatch(
      /\nWITH n\nWHERE \(true AND \(n\.`secret` = \$param\d+\)\)\nRETURN n \{ \.`id` \}$/,
    );
  });

  it('applies to the typed select path, the default selection and info-only selects', async () => {
    const { ogm, recorded } = build({ Book: [readAll, noSecret, writeAll] });
    const m = ogm.withContext({}).model('Book');
    await m.update({
      where: { id: 'b1' },
      update: {},
      select: { books: { id: true } },
    });
    await m.update({ where: { id: 'b1' }, update: {} });
    await m.update({
      where: { id: 'b1' },
      update: {},
      select: { info: { nodesCreated: true } },
    });
    await m.upsert({
      where: { id: 'b1' },
      create: { title: 'x' },
      update: {},
      select: { id: true },
    });
    for (const r of recorded) expect(r.cypher).toContain(READ_FILTER);
  });

  it('stitches the read clause @cypher preludes after a WITH, ahead of the selection preludes', async () => {
    const { ogm, recorded } = build({
      Book: [
        readAll,
        restrictive({ operations: ['read'], when: () => ({ hidden: false }) }),
        writeAll,
      ],
    });
    await ogm
      .withContext({})
      .model('Book')
      .update({
        where: { id: 'b1' },
        update: { title: 'y' },
        selectionSet: '{ id hidden }',
      });
    const tail = recorded[0].cypher.split('SET n.`title` = $update_title\n')[1];
    expect(tail).toMatch(
      /^WITH n\nCALL \{[\s\S]*\}\nWITH n, __where_n_hidden\nWHERE \(true AND \(__where_n_hidden = \$param\d+\)\)\nWITH n\nCALL \{[\s\S]*\}\nWITH n, __sel_n_hidden\nRETURN /,
    );
  });

  it('a type without a read policy, an override, a bypass and an unbound OGM emit unchanged Cypher', async () => {
    const args = {
      where: { id: 'b1' },
      update: { title: 'y' },
      selectionSet: '{ id }',
    };
    const plain = build(undefined);
    await plain.ogm.model('Book').update(args);
    const expected = plain.recorded[0].cypher;
    expect(expected).not.toContain('WITH n');

    const noRead = build({ Book: [writeAll] });
    await noRead.ogm.withContext({}).model('Book').update(args);

    const overridden = build({
      Book: [
        readAll,
        noSecret,
        writeAll,
        override({ operations: ['read'], when: () => true }),
      ],
    });
    await overridden.ogm.withContext({}).model('Book').update(args);

    const bypassed = build({ Book: [readAll, noSecret, writeAll] });
    await bypassed.ogm
      .withContext({})
      .model('Book')
      .update({ ...args, unsafe: { bypassPolicies: true } });

    // The bypass and the unbound OGM emit no policy at all; the other two
    // keep the update row filter (`AND true`) and add no read filter.
    expect(bypassed.recorded[0].cypher).toBe(expected);
    const withUpdateFilter = expected.replace(
      'WHERE n.`id` = $param0',
      'WHERE (n.`id` = $param0) AND true',
    );
    expect(noRead.recorded[0].cypher).toBe(withUpdateFilter);
    expect(overridden.recorded[0].cypher).toBe(withUpdateFilter);
  });

  it('no read permissive applies: the response is empty (`false`), the write still runs', async () => {
    const { ogm, recorded } = build({
      Book: [
        permissive({
          operations: ['read'],
          appliesWhen: () => false,
          when: () => ({}),
        }),
        writeAll,
      ],
    });
    await ogm
      .withContext({})
      .model('Book')
      .update({ where: { id: 'b1' }, update: { title: 'y' } });
    expect(recorded[0].cypher).toContain(
      'SET n.`title` = $update_title\nWITH n\nWHERE false\nRETURN',
    );
  });

  it('updateMany, createMany and delete return no rows and are unchanged', async () => {
    const bound = build({
      Book: [
        readAll,
        noSecret,
        writeAll,
        permissive({ operations: ['delete'], when: () => ({}) }),
      ],
    });
    const m = bound.ogm.withContext({}).model('Book');
    await m.updateMany({ where: { id: 'b1' }, data: { title: 'y' } });
    await m.createMany({ data: [{ title: 'x' }] });
    await m.delete({ where: { id: 'b1' } });
    for (const r of bound.recorded) expect(r.cypher).not.toContain('secret');
  });
});

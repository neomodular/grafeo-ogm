import type { Driver, Session, Transaction } from 'neo4j-driver';
import { OGM } from '../src/ogm';
import { permissive } from '../src/policy/types';

/**
 * v2.4.8 — `OGMConfig.database`. Pre-2.4.8 every session the OGM opened
 * targeted the driver's default database, with no way to choose another
 * (so `grafeo db seed --database x` seeded the default DB).
 */

const typeDefs = `
type Book @node @fulltext(indexes: [{ name: "BookSearch", fields: ["title"] }]) {
  id: ID! @id @unique
  title: String!
  ownerId: String
}
`;

function mockDriver(): { driver: Driver; session: Session } {
  const tx = {
    run: jest.fn().mockResolvedValue({ records: [] }),
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
  } as unknown as Transaction;
  const session = {
    run: jest.fn().mockResolvedValue({
      records: [],
      summary: { counters: { updates: () => ({}) } },
    }),
    beginTransaction: jest.fn().mockReturnValue(tx),
    close: jest.fn().mockResolvedValue(undefined),
  } as unknown as Session;
  const driver = {
    session: jest.fn().mockReturnValue(session),
    close: jest.fn().mockResolvedValue(undefined),
  } as unknown as Driver;
  return { driver, session };
}

const sessionArgs = (driver: Driver) =>
  (driver.session as jest.Mock).mock.calls.map((c) => c[0]);

describe('OGMConfig.database', () => {
  it('routes every session the OGM opens to the configured database', async () => {
    const { driver } = mockDriver();
    const ogm = new OGM({ typeDefs, driver, database: 'la_db' });

    await ogm.model('Book').find({});
    await ogm.model('Book').count();
    await ogm.$queryRaw('RETURN 1');
    await ogm.$executeRaw('RETURN 1');
    await ogm.$transaction(async () => 1);
    await ogm.assertIndexesAndConstraints({ options: { create: true } });

    const args = sessionArgs(driver);
    expect(args.length).toBeGreaterThanOrEqual(6);
    for (const a of args) expect(a).toEqual({ database: 'la_db' });
  });

  it('applies to withContext models, interface models and bypassed clones', async () => {
    const { driver } = mockDriver();
    const ogm = new OGM({
      typeDefs:
        typeDefs +
        'interface Thing { id: ID! }\ntype Gadget implements Thing @node { id: ID! }',
      driver,
      database: 'la_db',
      policies: {
        Book: [
          permissive({
            operations: ['read'],
            when: () => ({ ownerId: 'u' }),
            name: 'p',
          }),
        ],
      },
    });

    await ogm.withContext({ uid: 'a' }).model('Book').find({});
    await ogm.interfaceModel('Thing').find({});
    await ogm.unsafe.bypassPolicies().model('Book').find({});

    for (const a of sessionArgs(driver))
      expect(a).toEqual({ database: 'la_db' });
  });

  it('keeps an access mode the executor asks for', async () => {
    const { driver } = mockDriver();
    const ogm = new OGM({
      typeDefs,
      driver,
      database: 'la_db',
      policies: {
        Book: [
          permissive({
            operations: ['read'],
            when: () => ({ ownerId: 'u' }),
            name: 'p',
          }),
        ],
      },
    });
    await ogm
      .withContext({ uid: 'a' })
      .model('Book')
      .explainPolicies({ select: { id: true } });
    expect(sessionArgs(driver)).toContainEqual({
      database: 'la_db',
      defaultAccessMode: 'READ',
    });
  });

  it('without database, sessions open exactly as before (no-arg session())', async () => {
    const { driver } = mockDriver();
    const ogm = new OGM({ typeDefs, driver });

    await ogm.model('Book').find({});
    await ogm.$queryRaw('RETURN 1');
    await ogm.$transaction(async () => 1);

    for (const a of sessionArgs(driver)) expect(a).toBeUndefined();
  });

  it('rejects an empty database name', () => {
    const { driver } = mockDriver();
    expect(() => new OGM({ typeDefs, driver, database: '' })).toThrow(
      /database/,
    );
  });
});

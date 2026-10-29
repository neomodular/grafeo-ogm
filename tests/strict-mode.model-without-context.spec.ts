/**
 * v2.24.0 — strict item 50: on an OGM configured with `policies`, a model
 * from a bare `ogm.model()` / `ogm.interfaceModel()` (no `withContext`)
 * applies no policy. Default mode keeps that, byte-identical, and warns
 * once per OGM and type (`model-without-context`); strict mode throws
 * `OGMError` from the lookup. The `unsafe.bypassPolicies()` clone, the
 * `withContext` path and OGMs without policies never warn or throw.
 */
import { OGMError } from '../src/errors';
import { OGM } from '../src/ogm';
import { permissive } from '../src/policy/types';
import { Recorded, recordingDriver } from './strict-mode.writes.cases';

const typeDefs = /* GraphQL */ `
  interface Thing {
    id: ID!
  }
  type Doc implements Thing @node {
    id: ID! @unique
    tenant: String
  }
  type Note implements Thing @node {
    id: ID! @unique
  }
`;

const policies = {
  Doc: [
    permissive({
      operations: ['read'],
      name: 'doc.tenant',
      when: () => ({ tenant: 't1' }),
    }),
  ],
};

function build(opts: {
  strict?: boolean;
  policies?: unknown;
  records?: Recorded[];
}) {
  const warn = jest.fn();
  const ogm = new OGM({
    typeDefs,
    driver: recordingDriver(opts.records ?? []),
    logger: { debug: () => {}, warn },
    ...(opts.policies === undefined
      ? {}
      : { policies: opts.policies as never }),
    ...(opts.strict === undefined ? {} : { strict: opts.strict }),
  });
  const item50 = () =>
    warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('applies no policy'));
  return { ogm, warn, item50 };
}

describe('strict item 50 — default mode', () => {
  it('warns once per OGM and type, naming withContext and bypassPolicies', () => {
    const { ogm, item50 } = build({ policies });
    ogm.model('Doc');
    ogm.model('Doc');
    expect(item50()).toHaveLength(1);
    const [msg] = item50();
    expect(msg).toContain(
      "ogm.model('Doc') on an OGM configured with `policies`",
    );
    expect(msg).toContain("ogm.withContext(ctx).model('Doc')");
    expect(msg).toContain("ogm.unsafe.bypassPolicies().model('Doc')");
    expect(msg).toContain('Enable `strict: true` (default in 3.0)');
    ogm.model('Note');
    ogm.interfaceModel('Thing');
    ogm.interfaceModel('Thing');
    expect(item50()).toHaveLength(3);
    expect(item50()[2]).toContain("ogm.interfaceModel('Thing')");
    // a second OGM warns again
    const other = build({ policies });
    other.ogm.model('Doc');
    expect(other.item50()).toHaveLength(1);
  });

  it('keeps the Cypher of a policy-free OGM (no policy applied)', async () => {
    const a: Recorded[] = [];
    const b: Recorded[] = [];
    await build({ records: a })
      .ogm.model('Doc')
      .find({ where: { id: 'x' } });
    await build({ policies, records: b })
      .ogm.model('Doc')
      .find({ where: { id: 'x' } });
    expect(b).toEqual(a);
  });

  it.each([
    ['no policies', undefined],
    ['an empty policies map', {}],
    ['only empty policy arrays', { Doc: [] }],
  ])('does not warn with %s', (_n, p) => {
    const { ogm, warn } = build({ policies: p });
    ogm.model('Doc');
    ogm.interfaceModel('Thing');
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn through withContext or bypassPolicies', () => {
    const { ogm, item50 } = build({ policies });
    ogm.withContext({}).model('Doc');
    ogm.withContext({}).interfaceModel('Thing');
    ogm.unsafe.bypassPolicies().model('Doc');
    ogm.unsafe.bypassPolicies().interfaceModel('Thing');
    expect(item50()).toEqual([]);
  });
});

describe('strict item 50 — strict mode', () => {
  it('throws OGMError from model() and interfaceModel()', () => {
    const { ogm, warn } = build({ policies, strict: true });
    expect(() => ogm.model('Doc')).toThrow(OGMError);
    expect(() => ogm.model('Note')).toThrow(
      /ogm\.model\('Note'\) on an OGM configured with `policies` applies no policy/,
    );
    expect(() => ogm.interfaceModel('Thing')).toThrow(
      /ogm\.withContext\(ctx\)\.interfaceModel\('Thing'\)/,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('allows withContext, the bypassed clone and policy-free OGMs', () => {
    const { ogm } = build({ policies, strict: true });
    expect(() => ogm.withContext({}).model('Doc')).not.toThrow();
    expect(() => ogm.withContext({}).interfaceModel('Thing')).not.toThrow();
    const bypassed = ogm.unsafe.bypassPolicies();
    expect(() => bypassed.model('Doc')).not.toThrow();
    expect(() => bypassed.interfaceModel('Thing')).not.toThrow();
    const free = build({ strict: true }).ogm;
    expect(() => free.model('Doc')).not.toThrow();
    expect(() => free.interfaceModel('Thing')).not.toThrow();
  });

  it('still reports an unknown or misnamed type first-class', () => {
    for (const o of [
      build({ strict: true }),
      build({ policies, strict: true }),
    ]) {
      expect(() => o.ogm.model('Nope')).toThrow(/Unknown type: Nope/);
      expect(() => o.ogm.model('Thing')).toThrow(/is an interface/);
      expect(() => o.ogm.interfaceModel('Doc')).toThrow(
        /Unknown interface type: Doc/,
      );
    }
  });
});

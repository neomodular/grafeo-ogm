/**
 * v2.31.0 — typed policy context. `OGM`'s third generic types the context
 * of every policy callback written inline in `policies` and the argument
 * of `withContext()`; a context declared as an `interface` is accepted;
 * code with two or no generics compiles unchanged and emits the same
 * Cypher.
 *
 * This file IS the type test: ts-jest type-checks it, so a failing
 * assignment or an unused `@ts-expect-error` fails the suite. The
 * `typecheckGenerated` case compiles the same usage against real
 * generated types.
 */
import type { Driver } from 'neo4j-driver';
import {
  compile,
  createCompileOnlyOgm,
  OGM,
  override,
  permissive,
  restrictive,
  type PoliciesByModel,
  type Policy,
  type PolicyContext,
} from '../../src';
import { typecheckGenerated } from '../helpers/generated-typecheck';

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type Book @node {
    id: ID! @id
    ownerId: String
    tier: String
  }
`;

/** Declared as an `interface`: no implicit index signature. */
interface RequestCtx {
  userId: string;
  capabilities: string[];
  tierIds: string[];
}

type ModelMap = { Book: { Type: { id: string } } };
type InterfaceModelMap = Record<string, never>;

const driver = {} as Driver;

const ctx: RequestCtx = { userId: 'u1', capabilities: [], tierIds: ['t'] };

function typedPolicies(): PoliciesByModel<ModelMap, RequestCtx> {
  return {
    Book: [
      override({
        operations: ['*'],
        when: (c) => c.capabilities.includes('admin'),
      }),
      permissive({
        operations: ['read'],
        when: (c) => ({ ownerId: c.userId }),
      }),
      restrictive({
        operations: ['read'],
        when: (c) => ({ tier_IN: c.tierIds }),
      }),
      restrictive({
        operations: ['create'],
        when: (c, input) => input.ownerId === c.userId,
      }),
    ],
  };
}

describe('typed policy context (v2.31.0)', () => {
  it('types inline policy callbacks and withContext from the third generic', () => {
    const ogm = new OGM<ModelMap, InterfaceModelMap, RequestCtx>({
      typeDefs,
      driver,
      policies: {
        Book: [
          // `c` is inferred as RequestCtx — no cast, no explicit generic.
          permissive({
            operations: ['read'],
            when: (c) => ({ ownerId: c.userId }),
          }),
          override({
            operations: ['*'],
            when: (c) => c.capabilities.includes('admin'),
          }),
          restrictive({
            operations: ['read'],
            when: (c) => ({ tier_IN: c.tierIds }),
          }),
          restrictive({
            operations: ['create'],
            when: (c, input) => input.ownerId === c.userId,
          }),
          permissive({
            operations: ['read'],
            cypher: {
              fragment: (_c, alias) => `${alias.node}.ownerId = $uid`,
              params: (c) => ({ uid: c.userId }),
            },
          }),
          // @ts-expect-error `c` is RequestCtx, which has no `nope`
          permissive({ operations: ['read'], when: (c) => ({ o: c.nope }) }),
        ],
      },
    });

    expect(ogm.withContext(ctx)).toBeDefined();
    expect(
      ogm.withContext({ userId: 'u1', capabilities: [], tierIds: [] }),
    ).toBeDefined();
    // @ts-expect-error wrong context shape
    expect(() => ogm.withContext({ nope: 1 })).not.toThrow();
    // @ts-expect-error missing required context keys
    expect(() => ogm.withContext({ userId: 'u1' })).not.toThrow();
    // The bypassed clone keeps the context type.
    const bypassed = ogm.unsafe.bypassPolicies();
    // @ts-expect-error wrong context shape
    expect(() => bypassed.withContext({ nope: 1 })).not.toThrow();
  });

  it('explicit permissive<Ctx>() works standalone and rejects a mismatched context', () => {
    const own = permissive<RequestCtx>({
      operations: ['read'],
      when: (c) => ({ ownerId: c.userId }),
    });
    const ogm = new OGM<ModelMap, InterfaceModelMap, RequestCtx>({
      typeDefs,
      driver,
      policies: { Book: [own] },
    });
    expect(ogm).toBeDefined();

    const other = permissive<{ other: number }>({
      operations: ['read'],
      when: (c) => ({ o: c.other }),
    });
    expect(
      () =>
        new OGM<ModelMap, InterfaceModelMap, RequestCtx>({
          typeDefs,
          driver,
          // @ts-expect-error policy written for another context type
          policies: { Book: [other] },
        }),
    ).not.toThrow();
    // `Policy<Ctx>` / `PoliciesByModel<M, Ctx>` accept interface contexts.
    const list: ReadonlyArray<Policy<RequestCtx>> = [own];
    expect(typedPolicies().Book).toHaveLength(4);
    expect(list).toHaveLength(1);
  });

  it('keeps 2-generic and no-generic code compiling unchanged', () => {
    // No generics: callbacks receive PolicyContext, as before.
    const plain = new OGM({
      typeDefs,
      driver,
      policies: {
        Book: [
          permissive({
            operations: ['read'],
            when: (c) => ({ ownerId: c.uid }),
          }),
        ],
      },
    });
    plain.withContext({ uid: 'x' });
    plain.withContext<{ uid: string }>({ uid: 'x' });
    // Untyped OGMs now also accept an interface-typed value.
    plain.withContext(ctx);

    const two = new OGM<ModelMap, InterfaceModelMap>({
      typeDefs,
      driver,
      policies: {
        Book: [
          permissive({
            operations: ['read'],
            when: (c) => {
              const pc: PolicyContext = c;
              return { ownerId: pc.uid };
            },
          }),
        ],
      },
    });
    two.withContext({ anything: 1 });

    // Erasing the generics still yields PolicyContext-typed policies.
    type Erased = NonNullable<ConstructorParameters<typeof OGM>[0]['policies']>;
    const erased: Erased = {
      Book: [permissive({ operations: ['read'], when: (c) => ({ o: c.uid }) })],
    };
    expect(erased.Book).toHaveLength(1);
  });

  it('emits byte-identical Cypher for typed and untyped OGMs', async () => {
    const typed = createCompileOnlyOgm<ModelMap, InterfaceModelMap, RequestCtx>(
      {
        typeDefs,
        policies: {
          Book: [
            permissive({
              operations: ['read'],
              when: (c) => ({ ownerId: c.userId }),
            }),
          ],
        },
      },
    );
    const untyped = createCompileOnlyOgm({
      typeDefs,
      policies: {
        Book: [
          permissive({
            operations: ['read'],
            when: (c) => ({ ownerId: (c as unknown as RequestCtx).userId }),
          }),
        ],
      },
    });
    // @ts-expect-error wrong context shape on the compile-only OGM
    expect(() => typed.withContext({ nope: 1 })).not.toThrow();

    const a = await compile(typed.withContext(ctx).model('Book')).find({
      selectionSet: '{ id }',
    });
    const b = await compile(untyped.withContext({ ...ctx }).model('Book')).find(
      { selectionSet: '{ id }' },
    );
    expect(a.cypher).toBe(b.cypher);
    expect(a.params).toEqual(b.params);
  });

  it('compiles against generated types', async () => {
    const usage = `
import { OGM, permissive, restrictive } from 'grafeo-ogm';
import type { Driver } from 'neo4j-driver';
import type { ModelMap, InterfaceModelMap } from './generated';

interface RequestCtx { userId: string; capabilities: string[]; tierIds: string[] }
declare const driver: Driver;

const ogm = new OGM<ModelMap, InterfaceModelMap, RequestCtx>({
  typeDefs: '',
  driver,
  policies: {
    Book: [
      permissive({ operations: ['read'], when: (c) => ({ ownerId: c.userId }) }),
      restrictive({ operations: ['read'], when: (c) => ({ tier_IN: c.tierIds }) }),
    ],
  },
});

export async function ok(): Promise<void> {
  const books = await ogm
    .withContext({ userId: 'u1', capabilities: [], tierIds: [] })
    .model('Book')
    .find({ where: { ownerId: 'u1' } });
  books.map((b) => b.id);
}

export function bad(): void {
  // @ts-expect-error wrong context shape
  ogm.withContext({ nope: 1 });
  new OGM<ModelMap, InterfaceModelMap, RequestCtx>({
    typeDefs: '',
    driver,
    // @ts-expect-error c is RequestCtx
    policies: { Book: [permissive({ operations: ['read'], when: (c) => ({ o: c.nope }) })] },
  });
}

// Two generics, unchanged.
const legacy = new OGM<ModelMap, InterfaceModelMap>({
  typeDefs: '',
  driver,
  policies: { Book: [permissive({ operations: ['read'], when: (c) => ({ ownerId: c.uid }) })] },
});
legacy.withContext({ uid: 'x' });
`;
    const { errors } = await typecheckGenerated(typeDefs, usage);
    expect(errors).toEqual([]);
  });
});

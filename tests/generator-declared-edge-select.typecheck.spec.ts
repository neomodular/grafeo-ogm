/**
 * v2.6.3 — #22: an interface field with `@declareRelationship`, whose
 * implementors' `@relationship` carries `properties`, made the generator
 * reference `<Interface><Field>EdgeSelectFields` (in
 * `<Interface>SelectFields.<field>Connection.select.edges.properties`)
 * without emitting it. The generated file failed to compile (TS2552) from
 * v2.4.8, when declared relationships started resolving their properties
 * from the implementors. These cases compile the generated file and real
 * user code against it.
 *
 * Implementors whose relationships disagree on `properties` (different
 * types, or one without) are rejected by the schema parser, so the declared
 * relationship always has exactly one properties type, and the interface's
 * edge select type is built from it.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateTypes } from '../src/generator';
import { typecheckGenerated } from './helpers/generated-typecheck';

jest.setTimeout(60_000);

const PRELUDE = `
import type { OGM } from 'grafeo-ogm';
import type { ModelMap, InterfaceModelMap } from './generated';
import * as G from './generated';
declare const ogm: OGM<ModelMap, InterfaceModelMap>;
`;

const ownerSchema = (target: string, extra = '') => `
  interface Owner {
    id: ID!
    plans: [${target}!]! @declareRelationship
  }
  type Plan @node {
    id: ID! @id
    name: String
  }
  ${extra}
  type SubscriptionProps @relationshipProperties {
    endDate: DateTime!
  }
  type User implements Owner @node {
    id: ID! @id
    plans: [${target}!]!
      @relationship(type: "SUBSCRIBED_TO", properties: "SubscriptionProps", direction: OUT)
  }
  type Org implements Owner @node {
    id: ID! @id
    plans: [${target}!]!
      @relationship(type: "SUBSCRIBED_TO", properties: "SubscriptionProps", direction: OUT)
  }
  type Account @node {
    id: ID! @id
    owner: Owner @relationship(type: "OWNED_BY", direction: OUT)
  }
`;

const edgeSelectBlocks = (generated: string, name: string) =>
  generated.match(new RegExp(`export type ${name} = \\{[^}]*\\};`, 'g')) ?? [];

describe('interface @declareRelationship with relationship properties (#22)', () => {
  it('emits <Interface><Field>EdgeSelectFields and the edge select compiles', async () => {
    const { generated, errors } = await typecheckGenerated(
      ownerSchema('Plan'),
      `${PRELUDE}
const fields: G.OwnerSelectFields = {
  plansConnection: {
    select: { edges: { properties: { select: { endDate: true } } } },
  },
};
async function run() {
  await ogm.model('Account').find({
    select: {
      owner: {
        select: {
          plansConnection: {
            select: {
              edges: {
                node: { select: { name: true } },
                properties: { select: { endDate: true } },
              },
            },
          },
        },
      },
    },
  });
}
// @ts-expect-error the edge select only offers the properties type's fields
const bad: G.OwnerPlansEdgeSelectFields = { nope: true };
void fields; void run; void bad;
`,
    );
    expect(errors).toEqual([]);
    expect(edgeSelectBlocks(generated, 'OwnerPlansEdgeSelectFields')).toEqual([
      'export type OwnerPlansEdgeSelectFields = {\n  endDate?: boolean;\n};',
    ]);
  });

  it('compiles when the declared relationship targets a union', async () => {
    const { generated, errors } = await typecheckGenerated(
      ownerSchema(
        'Thing',
        `type Addon @node { id: ID! @id sku: String }
         union Thing = Plan | Addon`,
      ),
      `${PRELUDE}
const fields: G.OwnerSelectFields = {
  plansConnection: {
    select: { edges: { properties: { select: { endDate: true } } } },
  },
};
void fields;
`,
    );
    expect(errors).toEqual([]);
    expect(
      edgeSelectBlocks(generated, 'OwnerPlansEdgeSelectFields'),
    ).toHaveLength(1);
  });

  it('compiles for a single (non-list) declared relationship', async () => {
    const { errors } = await typecheckGenerated(
      `
      interface Owner { id: ID! plan: Plan @declareRelationship }
      type Plan @node { id: ID! @id }
      type P @relationshipProperties { endDate: DateTime! }
      type User implements Owner @node {
        id: ID! @id
        plan: Plan @relationship(type: "S", properties: "P", direction: OUT)
      }
    `,
      `${PRELUDE}
const fields: G.OwnerSelectFields = {
  planConnection: { select: { edges: { properties: { select: { endDate: true } } } } },
};
void fields;
`,
    );
    expect(errors).toEqual([]);
  });

  it('emits no interface edge select when the declared relationship has no properties', async () => {
    const { generated, errors } = await typecheckGenerated(
      `
      interface Owner { id: ID! plans: [Plan!]! @declareRelationship }
      type Plan @node { id: ID! @id }
      type User implements Owner @node {
        id: ID! @id
        plans: [Plan!]! @relationship(type: "S", direction: OUT)
      }
    `,
      'export {};',
    );
    expect(errors).toEqual([]);
    expect(generated).not.toContain('OwnerPlansEdgeSelectFields');
  });

  it('rejects implementors that declare different properties types', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grafeo-decl-props-'));
    try {
      await expect(
        generateTypes({
          typeDefs: `
            interface Owner { id: ID! plans: [Plan!]! @declareRelationship }
            type Plan @node { id: ID! @id }
            type P1 @relationshipProperties { endDate: DateTime! }
            type P2 @relationshipProperties { startDate: DateTime! }
            type User implements Owner @node {
              id: ID! @id
              plans: [Plan!]! @relationship(type: "S", properties: "P1", direction: OUT)
            }
            type Org implements Owner @node {
              id: ID! @id
              plans: [Plan!]! @relationship(type: "S", properties: "P2", direction: OUT)
            }
          `,
          outFile: path.join(dir, 'out.ts'),
          config: { formatOutput: false },
        }),
      ).rejects.toThrow(/different properties \("P1" vs "P2"\)/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

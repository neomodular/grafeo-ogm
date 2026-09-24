/**
 * Shared schema + policy set for the NLS enforcement-gap tests
 * (fix-nls-enforcement-gaps, v2.3.0). Used by BOTH the mock-driver unit
 * suite (`tests/policy/enforcement-gaps.spec.ts`) and the live suite
 * (`tests/integration/nls-enforcement.spec.ts`) so the two always test
 * the same policies.
 *
 * - `ItTag`      — deliberately NO policies: the unprotected root (H1).
 *                  `charts` carries edge properties (`ItTagged`);
 *                  `resources` (interface) and `items` (union) are the
 *                  abstract relationship targets (H5).
 * - `ItChart`    — read hides `secret`; update/delete owner-only; create
 *                  needs a grant; tenant WITH CHECK on create/update.
 * - `ItCategory` — deletable only when not `protected` (cascade target).
 * - `ItDrug`     — interface implementer whose only permissive is gated
 *                  off by `appliesWhen` (H2).
 * - `ItDoc`      — restrictive using the `_NOT: null` idiom (H3).
 */
import { permissive, restrictive } from '../../src/policy/types';

export const typeDefs = `
interface ItResource {
  id: ID!
  tenantId: String
}
type ItTagged @relationshipProperties {
  weight: Int
}
union ItItem = ItChart | ItDoc
type ItTag @node {
  id: ID! @unique
  runId: String
  charts: [ItChart!]!
    @relationship(type: "IT_TAGS", direction: OUT, properties: "ItTagged")
  resources: [ItResource!]! @relationship(type: "IT_TAGS_RES", direction: OUT)
  items: [ItItem!]! @relationship(type: "IT_TAGS_ITEM", direction: OUT)
}
type ItChart implements ItResource @node(labels: ["ItResource", "ItChart"]) {
  id: ID! @unique
  runId: String
  tenantId: String
  ownerId: String
  secret: Boolean
  title: String
  tags: [ItTag!]! @relationship(type: "IT_TAGS", direction: IN)
  categories: [ItCategory!]! @relationship(type: "IT_IN_CATEGORY", direction: OUT)
}
type ItCategory @node {
  id: ID! @unique
  runId: String
  name: String
  protected: Boolean
  charts: [ItChart!]! @relationship(type: "IT_IN_CATEGORY", direction: IN)
}
type ItDrug implements ItResource @node(labels: ["ItResource", "ItDrug"]) {
  id: ID! @unique
  runId: String
  tenantId: String
}
type ItDoc @node {
  id: ID! @unique
  runId: String
  approvedAt: String
}
`;

export type Ctx = { uid: string; tid: string; canCreateChart?: boolean };
export const CTX: Ctx = { uid: 'u1', tid: 't1' };

export const policies = {
  ItChart: [
    permissive({
      operations: ['read'],
      name: 'chart.read-all',
      when: () => ({}),
    }),
    restrictive({
      operations: ['read'],
      name: 'chart.no-secret',
      when: () => ({ secret: false }),
    }),
    permissive({
      operations: ['update'],
      name: 'chart.update-own',
      when: (c) => ({ ownerId: (c as Ctx).uid }),
    }),
    restrictive({
      operations: ['update'],
      name: 'chart.update-tenant',
      when: (c, input) =>
        input.tenantId === undefined || input.tenantId === (c as Ctx).tid,
    }),
    permissive({
      operations: ['create'],
      name: 'chart.create-grant',
      appliesWhen: (c) => Boolean((c as Ctx).canCreateChart),
      when: () => ({}),
    }),
    restrictive({
      operations: ['create'],
      name: 'chart.create-tenant',
      when: (c, input) => input.tenantId === (c as Ctx).tid,
    }),
    permissive({
      operations: ['delete'],
      name: 'chart.delete-own',
      when: (c) => ({ ownerId: (c as Ctx).uid }),
    }),
  ],
  ItCategory: [
    permissive({
      operations: ['read', 'update', 'create'],
      name: 'category.all',
      when: () => ({}),
    }),
    permissive({
      operations: ['delete'],
      name: 'category.delete-unprotected',
      when: () => ({ protected: false }),
    }),
  ],
  ItDrug: [
    permissive({
      operations: ['read'],
      name: 'drug.gated',
      appliesWhen: () => false,
      when: () => ({}),
    }),
  ],
  ItDoc: [
    permissive({ operations: ['read'], name: 'doc.all', when: () => ({}) }),
    restrictive({
      operations: ['read'],
      name: 'doc.approved',
      when: () => ({ approvedAt_NOT: null }),
    }),
  ],
};

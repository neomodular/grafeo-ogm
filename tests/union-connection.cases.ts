/**
 * v2.9.0 — shared schema and read shapes for a `<rel>Connection` selected
 * under a union parent (`tests/union-connection*.spec.ts`).
 */
import type { OGM } from '../src/ogm';
import { permissive, restrictive } from '../src/policy/types';

export const typeDefs = /* GraphQL */ `
  type UcTag @node {
    id: ID! @unique
    name: String
    secret: Boolean
  }
  type UcBadge @node {
    id: ID! @unique
    title: String
  }
  type UcTagged @relationshipProperties {
    weight: Int
  }
  type UcPost @node {
    id: ID! @unique
    tags: [UcTag!]!
      @relationship(type: "UC_TAGGED", direction: OUT, properties: "UcTagged")
  }
  type UcAudio @node {
    id: ID! @unique
    tags: [UcTag!]!
      @relationship(type: "UC_TAGGED", direction: OUT, properties: "UcTagged")
  }
  type UcNote @node {
    id: ID! @unique
    body: String
  }
  type UcVideo @node {
    id: ID! @unique
    tags: [UcTag!]! @relationship(type: "UC_LABELED", direction: IN)
  }
  type UcClip @node {
    id: ID! @unique
    tags: [UcBadge!]! @relationship(type: "UC_BADGED", direction: OUT)
  }
  "Every declaring member shares UcPost's relationship."
  union UcSame = UcPost | UcAudio
  union UcOne = UcVideo
  "Only the first member declares tags."
  union UcPart = UcPost | UcNote
  "UcVideo / UcClip differ from UcPost; UcAudio shares it."
  union UcMixed = UcPost | UcVideo | UcAudio
  union UcTargets = UcPost | UcClip
  type UcFeed @node {
    id: ID! @unique
    post: UcPost @relationship(type: "UC_POST", direction: OUT)
    same: [UcSame!]! @relationship(type: "UC_SAME", direction: OUT)
    one: [UcOne!]! @relationship(type: "UC_ONE", direction: OUT)
    part: [UcPart!]! @relationship(type: "UC_PART", direction: OUT)
    mixed: [UcMixed!]! @relationship(type: "UC_MIXED", direction: OUT)
    targets: [UcTargets!]! @relationship(type: "UC_TARGETS", direction: OUT)
  }
`;

export const policies = {
  UcTag: [
    permissive({ operations: ['read'], name: 'tag.read', when: () => ({}) }),
    restrictive({
      operations: ['read'],
      name: 'tag.no-secret',
      when: () => ({ secret: false }),
    }),
  ],
};

export type Run = (ogm: OGM) => Promise<unknown>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const feed = (ogm: OGM): any => ogm.model('UcFeed');

const connSelect = {
  tagsConnection: {
    select: {
      totalCount: true,
      edges: {
        node: { select: { name: true } },
        properties: { select: { weight: true } },
      },
    },
  },
};
const connWhere = {
  tagsConnection: {
    where: { node: { name_STARTS_WITH: 'a' } },
    select: { edges: { node: { select: { name: true } } } },
  },
};
const select =
  (field: string, sel: Record<string, unknown>): Run =>
  (ogm) =>
    feed(ogm).find({
      where: { id: 'f1' },
      select: { [field]: { select: sel } },
    });
const selectionSet =
  (s: string): Run =>
  (ogm) =>
    feed(ogm).find({ where: { id: 'f1' }, selectionSet: s });
const frag = (type: string, conn = '{ totalCount edges { node { name } } }') =>
  `... on ${type} { tagsConnection${conn} }`;

/**
 * Shapes with no differing member (results already right), plus one whose
 * differing member a connection argument cannot compile for.
 */
export const unchangedShapes: Record<string, Run> = {
  'non-union parent: typed select': select('post', connSelect),
  'non-union parent: selectionSet with where': selectionSet(
    `{ post { tagsConnection(where: { node: { name: "a" } }) { totalCount edges { properties { weight } node { name } } } } }`,
  ),
  'shared pattern: typed select': select('same', connSelect),
  'shared pattern: typed select with where': select('same', connWhere),
  'shared pattern: fragments': selectionSet(
    `{ same { ${frag('UcPost')} ${frag('UcAudio')} } }`,
  ),
  'single member: typed select': select('one', connSelect),
  'single member: fragment': selectionSet(`{ one { ${frag('UcVideo')} } }`),
  'only the first member declares it: typed select': select('part', connSelect),
  'only the first member declares it: fragment': selectionSet(
    `{ part { ${frag('UcPost')} ... on UcNote { body } } }`,
  ),
  // UcClip's target (UcBadge) has no `name`: 2.x reads UcClip through
  // UcPost's relationship and warns; strict throws.
  'differing member a sort cannot compile for: fragments': selectionSet(
    `{ targets { ${frag('UcPost', '(sort: [{ node: { name: ASC } }]) { edges { node { name } } }')} } }`,
  ),
};

/** The same shapes with the `UcTag` read policies (secured OGM). */
export const unchangedSecuredShapes: Record<string, Run> = {
  'secured shared pattern: typed select': select('same', connSelect),
  'secured single member: typed select': select('one', connSelect),
};

/** Shapes whose differing members read wrong edges in 2.x (strict fixes them). */
export const fixedShapes = {
  mixedSelect: select('mixed', connSelect),
  mixedWhere: select('mixed', connWhere),
  mixedFragments: selectionSet(
    `{ mixed { ${frag('UcPost')} ${frag('UcVideo')} ${frag('UcAudio')} } }`,
  ),
  targetsWhere: select('targets', connWhere),
};

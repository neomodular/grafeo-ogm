/**
 * fast-check generators for the property suites. Every shape follows what
 * the GENERATED TYPES offer for `schema.ts` (compiler invariant 5: if the
 * types offer an input, the runtime must honour it or throw `OGMError`).
 *
 * Ids are placeholders (`'@c1'`, `'@run'`, see `resolvePlaceholders`) so
 * shrunk counterexamples are readable and replayable.
 *
 * Not generated, by design:
 * - selectionSet `options.sort` on a relationship field needs APOC, which
 *   the CI container has but the local one may not — sort is generated on
 *   root `options` only.
 * - Root and connect `where`s always carry `runId: '@run'` so a write can
 *   never reach another run's nodes (live-suite isolation).
 *
 * Excluded because of an OPEN FINDING (each marked at its generator, with
 * the finding id; remove the exclusion with the fix):
 * - F1 `updateItem`: nested `delete` whose target type is an ancestor.
 * - F2 `updateItem`: `connect` / `create` on a field an enclosing nested
 *   update item is iterating.
 * - F5 `disconnectItem`: blanket disconnect on a shared relationship type.
 * - F7 (policy suite only): `upsert` on an existing policy-guarded node.
 *
 * Generated rarely or in the runtime shape, because the generated TYPES
 * offer a shape the runtime rejects with OGMError (F3, F4 and the
 * OGMError-documented limitations: edge filters in mutation connection
 * wheres, divergent connect-item shapes, multi-level cascade delete,
 * connection-level logical operators in typed-select wheres).
 */
import fc from 'fast-check';
import { SEED, type GraphType } from './schema';

type Rec = Record<string, unknown>;

// --- static schema map (independent of the OGM's parser) ---------------------

export interface RelDef {
  field: string;
  type: string;
  dir: 'OUT' | 'IN';
  kind: 'concrete' | 'interface' | 'union';
  /** Concrete target types (the type itself, the implementors or members). */
  members: string[];
  edge: boolean;
}

export const RELS: Record<string, RelDef[]> = {
  ItPTag: [
    {
      field: 'charts',
      type: 'ITP_TAGS',
      dir: 'OUT',
      kind: 'concrete',
      members: ['ItPChart'],
      edge: true,
    },
    {
      field: 'resources',
      type: 'ITP_RES',
      dir: 'OUT',
      kind: 'interface',
      members: ['ItPChart', 'ItPDrug'],
      edge: false,
    },
    {
      field: 'vaults',
      type: 'ITP_RES',
      dir: 'OUT',
      kind: 'concrete',
      members: ['ItPVault'],
      edge: false,
    },
    {
      field: 'items',
      type: 'ITP_ITEM',
      dir: 'OUT',
      kind: 'union',
      members: ['ItPChart', 'ItPDoc'],
      edge: false,
    },
  ],
  ItPChart: [
    {
      field: 'tags',
      type: 'ITP_TAGS',
      dir: 'IN',
      kind: 'concrete',
      members: ['ItPTag'],
      edge: true,
    },
    {
      field: 'categories',
      type: 'ITP_IN_CAT',
      dir: 'OUT',
      kind: 'concrete',
      members: ['ItPCategory'],
      edge: false,
    },
  ],
  ItPCategory: [
    {
      field: 'charts',
      type: 'ITP_IN_CAT',
      dir: 'IN',
      kind: 'concrete',
      members: ['ItPChart'],
      edge: false,
    },
  ],
  ItPDrug: [],
  ItPDoc: [],
  ItPVault: [],
};

export function relDef(type: string, field: string): RelDef {
  const def = RELS[type]?.find((r) => r.field === field);
  if (!def) throw new Error(`no relationship ${type}.${field}`);
  return def;
}

/** Writable scalar fields per type (id / runId are handled separately). */
export const SCALAR_FIELDS: Record<string, string[]> = {
  ItPTag: ['name', 'rank'],
  ItPChart: ['name', 'rank', 'tenantId', 'ownerId', 'secret'],
  ItPCategory: ['name', 'rank', 'protected'],
  ItPDrug: ['name', 'rank'],
  ItPDoc: ['name', 'rank', 'approvedAt'],
  ItPVault: ['name', 'rank'],
  ItPResource: ['name', 'rank'],
};

const FIELD_KIND: Record<string, 'string' | 'int' | 'bool'> = {
  name: 'string',
  rank: 'int',
  tenantId: 'string',
  ownerId: 'string',
  secret: 'bool',
  protected: 'bool',
  approvedAt: 'string',
};

export function seedIds(type: string): string[] {
  const members = type === 'ItPResource' ? ['ItPChart', 'ItPDrug'] : [type];
  return SEED.nodes.filter((n) => members.includes(n.type)).map((n) => n.id);
}

// --- scalar values -------------------------------------------------------------

/** Values seeded and written for the graph types' scalar fields. */
export function fieldValue(field: string): fc.Arbitrary<unknown> {
  switch (field) {
    case 'name':
      return fc.constantFrom('a', 'b', 'c', 'zz');
    case 'rank':
      // 4e9 > 2^31: Int fields are stored as 64-bit Longs.
      return fc.constantFrom(1, 2, 3, 5, 4_000_000_000);
    case 'tenantId':
      return fc.constantFrom('t1', 't2');
    case 'ownerId':
      return fc.constantFrom('u1', 'u2');
    case 'approvedAt':
      return fc.constantFrom('2026-01-01', '2026-03-03');
    case 'secret':
    case 'protected':
      return fc.boolean();
    default:
      throw new Error(`no value generator for ${field}`);
  }
}

const idRef = (type: string) =>
  fc.constantFrom(...seedIds(type).map((s) => `@${s}`), '@missing');

// --- where -----------------------------------------------------------------------

/** One scalar operator entry for `field`, as a single-key where. */
function scalarLeaf(
  type: string,
  field: string,
  evaluable: boolean,
): fc.Arbitrary<Rec> {
  const kind = FIELD_KIND[field];
  const v = fieldValue(field);
  const ops: fc.Arbitrary<Rec>[] = [
    v.map((x) => ({ [field]: x })),
    v.map((x) => ({ [`${field}_NOT`]: x })),
  ];
  if (kind !== 'bool') {
    ops.push(
      fc
        .uniqueArray(v, { minLength: 1, maxLength: 3 })
        .map((xs) => ({ [`${field}_IN`]: xs })),
    );
    ops.push(
      fc
        .uniqueArray(v, { minLength: 1, maxLength: 2 })
        .map((xs) => ({ [`${field}_NOT_IN`]: xs })),
    );
  }
  if (kind === 'int')
    for (const op of ['_LT', '_LTE', '_GT', '_GTE'])
      ops.push(v.map((x) => ({ [`${field}${op}`]: x })));
  if (kind === 'string') {
    ops.push(
      fc
        .constantFrom('a', 'z', 't', 'u')
        .map((x) => ({ [`${field}_STARTS_WITH`]: x })),
    );
    ops.push(
      fc.constantFrom('a', 'z', '1').map((x) => ({ [`${field}_CONTAINS`]: x })),
    );
    if (!evaluable) {
      ops.push(
        fc.constantFrom('a', 'z').map((x) => ({ [`${field}_ENDS_WITH`]: x })),
      );
      ops.push(
        fc
          .constantFrom('b', 'z')
          .map((x) => ({ [`${field}_NOT_CONTAINS`]: x })),
      );
      ops.push(
        fc
          .constantFrom('a.*', '[ab]', 'z+')
          .map((x) => ({ [`${field}_MATCHES`]: x })),
      );
    }
  }
  void type;
  return fc.oneof(...ops);
}

function idLeaf(type: string): fc.Arbitrary<Rec> {
  return fc.oneof(
    idRef(type).map((id) => ({ id })),
    fc
      .uniqueArray(idRef(type), { minLength: 1, maxLength: 3 })
      .map((ids) => ({ id_IN: ids })),
    idRef(type).map((id) => ({ id_NOT: id })),
  );
}

function leafWhere(type: string, evaluable: boolean): fc.Arbitrary<Rec> {
  const fields = SCALAR_FIELDS[type];
  return fc.oneof(
    { weight: 2, arbitrary: idLeaf(type) },
    {
      weight: 3,
      arbitrary: fc
        .constantFrom(...fields)
        .chain((f) => scalarLeaf(type, f, evaluable)),
    },
  );
}

function logical(leaf: fc.Arbitrary<Rec>, depth: number): fc.Arbitrary<Rec> {
  if (depth <= 0) return leaf;
  const inner = logical(leaf, depth - 1);
  return fc.oneof(
    { weight: 4, arbitrary: leaf },
    {
      weight: 1,
      arbitrary: fc.tuple(leaf, leaf).map(([a, b]) => ({ ...b, ...a })),
    },
    {
      weight: 1,
      arbitrary: fc
        .array(inner, { minLength: 1, maxLength: 2 })
        .map((xs) => ({ AND: xs })),
    },
    {
      weight: 1,
      arbitrary: fc
        .array(inner, { minLength: 1, maxLength: 2 })
        .map((xs) => ({ OR: xs })),
    },
    { weight: 1, arbitrary: inner.map((x) => ({ NOT: x })) },
  );
}

/**
 * A root `where` the oracle can evaluate exactly (`evalWhere`): scalar
 * operators and AND / OR / NOT, scoped to this run.
 */
export function rootWhere(type: string): fc.Arbitrary<Rec> {
  return fc
    .oneof(
      { weight: 1, arbitrary: fc.constant({}) },
      { weight: 6, arbitrary: logical(leafWhere(type, true), 1) },
    )
    .map((w) => ({ runId: '@run', ...w }));
}

/** A scalar-only `where` (nested writes, selection arguments). */
export function scalarWhere(type: string, depth = 1): fc.Arbitrary<Rec> {
  return logical(leafWhere(type, false), depth);
}

const edgeWhere: fc.Arbitrary<Rec> = logical(
  fc.oneof(
    fc.constantFrom(1, 2, 3, 9).map((w) => ({ weight: w })),
    fc.constantFrom(1, 3).map((w) => ({ weight_GT: w })),
    fc
      .uniqueArray(fc.constantFrom(1, 2, 5), { minLength: 1, maxLength: 2 })
      .map((ws) => ({ weight_IN: ws })),
    fc.constantFrom('x', 'y').map((n) => ({ note: n })),
    fc.constant({ note: null }),
  ),
  1,
);

/** Target-side where for a relationship field (interface / union aware). */
function targetWhere(
  def: RelDef,
  member: string | undefined,
  depth: number,
  read: boolean,
): fc.Arbitrary<Rec> {
  const one = (t: string) => (read ? readWhere(t, depth) : scalarWhere(t, 1));
  if (def.kind === 'interface') return scalarWhere('ItPResource', 1);
  if (def.kind === 'union' && member === undefined)
    return fc
      .record(
        Object.fromEntries(def.members.map((m) => [m, one(m)])) as Record<
          string,
          fc.Arbitrary<Rec>
        >,
        { requiredKeys: [] },
      )
      .filter((r) => Object.keys(r).length > 0);
  return one(member ?? def.members[0]);
}

/** Connection where (`node`, `node_NOT`, `edge`, logical). */
export function connectionWhere(
  def: RelDef,
  member: string | undefined,
  depth: number,
  read = false,
  opts: { edge?: boolean; logical?: boolean } = {},
): fc.Arbitrary<Rec> {
  const node = targetWhere(def, member, Math.max(0, depth - 1), read);
  const leaves: fc.Arbitrary<Rec>[] = [
    node.map((n) => ({ node: n })),
    node.map((n) => ({ node_NOT: n })),
  ];
  // Excluded: `edge` filters in a MUTATION connection where throw OGMError
  // ("not supported in mutations") although the generated types offer them
  // — reported as a types/runtime mismatch; generated for reads only.
  if (def.edge && (opts.edge ?? read)) {
    leaves.push(edgeWhere.map((e) => ({ edge: e })));
    leaves.push(
      fc.tuple(node, edgeWhere).map(([n, e]) => ({ node: n, edge: e })),
    );
  }
  return logical(fc.oneof(...leaves), opts.logical === false ? 0 : 1);
}

/** Read-side where: scalars plus relationship and connection filters. */
export function readWhere(type: string, depth: number): fc.Arbitrary<Rec> {
  const rels = depth > 0 ? (RELS[type] ?? []) : [];
  const leaves: Array<{ weight: number; arbitrary: fc.Arbitrary<Rec> }> = [
    { weight: 3, arbitrary: leafWhere(type, false) },
  ];
  if (type !== 'ItPResource' && rels.length > 0) {
    const relLeaf = fc.constantFrom(...rels).chain((def) =>
      fc.oneof(
        fc
          .tuple(
            fc.constantFrom('', '_NOT', '_SOME', '_NONE', '_ALL', '_SINGLE'),
            targetWhere(def, undefined, depth - 1, true),
          )
          .map(([op, w]) => ({ [`${def.field}${op}`]: w })),
        fc
          .tuple(
            fc.constantFrom('', '_NOT', '_SOME', '_NONE', '_ALL', '_SINGLE'),
            connectionWhere(def, undefined, depth, true),
          )
          .map(([op, w]) => ({ [`${def.field}Connection${op}`]: w })),
      ),
    );
    leaves.push({ weight: 2, arbitrary: relLeaf });
  }
  const base = logical(fc.oneof(...leaves), 1);
  return fc.oneof(
    { weight: 6, arbitrary: base },
    { weight: 1, arbitrary: base.map((w) => ({ ...w, mode: 'insensitive' })) },
  );
}

// --- writes ----------------------------------------------------------------------

export type WriteOp =
  | { kind: 'create'; model: string; input: Rec[] }
  | { kind: 'createMany'; model: string; data: Rec[]; skipDuplicates?: boolean }
  | {
      kind: 'update';
      model: string;
      where: Rec;
      update?: Rec;
      connect?: Rec;
      disconnect?: Rec;
    }
  | { kind: 'updateMany'; model: string; where: Rec; data: Rec }
  | { kind: 'delete'; model: string; where: Rec; delete?: Rec }
  | { kind: 'deleteMany'; model: string; where: Rec }
  | { kind: 'upsert'; model: string; where: Rec; create: Rec; update: Rec };

function scalarBody(type: string, allowNull: boolean): fc.Arbitrary<Rec> {
  const fields = SCALAR_FIELDS[type];
  return fc.record(
    Object.fromEntries(
      fields.map((f) => [
        f,
        allowNull
          ? fc.oneof(
              { weight: 6, arbitrary: fieldValue(f) },
              { weight: 1, arbitrary: fc.constant(null) },
            )
          : fieldValue(f),
      ]),
    ) as Record<string, fc.Arbitrary<unknown>>,
    { requiredKeys: [] },
  );
}

const items = <T>(arb: fc.Arbitrary<T>, max = 2) =>
  fc.array(arb, { minLength: 1, maxLength: max });

/**
 * Connect arrays: items whose shapes differ (different `where` / `edge`
 * keys) throw OGMError ("connect array items have divergent shapes") —
 * batched connects share one UNWIND. The types allow them, so they are
 * still generated, but rarely; most arrays have one item.
 */
const connectItems = (arb: fc.Arbitrary<Rec>) =>
  fc.oneof(
    { weight: 6, arbitrary: items(arb, 1) },
    { weight: 1, arbitrary: items(arb, 2) },
  );
/**
 * 1–`max` of the given keys. Bounding the fan-out per level keeps a
 * depth-3 input to a few dozen ops: unbounded optional keys made inputs of
 * 10 kB+ whose 50 kB statements ran for minutes, which drowns the signal.
 */
const someKeys = (
  r: Record<string, fc.Arbitrary<unknown>>,
  max = 2,
  min = 1,
): fc.Arbitrary<Rec> => {
  const keys = Object.keys(r).filter((k) => r[k] !== undefined);
  if (keys.length === 0) return fc.constant({});
  return fc
    .subarray(keys, {
      minLength: Math.min(min, keys.length),
      maxLength: Math.min(max, keys.length),
    })
    .chain(
      (ks) =>
        fc.record(
          Object.fromEntries(ks.map((k) => [k, r[k]])),
        ) as fc.Arbitrary<Rec>,
    );
};

const edgeCreate: fc.Arbitrary<Rec> = fc.record(
  {
    weight: fc.constantFrom(1, 7, 4_000_000_000),
    note: fc.constantFrom('x', 'y'),
  },
  { requiredKeys: [] },
);

/** Create input for a concrete type (`id` renumbered by `renumberCreates`). */
export function createInput(type: string, depth: number): fc.Arbitrary<Rec> {
  const rels = depth > 0 ? (RELS[type] ?? []) : [];
  const relArbs: Record<string, fc.Arbitrary<unknown>> = {};
  for (const def of rels) {
    if (def.kind === 'union') {
      relArbs[def.field] = someKeys(
        Object.fromEntries(
          def.members.map((m) => [
            m,
            someKeys({
              connect: connectItems(connectItem(def, m, depth - 1)),
              create: items(createItem(def, m, depth - 1)),
            }),
          ]),
        ),
      );
    } else
      relArbs[def.field] = someKeys({
        connect: connectItems(connectItem(def, undefined, depth - 1)),
        create: items(createItem(def, undefined, depth - 1)),
      });
  }
  return fc
    .tuple(
      scalarBody(type, false),
      rels.length > 0 ? someKeys(relArbs, 2, 0) : fc.constant({}),
    )
    .map(([s, r]) => ({ id: '@new', runId: '@run', ...s, ...r }));
}

function createItem(
  def: RelDef,
  member: string | undefined,
  depth: number,
): fc.Arbitrary<Rec> {
  const node =
    def.kind === 'interface'
      ? fc
          .constantFrom(...def.members)
          .chain((m) => createInput(m, depth).map((n) => ({ [m]: n })))
      : createInput(member ?? def.members[0], depth);
  if (!def.edge) return node.map((n) => ({ node: n }));
  return fc
    .tuple(node, fc.option(edgeCreate, { nil: undefined }))
    .map(([n, e]) => (e ? { node: n, edge: e } : { node: n }));
}

/** `<Target>ConnectInput` — the nested connect of a connect item. */
function connectInputOf(type: string, depth: number): fc.Arbitrary<Rec> {
  const rels = (RELS[type] ?? []).filter((d) => d.kind !== 'union');
  if (rels.length === 0 || depth < 0) return fc.constant({});
  return someKeys(
    Object.fromEntries(
      rels.map((d) => [
        d.field,
        connectItems(connectItem(d, undefined, depth)),
      ]),
    ),
  );
}

function connectItem(
  def: RelDef,
  member: string | undefined,
  depth: number,
): fc.Arbitrary<Rec> {
  const target =
    def.kind === 'interface' ? 'ItPResource' : (member ?? def.members[0]);
  const where = fc.oneof(
    { weight: 1, arbitrary: fc.constant({ node: { runId: '@run' } }) },
    {
      weight: 5,
      arbitrary: scalarWhere(target, 1).map((w) => ({
        node: { runId: '@run', ...w },
      })),
    },
  );
  const parts: Record<string, fc.Arbitrary<unknown>> = {
    overwrite: fc.boolean(),
  };
  if (def.edge) parts.edge = edgeCreate;
  // The generated types offer a nested connect on concrete and union-member
  // targets, not on interface targets.
  const nestedType = def.kind === 'interface' ? undefined : target;
  if (nestedType && depth > 0 && (RELS[nestedType] ?? []).length > 0)
    parts.connect = items(connectInputOf(nestedType, depth - 1), 1);
  return fc
    .tuple(where, fc.record(parts, { requiredKeys: [] }))
    .map(([w, p]) => ({ where: w, ...p }));
}

/** `<Target>DisconnectInput` — the nested disconnect of a disconnect item. */
function disconnectInputOf(type: string, depth: number): fc.Arbitrary<Rec> {
  const rels = (RELS[type] ?? []).filter((d) => d.kind !== 'union');
  if (rels.length === 0) return fc.constant({});
  return someKeys(
    Object.fromEntries(
      rels.map((d) => [d.field, items(disconnectItem(d, undefined, depth))]),
    ),
  );
}

function disconnectItem(
  def: RelDef,
  member: string | undefined,
  depth: number,
): fc.Arbitrary<Rec> {
  const parts: Record<string, fc.Arbitrary<unknown>> = {
    where: connectionWhere(def, member, 1),
  };
  const nestedType =
    def.kind === 'interface' ? undefined : (member ?? def.members[0]);
  if (nestedType && depth > 0 && (RELS[nestedType] ?? []).length > 0)
    parts.disconnect = disconnectInputOf(nestedType, depth - 1);
  // EXCLUDED (finding F5): a BLANKET disconnect item (no `where`) on a
  // field whose relationship type another field shares (`vaults` and
  // `resources` are both ITP_RES) unlinks the other field's nodes too —
  // the target labels are not matched. Such items always get a `where`.
  const blanketUnsafe = SHARED_REL_TYPES.has(def.type);
  return fc.record(parts, { requiredKeys: blanketUnsafe ? ['where'] : [] });
}

/** Relationship types used by more than one field of the same type. */
const SHARED_REL_TYPES = new Set(
  Object.values(RELS).flatMap((defs) =>
    defs
      .filter((d) =>
        defs.some((o) => o !== d && o.type === d.type && o.dir === d.dir),
      )
      .map((d) => d.type),
  ),
);

/** `<Target>DeleteInput` — cascade below a delete item. */
function deleteInputOf(type: string, depth: number): fc.Arbitrary<Rec> {
  const rels = (RELS[type] ?? []).filter((d) => d.kind !== 'union');
  if (rels.length === 0) return fc.constant({});
  return someKeys(
    Object.fromEntries(
      rels.map((d) => [d.field, items(deleteItem(d, undefined, depth))]),
    ),
  );
}

function deleteItem(
  def: RelDef,
  member: string | undefined,
  depth: number,
): fc.Arbitrary<Rec> {
  const base = fc.record(
    { where: connectionWhere(def, member, 1) },
    { requiredKeys: [] },
  );
  const nestedType =
    def.kind === 'interface' ? undefined : (member ?? def.members[0]);
  if (!nestedType || depth <= 0 || (RELS[nestedType] ?? []).length === 0)
    return base;
  // A delete nested in a delete item (multi-level cascade) is documented to
  // throw OGMError; kept rare so most cases reach the server.
  return fc.oneof(
    { weight: 6, arbitrary: base },
    {
      weight: 1,
      arbitrary: fc
        .tuple(base, deleteInputOf(nestedType, depth - 1))
        .map(([b, d]) => ({ ...b, delete: d })),
    },
  );
}

/** Root-level `delete` input (cascade) of a model. */
export function deleteInput(type: string, depth: number): fc.Arbitrary<Rec> {
  const rels = RELS[type] ?? [];
  if (rels.length === 0) return fc.constant({});
  return someKeys(
    Object.fromEntries(
      rels.map((d) => [
        d.field,
        d.kind === 'union'
          ? // FINDING F4 (types/runtime mismatch): the generated
            // `ItPTagItemsDeleteInput` is keyed per member
            // (`{ ItPChart: [...] }`), but the root cascade delete rejects it
            // (`Unknown key "ItPChart" in a nested delete of "items"`) and
            // wants a flat item list. Mostly the runtime shape is generated.
            fc.oneof(
              { weight: 4, arbitrary: items(deleteItem(d, undefined, 0)) },
              {
                weight: 1,
                arbitrary: someKeys(
                  Object.fromEntries(
                    d.members.map((m) => [
                      m,
                      items(deleteItem(d, m, depth - 1)),
                    ]),
                  ),
                ),
              },
            )
          : items(deleteItem(d, undefined, depth - 1)),
      ]),
    ),
  );
}

/** Where a nested update item sits: ancestor types and iterated fields. */
interface UpdatePath {
  /** Types of the enclosing update items, root first. */
  types: string[];
  /** `Type.field` of every relationship an enclosing update item iterates. */
  iterated: string[];
}

function updateNode(
  def: RelDef,
  member: string | undefined,
  depth: number,
  path: UpdatePath,
): fc.Arbitrary<Rec> {
  // FINDING F3 (types/runtime mismatch): the generated
  // `ItPResourceUpdateInput` is keyed per member (`{ ItPChart: {...} }`),
  // but the runtime rejects that shape with `Unknown field "ItPChart"` and
  // only accepts flat interface fields. The flat runtime shape is generated
  // so nested interface updates are still exercised.
  if (def.kind === 'interface') return scalarBody('ItPResource', true);
  return updateBody(member ?? def.members[0], depth, path);
}

function updateItem(
  parent: string,
  def: RelDef,
  member: string | undefined,
  depth: number,
  path: UpdatePath,
): fc.Arbitrary<Rec> {
  const inner: UpdatePath = {
    types: path.types,
    iterated: [...path.iterated, `${parent}.${def.field}`],
  };
  const upd: Record<string, fc.Arbitrary<unknown>> = {
    node: updateNode(def, member, depth, inner),
  };
  if (def.edge) upd.edge = edgeCreate;
  const ops: Record<string, fc.Arbitrary<unknown>> = {
    disconnect: items(disconnectItem(def, member, depth)),
    update: fc.record(upd, { requiredKeys: [] }),
  };
  // EXCLUDED (finding F2): a `connect` / `create` on a relationship field
  // that an ENCLOSING nested update item is already iterating (chart ->
  // categories -> charts -> categories) grows the very set being iterated:
  // the outer match sees the links and nodes the inner ops add, and the
  // statement never terminates. Not generated until fixed.
  if (!path.iterated.includes(`${parent}.${def.field}`)) {
    ops.connect = connectItems(connectItem(def, member, depth));
    ops.create = items(createItem(def, member, depth));
  }
  // EXCLUDED (finding F1): a nested `delete` whose target type is an
  // ANCESTOR of this update item (a cycle such as chart -> tags -> charts)
  // can delete the root or an intermediate node, and the rest of the
  // statement then fails on the server with
  // `Neo.ClientError.Statement.EntityNotFound`. Not generated until fixed.
  const targets = member ? [member] : def.members;
  if (!targets.some((t) => path.types.includes(t)))
    ops.delete = items(deleteItem(def, member, depth));
  return fc
    .tuple(
      fc.option(connectionWhere(def, member, 1), { nil: undefined }),
      someKeys(ops),
    )
    .map(([w, ops]) => (w ? { where: w, ...ops } : ops));
}

/** `<Type>UpdateInput`: scalars plus nested relationship ops. */
export function updateBody(
  type: string,
  depth: number,
  outer: UpdatePath = { types: [], iterated: [] },
): fc.Arbitrary<Rec> {
  const rels = depth > 0 ? (RELS[type] ?? []) : [];
  const relArbs: Record<string, fc.Arbitrary<unknown>> = {};
  const path: UpdatePath = {
    types: [...outer.types, type],
    iterated: outer.iterated,
  };
  for (const def of rels)
    relArbs[def.field] =
      def.kind === 'union'
        ? someKeys(
            Object.fromEntries(
              def.members.map((m) => [
                m,
                items(updateItem(type, def, m, depth - 1, path)),
              ]),
            ),
          )
        : items(updateItem(type, def, undefined, depth - 1, path));
  return fc
    .tuple(
      scalarBody(type, true),
      rels.length ? someKeys(relArbs, 2, 0) : fc.constant({}),
    )
    .map(([s, r]) => ({ ...s, ...r }));
}

/** Top-level `connect` / `disconnect` argument of `Model.update`. */
function topConnect(type: string, depth: number): fc.Arbitrary<Rec> {
  const rels = RELS[type] ?? [];
  return someKeys(
    Object.fromEntries(
      rels.map((d) => [
        d.field,
        d.kind === 'union'
          ? someKeys(
              Object.fromEntries(
                d.members.map((m) => [
                  m,
                  connectItems(connectItem(d, m, depth - 1)),
                ]),
              ),
            )
          : connectItems(connectItem(d, undefined, depth - 1)),
      ]),
    ),
  );
}

function topDisconnect(type: string, depth: number): fc.Arbitrary<Rec> {
  const rels = RELS[type] ?? [];
  return someKeys(
    Object.fromEntries(
      rels.map((d) => [
        d.field,
        d.kind === 'union'
          ? someKeys(
              Object.fromEntries(
                d.members.map((m) => [
                  m,
                  items(disconnectItem(d, m, depth - 1)),
                ]),
              ),
            )
          : items(disconnectItem(d, undefined, depth - 1)),
      ]),
    ),
  );
}

/** Give every created node a distinct id, in input order. */
export function renumberCreates<T>(value: T): T {
  let n = 0;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Rec = {};
      for (const [k, x] of Object.entries(v as Rec))
        out[k] = k === 'id' && x === '@new' ? `@n${++n}` : walk(x);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

export const WRITE_ROOTS = ['ItPTag', 'ItPChart', 'ItPCategory'] as const;
const SCALAR_ONLY_ROOTS: GraphType[] = ['ItPDrug', 'ItPDoc', 'ItPVault'];

export interface WriteOptions {
  depth?: number;
  kinds?: WriteOp['kind'][];
  roots?: readonly string[];
}

/** A random write: any model method, nested ops up to `depth` (≤ 3). */
export function writeOp(opts: WriteOptions = {}): fc.Arbitrary<WriteOp> {
  const depth = opts.depth ?? 3;
  const roots = opts.roots ?? [...WRITE_ROOTS, ...SCALAR_ONLY_ROOTS];
  const kinds = opts.kinds ?? [
    'create',
    'createMany',
    'update',
    'updateMany',
    'delete',
    'deleteMany',
    'upsert',
  ];
  const byKind = (
    model: string,
    kind: WriteOp['kind'],
  ): fc.Arbitrary<WriteOp> => {
    switch (kind) {
      case 'create':
        return items(createInput(model, depth)).map((input) => ({
          kind,
          model,
          input,
        }));
      case 'createMany':
        return fc
          .tuple(
            items(createInput(model, 0), 3),
            fc.option(fc.boolean(), { nil: undefined }),
          )
          .map(([data, skipDuplicates]) =>
            skipDuplicates === undefined
              ? { kind, model, data }
              : { kind, model, data, skipDuplicates },
          );
      case 'update':
        return fc
          .tuple(
            rootWhere(model),
            someKeys(
              (RELS[model] ?? []).length
                ? {
                    update: updateBody(model, depth),
                    connect: topConnect(model, depth),
                    disconnect: topDisconnect(model, depth),
                  }
                : { update: updateBody(model, depth) },
              3,
            ),
          )
          .map(([where, ops]) => ({
            kind,
            model,
            where,
            ...stripUndefined(ops),
          }));
      case 'updateMany':
        return fc
          .tuple(rootWhere(model), updateBody(model, depth))
          .map(([where, data]) => ({ kind, model, where, data }));
      case 'delete':
        return fc
          .tuple(
            rootWhere(model),
            fc.option(deleteInput(model, Math.min(depth, 2)), {
              nil: undefined,
            }),
          )
          .map(([where, del]) =>
            del && Object.keys(del).length
              ? { kind, model, where, delete: del }
              : { kind, model, where },
          );
      case 'deleteMany':
        return rootWhere(model).map((where) => ({ kind, model, where }));
      case 'upsert':
        return fc
          .tuple(
            fc.oneof(idRef(model), fc.constant('@upserted')),
            createInput(model, 0),
            scalarBody(model, false),
          )
          .map(([id, create, update]) => ({
            kind,
            model,
            where: { id },
            create: { ...create, id },
            update,
          }));
    }
  };
  return fc
    .constantFrom(...roots)
    .chain((model) =>
      fc.constantFrom(...kinds).chain((kind) => byKind(model, kind)),
    )
    .map(renumberCreates);
}

function stripUndefined(r: Rec): Rec {
  return Object.fromEntries(
    Object.entries(r).filter(([, v]) => v !== undefined),
  );
}

// --- reads -----------------------------------------------------------------------

export type ReadOp =
  | {
      kind: 'find';
      model: string;
      where?: Rec;
      selectionSet?: string;
      select?: Rec;
      options?: Rec;
    }
  | { kind: 'count'; model: string; where?: Rec }
  | { kind: 'aggregate'; model: string; where?: Rec; aggregate: Rec }
  | {
      kind: 'interfaceFind';
      model: 'ItPResource';
      where?: Rec;
      selectionSet?: string;
      options?: Rec;
    };

/** GraphQL value literal for a JS where object. */
export function gqlLiteral(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(gqlLiteral).join(', ')}]`;
  return `{ ${Object.entries(v as Rec)
    .map(([k, x]) => `${k}: ${gqlLiteral(x)}`)
    .join(', ')} }`;
}

const ALIASES = ['x', 'y', 'z'];

function scalarSel(type: string): fc.Arbitrary<string[]> {
  const fields = [
    'id',
    ...SCALAR_FIELDS[type],
    ...(type === 'ItPResource' ? [] : ['__typename']),
  ];
  return fc
    .uniqueArray(
      fc.tuple(
        fc.constantFrom(...fields),
        fc.option(fc.constantFrom(...ALIASES), { freq: 4, nil: undefined }),
      ),
      { minLength: 1, maxLength: 4 },
    )
    .map((xs) => xs.map(([f, a]) => (a ? `${a}: ${f}` : f)));
}

/** A selectionSet body for `type` (`'ItPResource'` = interface). */
export function selectionSet(
  type: string,
  depth: number,
  paging = true,
): fc.Arbitrary<string> {
  const rels = depth > 0 && type !== 'ItPResource' ? (RELS[type] ?? []) : [];
  const relSel = (def: RelDef): fc.Arbitrary<string> => {
    const sub =
      def.kind === 'union'
        ? fc
            .uniqueArray(fc.constantFrom(...def.members), {
              minLength: 1,
              maxLength: 2,
            })
            .chain((ms) =>
              fc.tuple(
                ...ms.map((m) =>
                  selectionSet(m, depth - 1, paging).map(
                    (s) => `... on ${m} ${s}`,
                  ),
                ),
              ),
            )
            .map((frags) => `{ __typename ${frags.join(' ')} }`)
        : def.kind === 'interface'
          ? fc
              .tuple(
                selectionSet('ItPResource', 0),
                fc.option(fc.constantFrom(...def.members), { nil: undefined }),
              )
              .chain(([base, m]) =>
                m
                  ? selectionSet(m, depth - 1, paging).map(
                      (s) => `${base.slice(0, -1)} ... on ${m} ${s} }`,
                    )
                  : fc.constant(base),
              )
          : selectionSet(def.members[0], depth - 1, paging);
    const where =
      def.kind === 'union'
        ? fc.constant(undefined)
        : fc.option(
            scalarWhere(
              def.kind === 'interface' ? 'ItPResource' : def.members[0],
              1,
            ),
            { nil: undefined },
          );
    const options = paging
      ? fc.option(
          fc.record(
            {
              limit: fc.integer({ min: 0, max: 3 }),
              offset: fc.integer({ min: 0, max: 2 }),
            },
            { requiredKeys: [] },
          ),
          { nil: undefined },
        )
      : fc.constant(undefined);
    const plain = fc
      .tuple(
        fc.option(fc.constantFrom(...ALIASES), { freq: 4, nil: undefined }),
        where,
        options,
        sub,
      )
      .map(([alias, w, o, s]) => {
        const args = [
          w ? `where: ${gqlLiteral(w)}` : '',
          o && Object.keys(o).length ? `options: ${gqlLiteral(o)}` : '',
        ]
          .filter(Boolean)
          .join(', ');
        return `${alias ? `${alias}: ` : ''}${def.field}${args ? `(${args})` : ''} ${s}`;
      });
    const nodeSel = def.kind === 'union' ? fc.constant('{ __typename }') : sub;
    const connection = fc
      .tuple(
        fc.option(connectionWhere(def, undefined, 1), { nil: undefined }),
        fc.boolean(),
        nodeSel,
        fc.boolean(),
      )
      .map(([w, total, node, props]) => {
        const edgeParts = [
          `node ${node}`,
          def.edge && props ? 'properties { weight note }' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return `${def.field}Connection${w ? `(where: ${gqlLiteral(w)})` : ''} { ${total ? 'totalCount ' : ''}edges { ${edgeParts} } }`;
      });
    return fc.oneof(
      { weight: 3, arbitrary: plain },
      { weight: 2, arbitrary: connection },
    );
  };
  return fc
    .tuple(
      scalarSel(type),
      rels.length
        ? fc
            .uniqueArray(fc.constantFrom(...rels), { maxLength: 2 })
            .chain((ds) => fc.tuple(...ds.map(relSel)))
        : fc.constant([] as string[]),
    )
    .map(([s, r]) => `{ ${[...s, ...r].join(' ')} }`);
}

/** A typed `select` object for `type`. */
export function select(type: string, depth: number): fc.Arbitrary<Rec> {
  const fields = ['id', ...SCALAR_FIELDS[type]];
  const scalars = fc
    .uniqueArray(fc.constantFrom(...fields), { minLength: 1, maxLength: 3 })
    .map((fs) => Object.fromEntries(fs.map((f) => [f, true])));
  const rels = depth > 0 ? (RELS[type] ?? []) : [];
  if (rels.length === 0) return scalars;
  const relSel = (def: RelDef): fc.Arbitrary<Rec> => {
    const targetType =
      def.kind === 'interface' ? 'ItPResource' : def.members[0];
    const nested =
      def.kind === 'union'
        ? fc.constant({ id: true, name: true })
        : select(targetType, def.kind === 'interface' ? 0 : depth - 1);
    const plain = fc.oneof(
      fc.constant(true),
      fc
        .tuple(
          nested,
          fc.option(
            def.kind === 'union'
              ? fc.constant(undefined)
              : scalarWhere(targetType, 1),
            { nil: undefined },
          ),
        )
        .map(([s, w]) => (w ? { select: s, where: w } : { select: s })),
    );
    const connection = fc.oneof(
      fc.constant(true),
      fc
        .tuple(
          fc.boolean(),
          fc.oneof(
            fc.constant(true as unknown),
            fc.record(
              {
                node: fc.oneof(
                  fc.constant(true as unknown),
                  nested.map((s) => ({ select: s })),
                ),
                ...(def.edge
                  ? { properties: fc.constant(true as unknown) }
                  : {}),
              },
              { requiredKeys: [] },
            ),
          ),
          // Excluded: AND/OR/NOT in a typed-select connection where throws
          // OGMError ("not yet supported") although the types offer it.
          fc.option(
            connectionWhere(def, undefined, 1, true, { logical: false }),
            { nil: undefined },
          ),
        )
        .map(([total, edges, w]) => {
          const sel: Rec = { edges };
          if (total) sel.totalCount = true;
          return w ? { select: sel, where: w } : { select: sel };
        }),
    );
    return fc.oneof(
      plain.map((v) => ({ [def.field]: v })),
      connection.map((v) => ({ [`${def.field}Connection`]: v })),
    );
  };
  return fc
    .tuple(
      scalars,
      fc
        .uniqueArray(fc.constantFrom(...rels), { maxLength: 2 })
        .chain((ds) => fc.tuple(...ds.map(relSel))),
    )
    .map(([s, r]) => Object.assign({}, s, ...r));
}

const READ_MODELS = [
  'ItPTag',
  'ItPChart',
  'ItPCategory',
  'ItPDrug',
  'ItPDoc',
  'ItPVault',
];

function findOptions(
  type: string,
  paging = true,
): fc.Arbitrary<Rec | undefined> {
  if (!paging)
    return fc.option(
      fc
        .uniqueArray(fc.constantFrom('id', ...SCALAR_FIELDS[type]), {
          minLength: 1,
          maxLength: 2,
        })
        .chain((fs) =>
          fc.tuple(
            ...fs.map((f) =>
              fc.constantFrom('ASC', 'DESC').map((d) => ({ [f]: d })),
            ),
          ),
        )
        .map((sort) => ({ sort })),
      { nil: undefined },
    );
  return fc.option(
    fc.record(
      {
        limit: fc.integer({ min: 0, max: 4 }),
        offset: fc.integer({ min: 0, max: 3 }),
        sort: fc
          .uniqueArray(fc.constantFrom('id', ...SCALAR_FIELDS[type]), {
            minLength: 1,
            maxLength: 2,
          })
          .chain((fs) =>
            fc.tuple(
              ...fs.map((f) =>
                fc.constantFrom('ASC', 'DESC').map((d) => ({ [f]: d })),
              ),
            ),
          ),
      },
      { requiredKeys: [] },
    ),
    { nil: undefined },
  );
}

/**
 * A random read on any model or the interface model. `paging: false`
 * leaves out `limit` / `offset` (root and nested), whose page is not
 * deterministic without a total order — for comparing two OGMs' rows.
 */
export function readOp(depth = 2, paging = true): fc.Arbitrary<ReadOp> {
  const scoped = (w: Rec | undefined): Rec => ({ runId: '@run', ...(w ?? {}) });
  const find = fc.constantFrom(...READ_MODELS).chain((model) =>
    fc
      .tuple(
        fc.option(readWhere(model, depth), { nil: undefined }),
        fc.oneof(
          selectionSet(model, depth, paging).map((s) => ({ selectionSet: s })),
          select(model, depth).map((s) => ({ select: s })),
        ),
        findOptions(model, paging),
      )
      .map(
        ([where, sel, options]): ReadOp => ({
          kind: 'find',
          model,
          where: scoped(where),
          ...sel,
          ...(options && Object.keys(options).length ? { options } : {}),
        }),
      ),
  );
  const count = fc
    .constantFrom(...READ_MODELS)
    .chain((model) =>
      fc
        .option(readWhere(model, depth), { nil: undefined })
        .map(
          (where): ReadOp => ({ kind: 'count', model, where: scoped(where) }),
        ),
    );
  const aggregate = fc.constantFrom(...READ_MODELS).chain((model) =>
    fc
      .tuple(
        fc.option(readWhere(model, depth), { nil: undefined }),
        someKeys({
          count: fc.constant(true),
          name: fc.constant(true),
          rank: fc.constant(true),
          id: fc.constant(true),
        }),
      )
      .map(
        ([where, aggregate]): ReadOp => ({
          kind: 'aggregate',
          model,
          where: scoped(where),
          aggregate,
        }),
      ),
  );
  const iface = fc
    .tuple(
      fc.option(scalarWhere('ItPResource', 1), { nil: undefined }),
      fc
        .tuple(
          selectionSet('ItPResource', 0),
          fc
            .uniqueArray(fc.constantFrom('ItPChart', 'ItPDrug'), {
              maxLength: 2,
            })
            .chain((ms) =>
              fc.tuple(
                ...ms.map((m) =>
                  selectionSet(m, depth - 1, paging).map(
                    (s) => `... on ${m} ${s}`,
                  ),
                ),
              ),
            ),
        )
        .map(([base, frags]) => `${base.slice(0, -1)} ${frags.join(' ')} }`),
      findOptions('ItPResource', paging),
    )
    .map(
      ([where, selectionSet, options]): ReadOp => ({
        kind: 'interfaceFind',
        model: 'ItPResource',
        where: scoped(where),
        selectionSet,
        ...(options && Object.keys(options).length ? { options } : {}),
      }),
    );
  return fc.oneof(
    { weight: 6, arbitrary: find },
    { weight: 1, arbitrary: count },
    { weight: 1, arbitrary: aggregate },
    { weight: 2, arbitrary: iface },
  );
}

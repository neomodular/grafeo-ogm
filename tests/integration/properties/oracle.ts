/**
 * Independent oracles for the write properties. Nothing here calls the OGM:
 * the root `where` is evaluated in JS (Cypher three-valued logic), the
 * write's reach is derived from the INPUT walked against the static schema
 * map (`RELS`) and the before/after snapshots, and policies come from
 * `POLICY_MIRROR`.
 */
import { isInt } from 'neo4j-driver';
import { RELS, relDef, type RelDef, type WriteOp } from './arbitraries';
import type { GraphDiff, NodeSnap, RelSnap, Snapshot } from './harness';
import { POLICY_MIRROR, type Ctx } from './schema';

type Rec = Record<string, unknown>;
type B3 = boolean | null;

// --- root where evaluation ----------------------------------------------------

const SUFFIXES = [
  '_NOT_IN',
  '_IN',
  '_NOT_CONTAINS',
  '_NOT_STARTS_WITH',
  '_NOT_ENDS_WITH',
  '_CONTAINS',
  '_STARTS_WITH',
  '_ENDS_WITH',
  '_LTE',
  '_LT',
  '_GTE',
  '_GT',
  '_NOT',
];

const and3 = (xs: B3[]): B3 =>
  xs.some((x) => x === false)
    ? false
    : xs.some((x) => x === null)
      ? null
      : true;
const or3 = (xs: B3[]): B3 =>
  xs.some((x) => x === true) ? true : xs.some((x) => x === null) ? null : false;
const not3 = (x: B3): B3 => (x === null ? null : !x);

function plain(v: unknown): unknown {
  if (isInt(v)) return (v as { toNumber(): number }).toNumber();
  return v;
}

function eq(a: unknown, b: unknown): B3 {
  if (a === null || a === undefined || b === null || b === undefined)
    return null;
  return a === b;
}

/** Evaluate a scalar root where against stored properties. */
export function evalWhere(where: Rec, props: Rec): B3 {
  const parts: B3[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (key === 'AND') {
      parts.push(and3((value as Rec[]).map((w) => evalWhere(w, props))));
      continue;
    }
    if (key === 'OR') {
      parts.push(or3((value as Rec[]).map((w) => evalWhere(w, props))));
      continue;
    }
    if (key === 'NOT') {
      parts.push(not3(evalWhere(value as Rec, props)));
      continue;
    }
    const suffix = SUFFIXES.find((s) => key.endsWith(s)) ?? '';
    const field = key.slice(0, key.length - suffix.length);
    const p = plain(props[field]);
    const missing = p === null || p === undefined;
    const str = (fn: (s: string, v: string) => boolean): B3 =>
      missing ? null : fn(String(p), String(value));
    const cmp = (fn: (a: number, b: number) => boolean): B3 =>
      missing ? null : fn(p as number, value as number);
    const inList = (): B3 => {
      if (missing) return null;
      const xs = value as unknown[];
      if (xs.includes(p)) return true;
      return xs.some((x) => x === null) ? null : false;
    };
    switch (suffix) {
      case '':
        parts.push(eq(p, value));
        break;
      case '_NOT':
        parts.push(not3(eq(p, value)));
        break;
      case '_IN':
        parts.push(inList());
        break;
      case '_NOT_IN':
        parts.push(not3(inList()));
        break;
      case '_CONTAINS':
        parts.push(str((s, v) => s.includes(v)));
        break;
      case '_NOT_CONTAINS':
        parts.push(not3(str((s, v) => s.includes(v))));
        break;
      case '_STARTS_WITH':
        parts.push(str((s, v) => s.startsWith(v)));
        break;
      case '_NOT_STARTS_WITH':
        parts.push(not3(str((s, v) => s.startsWith(v))));
        break;
      case '_ENDS_WITH':
        parts.push(str((s, v) => s.endsWith(v)));
        break;
      case '_NOT_ENDS_WITH':
        parts.push(not3(str((s, v) => s.endsWith(v))));
        break;
      case '_LT':
        parts.push(cmp((a, b) => a < b));
        break;
      case '_LTE':
        parts.push(cmp((a, b) => a <= b));
        break;
      case '_GT':
        parts.push(cmp((a, b) => a > b));
        break;
      case '_GTE':
        parts.push(cmp((a, b) => a >= b));
        break;
    }
  }
  return and3(parts);
}

/** Existing nodes of `type` matched by a (resolved) root where. */
export function matchRoots(
  snap: Snapshot,
  type: string,
  where: Rec,
): NodeSnap[] {
  return [...snap.nodes.values()].filter(
    (n) => n.labels.includes(type) && evalWhere(where, n.props) === true,
  );
}

// --- write envelope ---------------------------------------------------------------

/** One relationship the write may add / remove / modify. */
export interface RelEntry {
  /** The node whose own relationship set the write changes. */
  owner: string;
  other: string;
  type: string;
  ownerIsStart: boolean;
  /** What put it in the envelope (for failure messages). */
  via: string;
}

export interface Envelope {
  roots: Set<string>;
  propsMay: Set<string>;
  mayDelete: Set<string>;
  /** Expected created node id → its concrete type. */
  created: Map<string, string>;
  rels: Map<string, RelEntry[]>;
}

const relKey = (start: string, type: string, end: string) =>
  `${start}|${type}|${end}`;

/**
 * Everything a write is ALLOWED to touch: a superset that ignores nested
 * `where`s (they can only narrow), but never widens past the relationship
 * type, direction and target labels of the field each op names.
 */
export function writeEnvelope(
  op: WriteOp,
  before: Snapshot,
  after: Snapshot,
  rootFilter: (n: NodeSnap, kind: 'update' | 'delete') => boolean = () => true,
): Envelope {
  const env: Envelope = {
    roots: new Set(),
    propsMay: new Set(),
    mayDelete: new Set(),
    created: new Map(),
    rels: new Map(),
  };
  const nodeType = (k: string) =>
    before.nodes.get(k)?.type ?? after.nodes.get(k)?.type ?? env.created.get(k);
  const ofMembers = (k: string, members: string[]) => {
    const n = before.nodes.get(k) ?? after.nodes.get(k);
    if (n) return members.some((m) => n.labels.includes(m));
    const t = env.created.get(k);
    return t !== undefined && members.includes(t);
  };
  /**
   * Nodes linked to `k` over `def`: before or after the write, or through
   * a link this same write may add earlier in the statement (a connect in
   * one item, then a nested op in the next item; the link may even be
   * removed again, so it is in neither snapshot). Those come from the
   * previous pass's allowed relationships — see the fixpoint below.
   */
  const adjacent = (k: string, def: RelDef, members: string[]): string[] => {
    const out = new Set<string>();
    const consider = (start: string, type: string, end: string) => {
      if (type !== def.type) return;
      const other =
        def.dir === 'OUT'
          ? start === k
            ? end
            : null
          : end === k
            ? start
            : null;
      if (other !== null && ofMembers(other, members)) out.add(other);
    };
    for (const rels of [before.rels, after.rels])
      for (const r of rels) consider(r.start, r.type, r.end);
    for (const key of env.rels.keys()) {
      const [start, type, end] = key.split('|');
      consider(start, type, end);
    }
    return [...out];
  };
  const allOf = (members: string[]): string[] => {
    const out = new Set<string>();
    for (const snap of [before, after])
      for (const n of snap.nodes.values())
        if (members.some((m) => n.labels.includes(m))) out.add(n.key);
    for (const [k, t] of env.created) if (members.includes(t)) out.add(k);
    return [...out];
  };
  const allowRel = (owner: string, def: RelDef, other: string, via: string) => {
    const ownerIsStart = def.dir === 'OUT';
    const key = ownerIsStart
      ? relKey(owner, def.type, other)
      : relKey(other, def.type, owner);
    const list = env.rels.get(key) ?? [];
    if (!list.some((e) => e.owner === owner && e.via === via))
      env.rels.set(key, [
        ...list,
        { owner, other, type: def.type, ownerIsStart, via },
      ]);
  };
  const membersOf = (def: RelDef, member?: string) =>
    member ? [member] : def.members;

  // Walkers ---------------------------------------------------------------
  const walkCreate = (type: string, input: Rec, via: string): string => {
    const id = input.id as string;
    env.created.set(id, type);
    for (const def of RELS[type] ?? []) {
      const field = input[def.field] as Rec | undefined;
      if (!field) continue;
      if (def.kind === 'union')
        for (const [m, sub] of Object.entries(field))
          walkFieldInput(
            [id],
            type,
            def,
            m,
            sub as Rec,
            `${via}.${def.field}.${m}`,
          );
      else
        walkFieldInput(
          [id],
          type,
          def,
          undefined,
          field,
          `${via}.${def.field}`,
        );
    }
    return id;
  };
  const walkFieldInput = (
    frontier: string[],
    type: string,
    def: RelDef,
    member: string | undefined,
    field: Rec,
    via: string,
  ) => {
    if (field.connect)
      walkConnect(
        frontier,
        def,
        member,
        field.connect as Rec[],
        `${via}.connect`,
      );
    if (field.create)
      walkCreateItems(
        frontier,
        def,
        member,
        field.create as Rec[],
        `${via}.create`,
      );
    void type;
  };
  const walkCreateItems = (
    frontier: string[],
    def: RelDef,
    member: string | undefined,
    its: Rec[],
    via: string,
  ) => {
    for (const item of its) {
      let node = item.node as Rec;
      let t = member ?? def.members[0];
      if (def.kind === 'interface') {
        const [m, n] = Object.entries(node)[0] as [string, Rec];
        t = m;
        node = n;
      }
      const id = walkCreate(t, node, via);
      for (const f of frontier) allowRel(f, def, id, via);
    }
  };
  const walkConnect = (
    frontier: string[],
    def: RelDef,
    member: string | undefined,
    its: Rec[] | null,
    via: string,
  ) => {
    const targets = allOf(membersOf(def, member));
    for (const f of frontier) for (const t of targets) allowRel(f, def, t, via);
    for (const item of its ?? []) {
      const nested = item?.connect as Rec[] | Rec | undefined;
      if (!nested) continue;
      const targetType = member ?? def.members[0];
      for (const ci of Array.isArray(nested) ? nested : [nested])
        walkConnectInput(targets, targetType, ci, `${via}.connect`);
    }
  };
  const walkConnectInput = (
    frontier: string[],
    type: string,
    input: Rec,
    via: string,
  ) => {
    for (const [field, its] of Object.entries(input)) {
      const def = relDef(type, field);
      if (def.kind === 'union')
        for (const [m, sub] of Object.entries(its as Rec))
          walkConnect(frontier, def, m, sub as Rec[], `${via}.${field}.${m}`);
      else
        walkConnect(frontier, def, undefined, its as Rec[], `${via}.${field}`);
    }
  };
  const walkDisconnect = (
    frontier: string[],
    def: RelDef,
    member: string | undefined,
    its: Rec[] | null,
    via: string,
  ) => {
    const members = membersOf(def, member);
    const reached = new Set<string>();
    for (const f of frontier)
      for (const t of adjacent(f, def, members)) {
        allowRel(f, def, t, via);
        reached.add(t);
      }
    const targetType = member ?? def.members[0];
    for (const item of its ?? [])
      if (item?.disconnect)
        walkDisconnectInput(
          [...reached],
          targetType,
          item.disconnect as Rec,
          `${via}.disconnect`,
        );
  };
  const walkDisconnectInput = (
    frontier: string[],
    type: string,
    input: Rec,
    via: string,
  ) => {
    for (const [field, its] of Object.entries(input)) {
      const def = relDef(type, field);
      if (def.kind === 'union' && !Array.isArray(its))
        for (const [m, sub] of Object.entries((its ?? {}) as Rec))
          walkDisconnect(
            frontier,
            def,
            m,
            sub as Rec[],
            `${via}.${field}.${m}`,
          );
      else
        walkDisconnect(
          frontier,
          def,
          undefined,
          its as Rec[] | null,
          `${via}.${field}`,
        );
    }
  };
  const walkDelete = (
    frontier: string[],
    def: RelDef,
    member: string | undefined,
    its: Rec[] | null,
    via: string,
  ) => {
    const members = membersOf(def, member);
    const reached = new Set<string>();
    for (const f of frontier)
      for (const t of adjacent(f, def, members)) {
        env.mayDelete.add(t);
        reached.add(t);
      }
    const targetType = member ?? def.members[0];
    for (const item of its ?? [])
      if (item?.delete)
        walkDeleteInput(
          [...reached],
          targetType,
          item.delete as Rec,
          `${via}.delete`,
        );
  };
  const walkDeleteInput = (
    frontier: string[],
    type: string,
    input: Rec,
    via: string,
  ) => {
    for (const [field, its] of Object.entries(input)) {
      const def = relDef(type, field);
      if (def.kind === 'union' && !Array.isArray(its))
        for (const [m, sub] of Object.entries((its ?? {}) as Rec))
          walkDelete(frontier, def, m, sub as Rec[], `${via}.${field}.${m}`);
      else
        walkDelete(
          frontier,
          def,
          undefined,
          its as Rec[] | null,
          `${via}.${field}`,
        );
    }
  };
  const walkUpdateBody = (
    frontier: string[],
    type: string,
    body: Rec,
    via: string,
  ) => {
    for (const f of frontier) env.propsMay.add(f);
    for (const def of RELS[type] ?? []) {
      const field = body[def.field];
      if (!field) continue;
      if (def.kind === 'union')
        for (const [m, its] of Object.entries(field as Rec))
          for (const item of its as Rec[])
            walkUpdateItem(frontier, def, m, item, `${via}.${def.field}.${m}`);
      else
        for (const item of field as Rec[])
          walkUpdateItem(frontier, def, undefined, item, `${via}.${def.field}`);
    }
  };
  const walkUpdateItem = (
    frontier: string[],
    def: RelDef,
    member: string | undefined,
    item: Rec,
    via: string,
  ) => {
    if (item.delete)
      walkDelete(frontier, def, member, item.delete as Rec[], `${via}.delete`);
    if (item.disconnect)
      walkDisconnect(
        frontier,
        def,
        member,
        item.disconnect as Rec[],
        `${via}.disconnect`,
      );
    if (item.connect)
      walkConnect(
        frontier,
        def,
        member,
        item.connect as Rec[],
        `${via}.connect`,
      );
    if (item.create)
      walkCreateItems(
        frontier,
        def,
        member,
        item.create as Rec[],
        `${via}.create`,
      );
    const upd = item.update as Rec | undefined;
    if (upd) {
      const members = membersOf(def, member);
      const targets = new Set<string>();
      for (const f of frontier)
        for (const t of adjacent(f, def, members)) targets.add(t);
      if (upd.edge)
        for (const f of frontier)
          for (const t of targets) allowRel(f, def, t, `${via}.update.edge`);
      const node = upd.node as Rec | undefined;
      if (node) {
        const perMember =
          def.kind === 'interface' &&
          Object.keys(node).every((k) => def.members.includes(k));
        if (perMember) {
          for (const [m, b] of Object.entries(node))
            walkUpdateBody(
              [...targets].filter((t) => nodeType(t) === m),
              m,
              b as Rec,
              `${via}.update.node.${m}`,
            );
        } else if (def.kind === 'interface') {
          // Flat interface fields: scalars only, on every implementor target.
          for (const t of targets) env.propsMay.add(t);
        } else
          walkUpdateBody(
            [...targets],
            member ?? def.members[0],
            node,
            `${via}.update.node`,
          );
      }
    }
  };

  // Root: walked to a fixpoint, since a later pass can reach nodes through
  // links an earlier pass allowed.
  const size = () =>
    env.rels.size + env.propsMay.size + env.mayDelete.size + env.created.size;
  for (let pass = 0, last = -1; pass < 5 && size() !== last; pass++) {
    last = size();
    walkRoot();
  }
  return env;

  function walkRoot(): void {
    switch (op.kind) {
      case 'create':
        for (const input of op.input) walkCreate(op.model, input, 'create');
        break;
      case 'createMany':
        for (const input of op.data)
          env.created.set(input.id as string, op.model);
        break;
      case 'upsert': {
        const id = (op.where as Rec).id as string;
        const existing = before.nodes.get(id);
        if (existing && existing.labels.includes(op.model)) {
          env.roots.add(id);
          env.propsMay.add(id);
        } else env.created.set(id, op.model);
        break;
      }
      case 'update':
      case 'updateMany': {
        const roots = matchRoots(before, op.model, op.where)
          .filter((n) => rootFilter(n, 'update'))
          .map((n) => n.key);
        for (const r of roots) env.roots.add(r);
        const body = op.kind === 'update' ? op.update : op.data;
        if (body) walkUpdateBody(roots, op.model, body, 'update');
        if (op.kind === 'update') {
          if (op.connect)
            walkConnectInput(roots, op.model, op.connect, 'connect');
          if (op.disconnect)
            walkDisconnectInput(roots, op.model, op.disconnect, 'disconnect');
        }
        break;
      }
      case 'delete':
      case 'deleteMany': {
        const roots = matchRoots(before, op.model, op.where)
          .filter((n) => rootFilter(n, 'delete'))
          .map((n) => n.key);
        for (const r of roots) {
          env.roots.add(r);
          env.mayDelete.add(r);
        }
        if (op.kind === 'delete' && op.delete)
          walkDeleteInput(roots, op.model, op.delete, 'delete');
        break;
      }
    }
  }
}

// --- rule checks --------------------------------------------------------------------

const touchesDeleted = (r: RelSnap, d: GraphDiff) =>
  d.deleted.some((n) => n.key === r.start || n.key === r.end);

/** Rule 3: every change lies inside the write's envelope. */
export function scopeViolations(diff: GraphDiff, env: Envelope): string[] {
  const out: string[] = [];
  for (const n of diff.created) {
    const t = env.created.get(n.key);
    if (t === undefined)
      out.push(`unexpected node created: ${n.key} ${n.labels.join(':')}`);
    else if (!n.labels.includes(t))
      out.push(
        `created ${n.key} has labels ${n.labels.join(':')}, expected ${t}`,
      );
  }
  for (const n of diff.deleted)
    if (!env.mayDelete.has(n.key))
      out.push(
        `node deleted outside the write's reach: ${n.key} ${n.labels.join(':')}`,
      );
  for (const { before, after } of diff.changed) {
    if (!env.propsMay.has(before.key))
      out.push(`properties changed outside the write's reach: ${before.key}`);
    if (before.labels.join(':') !== after.labels.join(':'))
      out.push(`labels changed: ${before.key}`);
  }
  for (const [rels, verb] of [
    [diff.relsAdded, 'added'],
    [diff.relsRemoved, 'removed'],
  ] as const)
    for (const r of rels) {
      if (verb === 'removed' && touchesDeleted(r, diff)) continue;
      if (!env.rels.has(relKey(r.start, r.type, r.end)))
        out.push(
          `relationship ${verb} outside the write's reach: ${r.start}-[${r.type}]->${r.end}`,
        );
    }
  return out;
}

/** Rule 4: every change is authorised by the mirrored policies. */
export function policyViolations(
  diff: GraphDiff,
  env: Envelope,
  before: Snapshot,
  after: Snapshot,
  ctx: Ctx,
): string[] {
  const out: string[] = [];
  const created = new Set(diff.created.map((n) => n.key));
  const readable = (k: string) => {
    if (created.has(k)) return true;
    const b = before.nodes.get(k);
    const a = after.nodes.get(k);
    return (
      (b !== undefined && POLICY_MIRROR.readable(b.type, b.props)) ||
      (a !== undefined && POLICY_MIRROR.readable(a.type, a.props))
    );
  };
  const updatable = (k: string) => {
    if (created.has(k)) return true;
    const b = before.nodes.get(k);
    return b !== undefined && POLICY_MIRROR.updatable(b.type, b.props, ctx);
  };
  for (const n of diff.created)
    if (!POLICY_MIRROR.creatable(n.type, n.props, ctx))
      out.push(`created ${n.key} (${n.type}) fails its create policy`);
  for (const n of diff.deleted)
    if (!POLICY_MIRROR.deletable(n.type, n.props, ctx))
      out.push(`deleted ${n.key} (${n.type}) is not deletable`);
  for (const { before: b, after: a } of diff.changed) {
    if (!POLICY_MIRROR.updatable(b.type, b.props, ctx))
      out.push(`changed ${b.key} (${b.type}) is not updatable`);
    if (!POLICY_MIRROR.updateCheck(b.type, b.props, a.props, ctx))
      out.push(`changed ${b.key} fails its update WITH CHECK`);
  }
  // A relationship removed and re-added between the same endpoints had its
  // PROPERTIES changed (edge update, connect overwrite): its owner must be
  // updatable and the other end readable (connect) or updatable (nested
  // update edge), as the equivalent direct writes require.
  const k3 = (r: RelSnap) => relKey(r.start, r.type, r.end);
  const removedKeys = new Set(diff.relsRemoved.map(k3));
  const modified = new Set(
    diff.relsAdded.map(k3).filter((k) => removedKeys.has(k)),
  );
  for (const key of modified) {
    const entries = env.rels.get(key) ?? [];
    if (
      !entries.some(
        (e) => updatable(e.owner) && (readable(e.other) || updatable(e.other)),
      )
    )
      out.push(
        `relationship properties changed on ${key.split('|').join(' ')}: no owner ${entries
          .map((e) => `${e.owner} (via ${e.via})`)
          .join(' / ')} is updatable with a readable or updatable other end`,
      );
  }
  for (const [rels, verb] of [
    [diff.relsAdded, 'added'],
    [diff.relsRemoved, 'removed'],
  ] as const)
    for (const r of rels) {
      if (modified.has(k3(r))) continue;
      if (verb === 'removed' && touchesDeleted(r, diff)) continue;
      const entries = env.rels.get(k3(r)) ?? [];
      const owners = new Set(
        entries.filter((e) => updatable(e.owner)).map((e) => e.owner),
      );
      for (const k of [r.start, r.end])
        if (!readable(k) && !(OWNER_NEEDS_UPDATE_ONLY && owners.has(k)))
          out.push(
            `relationship ${verb} ${r.start}-[${r.type}]->${r.end}: endpoint ${k} is not readable`,
          );
      if (entries.length > 0 && owners.size === 0)
        out.push(
          `relationship ${verb} ${r.start}-[${r.type}]->${r.end}: its owner ${entries
            .map((e) => `${e.owner} (via ${e.via})`)
            .join(' / ')} is neither updatable nor created`,
        );
    }
  return out;
}

/**
 * Rule 4b (finding F6, fixed in v2.6.1): every row a mutation RETURNS is
 * readable by the context in its post-write state — the response applies
 * the root `read` policy as `find` does. Rows are the arrays of a
 * create / update response (`{ info, <plural>: [...] }`) and the node an
 * upsert returns; each carries its `id` (the default selection).
 */
export function responseViolations(
  op: WriteOp,
  result: unknown,
  after: Snapshot,
): string[] {
  const rows: Rec[] = [];
  if (op.kind === 'upsert') {
    if (result && typeof result === 'object') rows.push(result as Rec);
  } else if (op.kind === 'create' || op.kind === 'update') {
    for (const [key, value] of Object.entries((result ?? {}) as Rec))
      if (key !== 'info' && Array.isArray(value))
        rows.push(...(value as Rec[]));
  }
  const out: string[] = [];
  for (const row of rows) {
    const n = typeof row.id === 'string' ? after.nodes.get(row.id) : undefined;
    if (n === undefined)
      out.push(`response row ${String(row.id)} is not a node of the run`);
    else if (!POLICY_MIRROR.readable(n.type, n.props))
      out.push(`response returned ${n.key} (${n.type}), which is not readable`);
  }
  return out;
}

/**
 * Finding F6, decided in v2.6.1 — the node a write is performed ON (a root
 * of `update`, a nested-update target, the intermediate of a nested
 * connect) is gated by its `update` policy only, never by `read`: a
 * context may update, link and unlink a node it cannot read (README
 * "Relationships and nested writes": nested update = `update` row
 * filter). What v2.6.1 changed is the RESPONSE: such a node is no longer
 * returned (rule 4b, `responseViolations`). So the rule "both endpoints
 * readable" stays relaxed for the OWNER endpoint only, which must then be
 * updatable; the other endpoint — the node being linked or unlinked —
 * must still be readable.
 */
const OWNER_NEEDS_UPDATE_ONLY = true;

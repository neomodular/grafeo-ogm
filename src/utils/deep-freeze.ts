/**
 * Deep-frozen snapshot of a plain-object/array graph.
 *
 * v1.8.7 — `withContext` previously shallow-froze the ctx spread, so a
 * policy callback running mid-pipeline could mutate NESTED ctx state
 * (`ctx.user.roles.push('admin')`) and every subsequent policy decision
 * in the same request — including nested-selection target policies —
 * would see the escalated context. This helper delivers the "frozen ctx
 * snapshot" the `withContext` contract documents:
 *
 * - Plain objects and arrays are CLONED recursively and each clone is
 *   frozen. Cloning (rather than freezing in place) means the caller's
 *   original objects stay mutable — freezing shared references would
 *   break auth layers that legitimately mutate their own role arrays
 *   after the request.
 * - Non-plain values (class instances, Dates, Maps, functions) are kept
 *   BY REFERENCE and left unfrozen — freezing them would break their
 *   internal mutation, and they are not part of the record-of-primitives
 *   shape the freeze defends. Policy authors embedding mutable services
 *   in ctx retain responsibility for those objects.
 * - Cycles are preserved via a source→clone map.
 *
 * Note: nested identity is NOT preserved for plain objects (`snapshot.user
 * !== original.user`). Top-level identity was already broken by the
 * `{ ...ctx }` spread, so policies must not rely on reference equality
 * against external state.
 */
export function deepFreezeSnapshot<T>(value: T): T {
  return cloneAndFreeze(value, new WeakMap()) as T;
}

function cloneAndFreeze(
  value: unknown,
  seen: WeakMap<object, unknown>,
): unknown {
  if (value === null || typeof value !== 'object') return value;

  const existing = seen.get(value);
  if (existing !== undefined) return existing;

  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    for (const item of value) clone.push(cloneAndFreeze(item, seen));
    return Object.freeze(clone);
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  const clone: Record<string, unknown> = {};
  seen.set(value, clone);
  for (const key of Object.keys(value))
    clone[key] = cloneAndFreeze((value as Record<string, unknown>)[key], seen);
  return Object.freeze(clone);
}

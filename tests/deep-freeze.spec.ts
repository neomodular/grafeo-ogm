import { deepFreezeSnapshot } from '../src/utils/deep-freeze';

// v1.8.7 — withContext ctx hardening. See src/utils/deep-freeze.ts for
// the full contract; these tests pin the four load-bearing behaviors.
describe('deepFreezeSnapshot', () => {
  it('freezes nested plain objects and arrays all the way down', () => {
    const snapshot = deepFreezeSnapshot({
      uid: 'alex',
      user: { roles: ['viewer'], prefs: { theme: 'dark' } },
    });

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.user)).toBe(true);
    expect(Object.isFrozen(snapshot.user.roles)).toBe(true);
    expect(Object.isFrozen(snapshot.user.prefs)).toBe(true);
    expect(() => snapshot.user.roles.push('admin')).toThrow(TypeError);
  });

  it('clones instead of freezing in place — originals stay mutable', () => {
    const original = { user: { roles: ['viewer'] } };
    const snapshot = deepFreezeSnapshot(original);

    expect(snapshot).not.toBe(original);
    expect(snapshot.user).not.toBe(original.user);
    expect(Object.isFrozen(original)).toBe(false);
    expect(Object.isFrozen(original.user)).toBe(false);
    original.user.roles.push('editor');
    expect(original.user.roles).toContain('editor');
    // The snapshot keeps the values from snapshot time.
    expect(snapshot.user.roles).toEqual(['viewer']);
  });

  it('keeps non-plain values (class instances, functions) by reference, unfrozen', () => {
    class AuthService {
      calls = 0;
    }
    const svc = new AuthService();
    const when = new Date('2026-01-01');
    const snapshot = deepFreezeSnapshot({ svc, when, fn: () => 42 });

    expect(snapshot.svc).toBe(svc);
    expect(snapshot.when).toBe(when);
    expect(snapshot.fn()).toBe(42);
    expect(Object.isFrozen(snapshot.svc)).toBe(false);
    // Date internals must keep working (freezing would break setTime).
    expect(() => snapshot.when.setFullYear(2027)).not.toThrow();
  });

  it('handles cycles without infinite recursion, preserving structure', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    const snapshot = deepFreezeSnapshot(a) as { name: string; self: unknown };

    expect(snapshot.self).toBe(snapshot);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('passes primitives and null through untouched', () => {
    expect(deepFreezeSnapshot(null)).toBeNull();
    expect(deepFreezeSnapshot(42)).toBe(42);
    expect(deepFreezeSnapshot('x')).toBe('x');
    expect(deepFreezeSnapshot(undefined)).toBeUndefined();
  });
});

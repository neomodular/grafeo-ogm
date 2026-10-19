/**
 * v2.6.0 — strict-mode plumbing: the per-OGM switch and its warn-once log.
 */
import { StrictMode } from '../src/utils/strict-mode';

function logger() {
  return { debug: jest.fn(), warn: jest.fn() };
}

describe('StrictMode warn-once log (v2.6.0)', () => {
  it('logs a key once per instance, naming strict mode and 3.0', () => {
    const log = logger();
    const mode = new StrictMode(false, log);
    for (let i = 0; i < 5; i++)
      mode.warn('code-a', 'User.posts', 'Problem A.', 'fix A');
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      '[OGM] Problem A. Enable `strict: true` (default in 3.0) to fix A.',
    );
  });

  it('logs distinct keys separately, and each instance on its own', () => {
    const log = logger();
    const a = new StrictMode(false, log);
    const b = new StrictMode(false, log);
    a.warn('code-a', 'x', 'P.', 'f');
    a.warn('code-a', 'y', 'P.', 'f');
    a.warn('code-b', 'x', 'P.', 'f');
    b.warn('code-a', 'x', 'P.', 'f');
    expect(log.warn).toHaveBeenCalledTimes(4);
  });

  it('never logs in strict mode', () => {
    const log = logger();
    new StrictMode(true, log).warn('code-a', 'x', 'P.', 'f');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('tolerates a logger without warn, and no logger', () => {
    expect(() =>
      new StrictMode(false, { debug: () => {} }).warn('c', 'd', 'P.', 'f'),
    ).not.toThrow();
    expect(() => new StrictMode(false).warn('c', 'd', 'P.', 'f')).not.toThrow();
  });

  it('bounds the key set: past 1000 details only the code dedupes', () => {
    const log = logger();
    const mode = new StrictMode(false, log);
    for (let i = 0; i < 1000; i++) mode.warn('code-a', String(i), 'P.', 'f');
    expect(log.warn).toHaveBeenCalledTimes(1000);
    for (let i = 1000; i < 1100; i++) mode.warn('code-z', String(i), 'P.', 'f');
    expect(log.warn).toHaveBeenCalledTimes(1001);
  });
});

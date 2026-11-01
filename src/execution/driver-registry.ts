import type { Driver } from 'neo4j-driver';

/**
 * v2.27.0 — the driver each `Model` / `InterfaceModel` runs its statements
 * through, keyed by the model instance. Internal: `compile()` (from
 * `grafeo-ogm/testing`) reads it to refuse any model that can reach a
 * database. A WeakMap, so it adds no member to the model types and holds
 * no model alive.
 */
const DRIVERS = new WeakMap<object, Driver>();

/** Record the driver `owner` executes through. */
export function bindDriver(owner: object, driver: Driver): void {
  DRIVERS.set(owner, driver);
}

/** The driver `owner` executes through, if it is a model. */
export function driverOf(owner: object): Driver | undefined {
  return DRIVERS.get(owner);
}

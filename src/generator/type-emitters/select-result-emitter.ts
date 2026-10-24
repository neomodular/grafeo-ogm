/**
 * Emits the schema-independent `SelectFields` base type and `SelectResult`
 * utility type that infers return shapes from a `select` object.
 *
 * These types are emitted once per generated file and do not depend on
 * the parsed schema.
 */
export function emitSelectResultType(): string {
  return `export type SelectFields = Record<
  string,
  boolean | { select: SelectFields } | { where?: unknown; select: unknown }
>;

/** vNEXT — the result of a point field's \`{ select: { longitude: true } }\`. */
type PointValueShape = { x: number; y: number; z?: number; srid: number };

type IsPointValue<V> = [V] extends [PointValueShape]
  ? [Exclude<keyof V, keyof PointValueShape>] extends [never]
    ? true
    : false
  : false;

type IsPointField<V> =
  NonNullable<V> extends Array<infer E>
    ? IsPointValue<E>
    : IsPointValue<NonNullable<V>>;

type PointSelectValues = {
  longitude: number;
  latitude: number;
  height: number | null;
  x: number;
  y: number;
  z: number | null;
  crs: string;
  srid: number;
  __typename: string;
};

type PointSelectMap<S> = {
  [P in keyof S & keyof PointSelectValues as S[P] extends true
    ? P
    : never]: PointSelectValues[P];
};

type PointSelectResult<V, S> =
  NonNullable<V> extends Array<unknown>
    ? Array<PointSelectMap<S>> | Extract<V, null | undefined>
    : PointSelectMap<S> | Extract<V, null | undefined>;

export type SelectResult<T, S extends SelectFields> = {
  [K in keyof S & keyof T]: S[K] extends true
    ? T[K]
    : S[K] extends { select: infer NestedS }
      ? IsPointField<T[K]> extends true
        ? PointSelectResult<T[K], NestedS>
        : T[K] extends Array<infer U>
          ? NestedS extends SelectFields
            ? Array<SelectResult<U, NestedS>>
            : T[K]
          : T[K] extends infer U | null | undefined
            ? NestedS extends SelectFields
              ? SelectResult<NonNullable<U>, NestedS> | null
              : T[K]
            : T[K]
      : never;
};

type MutationInfoFields = {
  nodesCreated: number;
  nodesDeleted: number;
  relationshipsCreated: number;
  relationshipsDeleted: number;
};

export type MutationInfoResult<S extends Record<string, boolean>> = {
  [K in keyof S & keyof MutationInfoFields]: MutationInfoFields[K];
};

export type MutationSelectResult<
  T,
  TPluralKey extends string,
  S extends Record<string, unknown>,
> =
  ('info' extends keyof S
    ? S['info'] extends Record<string, boolean>
      ? { info: MutationInfoResult<S['info']> }
      : {}
    : {})
  &
  (TPluralKey extends keyof S
    ? S[TPluralKey] extends SelectFields
      ? { [K in TPluralKey]: Array<SelectResult<T, S[TPluralKey] & SelectFields>> }
      : {}
    : {});`;
}

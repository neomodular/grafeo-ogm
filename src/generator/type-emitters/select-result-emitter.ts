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

export type SelectResult<T, S extends SelectFields> = {
  [K in keyof S & keyof T]: S[K] extends true
    ? T[K]
    : S[K] extends { select: infer NestedS }
      ? T[K] extends Array<infer U>
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

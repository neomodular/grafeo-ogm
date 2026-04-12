type FieldSpec = string | Record<string, FieldSpec[]>;

/**
 * Convenience factory for building GraphQL selection sets in tests.
 */
export class SelectionSetFactory {
  /**
   * Build a GraphQL selection set string from a simplified spec.
   *
   * @example
   *   SelectionSetFactory.gql(['id', 'name', { drugs: ['id', 'drugName'] }])
   *   // => '{ id name drugs { id drugName } }'
   */
  static gql(fields: FieldSpec[]): string {
    const parts: string[] = [];

    for (const field of fields)
      if (typeof field === 'string') parts.push(field);
      else
        for (const [key, nested] of Object.entries(field))
          parts.push(`${key} ${SelectionSetFactory.gql(nested)}`);

    return `{ ${parts.join(' ')} }`;
  }

  /**
   * Build a select object from a simplified spec.
   *
   * @example
   *   SelectionSetFactory.select(['id', 'name', { drugs: ['id', 'drugName'] }])
   *   // => { id: true, name: true, drugs: { select: { id: true, drugName: true } } }
   */
  static select(fields: FieldSpec[]): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const field of fields)
      if (typeof field === 'string') result[field] = true;
      else
        for (const [key, nested] of Object.entries(field))
          result[key] = { select: SelectionSetFactory.select(nested) };

    return result;
  }
}

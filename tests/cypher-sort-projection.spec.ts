import { compileSortClause } from '../src/utils/cypher-sort-projection';
import type { PropertyDefinition } from '../src/schema/types';

function storedProp(name: string, type = 'String'): PropertyDefinition {
  return {
    name,
    type,
    required: false,
    isArray: false,
    isListItemRequired: false,
    isGenerated: false,
    isUnique: false,
    isCypher: false,
    directives: [],
  };
}

function cypherProp(
  name: string,
  statement: string,
  columnName?: string,
): PropertyDefinition {
  return {
    name,
    type: 'String',
    required: false,
    isArray: false,
    isListItemRequired: false,
    isGenerated: false,
    isUnique: false,
    isCypher: true,
    cypherStatement: statement,
    cypherColumnName: columnName,
    directives: ['cypher'],
  };
}

function lookupFromMap(map: Map<string, PropertyDefinition>) {
  return (field: string) => map.get(field);
}

describe('compileSortClause', () => {
  it('emits ORDER BY n.<field> for stored fields with no pre-RETURN fragments', () => {
    const props = new Map([['title', storedProp('title')]]);

    const result = compileSortClause({
      sort: [{ title: 'ASC' }],
      nodeVar: 'n',
      propertyLookup: lookupFromMap(props),
    });

    expect(result.pre).toBe('');
    expect(result.orderBy).toBe('ORDER BY n.`title` ASC');
  });

  it('emits CALL subquery + WITH + alias for a single @cypher sort', () => {
    const props = new Map([
      [
        'insensitiveDrugName',
        cypherProp(
          'insensitiveDrugName',
          'RETURN toLower(this.drugName) AS insensitiveDrugName',
          'insensitiveDrugName',
        ),
      ],
    ]);

    const result = compileSortClause({
      sort: [{ insensitiveDrugName: 'ASC' }],
      nodeVar: 'n',
      propertyLookup: lookupFromMap(props),
    });

    expect(result.pre).toBe(
      [
        'CALL {',
        '  WITH n',
        '  WITH n AS this',
        '  RETURN toLower(this.drugName) AS insensitiveDrugName',
        '}',
        'WITH n, `insensitiveDrugName` AS __sort_insensitiveDrugName',
      ].join('\n'),
    );
    expect(result.orderBy).toBe('ORDER BY __sort_insensitiveDrugName ASC');
  });

  it('defaults columnName to the GraphQL field name when @cypher omits it', () => {
    const props = new Map([
      ['upper', cypherProp('upper', 'RETURN toUpper(this.drugName) AS upper')],
    ]);

    const result = compileSortClause({
      sort: [{ upper: 'DESC' }],
      nodeVar: 'n',
      propertyLookup: lookupFromMap(props),
    });

    expect(result.pre).toContain('WITH n, `upper` AS __sort_upper');
    expect(result.orderBy).toBe('ORDER BY __sort_upper DESC');
  });

  it('accumulates aliases across multiple @cypher sorts', () => {
    const props = new Map([
      [
        'insensitiveDrugName',
        cypherProp(
          'insensitiveDrugName',
          'RETURN toLower(this.drugName) AS insensitiveDrugName',
        ),
      ],
      [
        'statusName',
        cypherProp(
          'statusName',
          'MATCH (this)-[:HAS_STATUS]->(s) RETURN s.name AS statusName',
        ),
      ],
    ]);

    const result = compileSortClause({
      sort: [{ insensitiveDrugName: 'ASC' }, { statusName: 'DESC' }],
      nodeVar: 'n',
      propertyLookup: lookupFromMap(props),
    });

    // Each subsequent WITH must carry the prior `__sort_*` alias forward.
    expect(result.pre).toBe(
      [
        'CALL {',
        '  WITH n',
        '  WITH n AS this',
        '  RETURN toLower(this.drugName) AS insensitiveDrugName',
        '}',
        'WITH n, `insensitiveDrugName` AS __sort_insensitiveDrugName',
        'CALL {',
        '  WITH n',
        '  WITH n AS this',
        '  MATCH (this)-[:HAS_STATUS]->(s) RETURN s.name AS statusName',
        '}',
        'WITH n, __sort_insensitiveDrugName, `statusName` AS __sort_statusName',
      ].join('\n'),
    );
    expect(result.orderBy).toBe(
      'ORDER BY __sort_insensitiveDrugName ASC, __sort_statusName DESC',
    );
  });

  it('mixes stored and @cypher sorts in the same ORDER BY', () => {
    const props = new Map([
      ['title', storedProp('title')],
      ['lname', cypherProp('lname', 'RETURN toLower(this.name) AS lname')],
    ]);

    const result = compileSortClause({
      sort: [{ lname: 'ASC' }, { title: 'DESC' }],
      nodeVar: 'n',
      propertyLookup: lookupFromMap(props),
    });

    expect(result.pre).toContain('WITH n, `lname` AS __sort_lname');
    expect(result.orderBy).toBe('ORDER BY __sort_lname ASC, n.`title` DESC');
  });

  it('preserves caller-supplied vars (e.g. __typename) in every WITH', () => {
    const props = new Map([
      ['lname', cypherProp('lname', 'RETURN toLower(this.name) AS lname')],
    ]);

    const result = compileSortClause({
      sort: [{ lname: 'ASC' }],
      nodeVar: 'n',
      propertyLookup: lookupFromMap(props),
      preserveVars: ['__typename'],
    });

    expect(result.pre).toContain('WITH n, __typename, `lname` AS __sort_lname');
  });

  it('falls back to stored-field syntax when @cypher field has no statement captured', () => {
    // Defensive: a malformed schema could leave isCypher: true but no statement.
    const props = new Map<string, PropertyDefinition>([
      [
        'broken',
        {
          ...storedProp('broken'),
          isCypher: true,
        },
      ],
    ]);

    const result = compileSortClause({
      sort: [{ broken: 'ASC' }],
      nodeVar: 'n',
      propertyLookup: lookupFromMap(props),
    });

    expect(result.pre).toBe('');
    expect(result.orderBy).toBe('ORDER BY n.`broken` ASC');
  });

  it('rejects unsafe sort field identifiers', () => {
    expect(() =>
      compileSortClause({
        sort: [{ 'name); DROP --': 'ASC' }],
        nodeVar: 'n',
        propertyLookup: () => undefined,
      }),
    ).toThrow();
  });

  it('rejects invalid sort directions', () => {
    expect(() =>
      compileSortClause({
        sort: [{ title: 'SIDEWAYS' }],
        nodeVar: 'n',
        propertyLookup: () => storedProp('title'),
      }),
    ).toThrow(/sort direction/i);
  });

  it('returns empty pre and orderBy for an empty sort array', () => {
    const result = compileSortClause({
      sort: [],
      nodeVar: 'n',
      propertyLookup: () => undefined,
    });

    expect(result.pre).toBe('');
    expect(result.orderBy).toBe('');
  });
});

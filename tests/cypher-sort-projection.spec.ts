import { compileSortClause } from '../src/utils/cypher-sort-projection';
import { OGMError } from '../src/errors';
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

  // -------------------------------------------------------------------------
  // Multi-key entry arity — issue #4
  //
  // Pre-2.0.0 a multi-key entry compiled to ORDER BY with only its FIRST key
  // and no error, so `[{ isUrgent: 'DESC', position: 'ASC' }]` silently
  // returned rows ordered by something other than what was asked for.
  // -------------------------------------------------------------------------
  describe('sort entry arity', () => {
    it('throws when one entry carries more than one ordering key', () => {
      const props = new Map([
        ['isUrgent', storedProp('isUrgent', 'Boolean')],
        ['position', storedProp('position', 'Int')],
      ]);

      expect(() =>
        compileSortClause({
          sort: [{ isUrgent: 'DESC', position: 'ASC' }],
          nodeVar: 'n',
          propertyLookup: lookupFromMap(props),
        }),
      ).toThrow(OGMError);
    });

    it('names the offending keys and shows the one-entry-per-key form', () => {
      expect(() =>
        compileSortClause({
          sort: [{ isUrgent: 'DESC', position: 'ASC' }],
          nodeVar: 'n',
          propertyLookup: () => undefined,
        }),
      ).toThrow(
        /Sort entry has 2 keys \(isUrgent, position\).*\[\{ isUrgent: 'DESC' \}, \{ position: 'ASC' \}\]/s,
      );
    });

    it('reports arity for entries with three or more keys', () => {
      expect(() =>
        compileSortClause({
          sort: [{ a: 'ASC', b: 'DESC', c: 'ASC' }],
          nodeVar: 'n',
          propertyLookup: () => undefined,
        }),
      ).toThrow(/Sort entry has 3 keys \(a, b, c\)/);
    });

    it('throws on a multi-key entry even when it is not the first entry', () => {
      expect(() =>
        compileSortClause({
          sort: [{ title: 'ASC' }, { isUrgent: 'DESC', position: 'ASC' }],
          nodeVar: 'n',
          propertyLookup: () => undefined,
        }),
      ).toThrow(/Sort entry has 2 keys/);
    });

    it('throws for multi-key @cypher entries too, before emitting any CALL', () => {
      const props = new Map([
        ['lname', cypherProp('lname', 'RETURN toLower(this.name) AS lname')],
        ['title', storedProp('title')],
      ]);

      expect(() =>
        compileSortClause({
          sort: [{ lname: 'ASC', title: 'DESC' }],
          nodeVar: 'n',
          propertyLookup: lookupFromMap(props),
        }),
      ).toThrow(/Sort entry has 2 keys/);
    });

    it('does not echo an unrecognised direction into the error message', () => {
      // Directions are unvalidated at the point the arity error is built, so
      // only 'ASC'/'DESC' may be interpolated — anything else renders as '...'.
      expect(() =>
        compileSortClause({
          sort: [{ a: 'ASC', b: '\n\n[forged log line]' }],
          nodeVar: 'n',
          propertyLookup: () => undefined,
        }),
      ).toThrow(/\{ a: 'ASC' \}, \{ b: \.\.\. \}/);
    });

    it('rejects an unsafe identifier in a non-surviving key', () => {
      // Every key is identifier-checked, not just entries[0].
      expect(() =>
        compileSortClause({
          sort: [{ title: 'ASC', 'name); DROP --': 'DESC' }],
          nodeVar: 'n',
          propertyLookup: () => undefined,
        }),
      ).toThrow(/sort field/i);
    });

    it('still accepts the documented one-key-per-entry form', () => {
      const props = new Map([
        ['isUrgent', storedProp('isUrgent', 'Boolean')],
        ['position', storedProp('position', 'Int')],
      ]);

      const result = compileSortClause({
        sort: [{ isUrgent: 'DESC' }, { position: 'ASC' }],
        nodeVar: 'n',
        propertyLookup: lookupFromMap(props),
      });

      expect(result.orderBy).toBe(
        'ORDER BY n.`isUrgent` DESC, n.`position` ASC',
      );
    });

    it('keeps skipping zero-key entries', () => {
      // A zero-key entry contributes no ordering rather than a wrong one, so
      // it stays a silent skip — unchanged from pre-2.0.0.
      const result = compileSortClause({
        sort: [{}, { title: 'ASC' }, {}],
        nodeVar: 'n',
        propertyLookup: () => storedProp('title'),
      });

      expect(result.orderBy).toBe('ORDER BY n.`title` ASC');
    });
  });

  // -------------------------------------------------------------------------
  // Non-object sort entries — v2.0.0
  //
  // Pre-2.0.0 these escaped as a bare `TypeError` from inside `Object.entries`,
  // so `catch (e) { if (e instanceof OGMError) ... }` missed them even though
  // every other malformed input on this path is an OGMError.
  // -------------------------------------------------------------------------
  describe('non-object sort entries', () => {
    const cases: Array<[string, unknown, string]> = [
      ['null', null, 'null'],
      ['undefined', undefined, 'undefined'],
      ['an array', ['title', 'ASC'], 'an array'],
      ['a string', 'title ASC', 'a string'],
      ['a number', 42, 'a number'],
    ];

    it.each(cases)('rejects %s with an OGMError', (_label, value, kind) => {
      expect(() =>
        compileSortClause({
          sort: [value] as unknown as Array<Record<string, unknown>>,
          nodeVar: 'n',
          propertyLookup: () => undefined,
        }),
      ).toThrow(OGMError);

      expect(() =>
        compileSortClause({
          sort: [value] as unknown as Array<Record<string, unknown>>,
          nodeVar: 'n',
          propertyLookup: () => undefined,
        }),
      ).toThrow(`Sort entry must be an object, got ${kind}.`);
    });

    it('never echoes the offending value into the message', () => {
      let message = '';
      try {
        compileSortClause({
          sort: ['\n\n[forged log line]'] as unknown as Array<
            Record<string, unknown>
          >,
          nodeVar: 'n',
          propertyLookup: () => undefined,
        });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain('got a string');
      expect(message).not.toContain('forged log line');
    });

    it('rejects a bad entry that is not the first', () => {
      expect(() =>
        compileSortClause({
          sort: [{ title: 'ASC' }, null] as unknown as Array<
            Record<string, unknown>
          >,
          nodeVar: 'n',
          propertyLookup: () => storedProp('title'),
        }),
      ).toThrow(OGMError);
    });
  });
});

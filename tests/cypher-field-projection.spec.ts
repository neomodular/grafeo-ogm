import {
  buildCypherFieldCall,
  CypherFieldScope,
} from '../src/utils/cypher-field-projection';
import type { PropertyDefinition } from '../src/schema/types';

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

describe('buildCypherFieldCall', () => {
  it('emits the standard CALL { WITH n; WITH n AS this; <stmt> } shape', () => {
    expect(
      buildCypherFieldCall('RETURN toLower(this.drugName) AS x', 'n'),
    ).toBe(
      [
        'CALL {',
        '  WITH n',
        '  WITH n AS this',
        '  RETURN toLower(this.drugName) AS x',
        '}',
      ].join('\n'),
    );
  });

  it('uses the supplied nodeVar for both the carry and the rebind', () => {
    expect(buildCypherFieldCall('RETURN this.x AS y', 'r0')).toContain(
      '  WITH r0\n  WITH r0 AS this',
    );
  });
});

describe('CypherFieldScope', () => {
  it('returns a stable alias and emits a CALL+WITH pair on register()', () => {
    const scope = new CypherFieldScope('n', [], '__sel');
    const alias = scope.register(
      'insensitiveDrugName',
      cypherProp(
        'insensitiveDrugName',
        'RETURN toLower(this.drugName) AS insensitiveDrugName',
        'insensitiveDrugName',
      ),
    );
    expect(alias).toBe('__sel_n_insensitiveDrugName');
    expect(scope.hasAny()).toBe(true);
    expect(scope.emit()).toEqual([
      'CALL {\n  WITH n\n  WITH n AS this\n  RETURN toLower(this.drugName) AS insensitiveDrugName\n}',
      'WITH n, `insensitiveDrugName` AS __sel_n_insensitiveDrugName',
    ]);
    expect(scope.carried()).toEqual(['__sel_n_insensitiveDrugName']);
  });

  it('returns the SAME alias and DOES NOT emit a duplicate prelude on second register()', () => {
    const scope = new CypherFieldScope('n', [], '__sel');
    const propDef = cypherProp(
      'insensitiveDrugName',
      'RETURN toLower(this.drugName) AS insensitiveDrugName',
    );
    const a1 = scope.register('insensitiveDrugName', propDef);
    const a2 = scope.register('insensitiveDrugName', propDef);
    expect(a1).toBe(a2);
    expect(scope.emit().length).toBe(2); // one CALL + one WITH only
  });

  it('accumulates carried aliases across successive registrations', () => {
    const scope = new CypherFieldScope('n', [], '__sel');
    scope.register('a', cypherProp('a', 'RETURN this.a AS a', 'a'));
    scope.register('b', cypherProp('b', 'RETURN this.b AS b', 'b'));
    const lines = scope.emit();
    // First WITH carries: WITH n, `a` AS __sel_n_a
    // Second WITH carries: WITH n, __sel_n_a, `b` AS __sel_n_b
    expect(lines[1]).toBe('WITH n, `a` AS __sel_n_a');
    expect(lines[3]).toBe('WITH n, __sel_n_a, `b` AS __sel_n_b');
    expect(scope.carried()).toEqual(['__sel_n_a', '__sel_n_b']);
  });

  it('threads preserveVars into every emitted WITH', () => {
    const scope = new CypherFieldScope('n', ['__typename', 'score'], '__sel');
    scope.register('a', cypherProp('a', 'RETURN this.a AS a', 'a'));
    scope.register('b', cypherProp('b', 'RETURN this.b AS b', 'b'));
    const lines = scope.emit();
    expect(lines[1]).toBe('WITH n, __typename, score, `a` AS __sel_n_a');
    expect(lines[3]).toBe(
      'WITH n, __typename, score, __sel_n_a, `b` AS __sel_n_b',
    );
  });

  it('defaults columnName to the GraphQL field name when omitted', () => {
    const scope = new CypherFieldScope('n', [], '__where');
    scope.register(
      'upper',
      cypherProp('upper', 'RETURN toUpper(this.x) AS upper'),
    );
    expect(scope.emit()[1]).toBe('WITH n, `upper` AS __where_n_upper');
  });

  it('throws when register() is called for a property without cypherStatement', () => {
    const scope = new CypherFieldScope('n', [], '__sel');
    const broken: PropertyDefinition = {
      name: 'broken',
      type: 'String',
      required: false,
      isArray: false,
      isListItemRequired: false,
      isGenerated: false,
      isUnique: false,
      isCypher: true,
      directives: ['cypher'],
    };
    expect(() => scope.register('broken', broken)).toThrow(
      /without cypherStatement/,
    );
  });

  it('rejects unsafe nodeVar at construction time', () => {
    expect(() => new CypherFieldScope('n; DELETE x', [], '__sel')).toThrow(
      /Invalid identifier/,
    );
  });

  it('rejects unsafe fieldName at register time', () => {
    const scope = new CypherFieldScope('n', [], '__sel');
    expect(() =>
      scope.register('foo; DROP TABLE x', cypherProp('foo', 'RETURN 1 AS foo')),
    ).toThrow(/Invalid identifier/);
  });

  it('rejects unsafe columnName at register time', () => {
    const scope = new CypherFieldScope('n', [], '__sel');
    expect(() =>
      scope.register('foo', cypherProp('foo', 'RETURN 1 AS bar', 'bar; --')),
    ).toThrow(/Invalid identifier/);
  });
});

import {
  assertInlineableCypherField,
  buildCypherFieldCall,
  buildInlineCypherFieldExpr,
  CypherFieldScope,
} from '../src/utils/cypher-field-projection';
import { OGMError } from '../src/errors';
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
  // #9 — the statement runs in an inner CALL and is reduced with
  // head(collect(col)): exactly one row per outer row, whatever the
  // statement returns (pre-2.4.0: zero rows dropped the node, several
  // duplicated it).
  it('emits the row-preserving CALL { WITH n; CALL { ... }; RETURN head(collect(col)) } shape', () => {
    expect(
      buildCypherFieldCall('RETURN toLower(this.drugName) AS x', 'n', 'x'),
    ).toBe(
      [
        'CALL {',
        '  WITH n',
        '  CALL {',
        '    WITH n',
        '    WITH n AS this',
        '    RETURN toLower(this.drugName) AS x',
        '  }',
        '  RETURN head(collect(`x`)) AS `x`',
        '}',
      ].join('\n'),
    );
  });

  it('uses the supplied nodeVar for both the carry and the rebind', () => {
    expect(buildCypherFieldCall('RETURN this.x AS y', 'r0', 'y')).toContain(
      '  WITH r0\n  CALL {\n    WITH r0\n    WITH r0 AS this',
    );
  });

  it('reduces only the declared column, so the statement may return others', () => {
    const call = buildCypherFieldCall(
      'RETURN this.a AS a, this.b AS b',
      'n',
      'b',
    );
    expect(call).toContain('  RETURN head(collect(`b`)) AS `b`\n}');
  });

  // v2.5.3 — a column named like the node variable redeclared it.
  it('rebinds the node when the statement returns a column named like it', () => {
    const call = buildCypherFieldCall(
      'RETURN this.rank AS n',
      'n',
      'n',
      'Doc',
      '__sel_n_nn',
    );
    expect(call).toBe(
      [
        'CALL {',
        '  WITH n',
        '  WITH n AS n__cf_this',
        '  WITH n__cf_this WHERE n__cf_this:`Doc`',
        '  CALL {',
        '    WITH n__cf_this',
        '    WITH n__cf_this AS this',
        '    RETURN this.rank AS n',
        '  }',
        '  RETURN head(collect(`n`)) AS __sel_n_nn',
        '}',
      ].join('\n'),
    );
  });

  it('does not rebind for a property access or a param of the same name', () => {
    const call = buildCypherFieldCall('RETURN this.n + $n AS x', 'n', 'x');
    expect(call).not.toContain('n__cf_this');
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
      'CALL {\n  WITH n\n  CALL {\n    WITH n\n    WITH n AS this\n    RETURN toLower(this.drugName) AS insensitiveDrugName\n  }\n  RETURN head(collect(`insensitiveDrugName`)) AS __sel_n_insensitiveDrugName\n}',
      'WITH n, __sel_n_insensitiveDrugName',
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
    // First WITH carries: WITH n, __sel_n_a
    // Second WITH carries: WITH n, __sel_n_a, __sel_n_b
    expect(lines[1]).toBe('WITH n, __sel_n_a');
    expect(lines[3]).toBe('WITH n, __sel_n_a, __sel_n_b');
    expect(scope.carried()).toEqual(['__sel_n_a', '__sel_n_b']);
  });

  it('threads preserveVars into every emitted WITH', () => {
    const scope = new CypherFieldScope('n', ['__typename', 'score'], '__sel');
    scope.register('a', cypherProp('a', 'RETURN this.a AS a', 'a'));
    scope.register('b', cypherProp('b', 'RETURN this.b AS b', 'b'));
    const lines = scope.emit();
    expect(lines[1]).toBe('WITH n, __typename, score, __sel_n_a');
    expect(lines[3]).toBe('WITH n, __typename, score, __sel_n_a, __sel_n_b');
  });

  it('defaults columnName to the GraphQL field name when omitted', () => {
    const scope = new CypherFieldScope('n', [], '__where');
    scope.register(
      'upper',
      cypherProp('upper', 'RETURN toUpper(this.x) AS upper'),
    );
    expect(scope.emit()[1]).toBe('WITH n, __where_n_upper');
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

describe('inline @cypher projection of aggregating statements (v2.4.8)', () => {
  it.each([
    'MATCH (this)-[:W]->(p) RETURN count(p) AS c',
    'MATCH (this)-[:W]->(p) RETURN count(*) AS c',
    'MATCH (this)-[:W]->(p) RETURN size(collect(p)) AS c',
    'MATCH (this)-[:W]->(p) WITH sum(p.x) AS s RETURN s AS c',
    'MATCH (this)-[:W]->(p) RETURN AVG (p.x) AS c',
  ])('refuses %s', (stmt) => {
    expect(() => assertInlineableCypherField('User.c', stmt)).toThrow(OGMError);
    expect(() => buildInlineCypherFieldExpr(stmt, 'n0', 'User.c')).toThrow(
      /"User\.c" aggregates .* only be selected at the top level/,
    );
  });

  it.each([
    'RETURN this.rank * 10 AS c',
    'RETURN COUNT { (this)-[:W]->() } AS c',
    'MATCH (this)-[:W]->(p) RETURN p.counter AS c',
    // v2.5.3 — literals, comments and qualified names were refused.
    "RETURN 'count(' + this.title + ')' AS c",
    'RETURN "max(" + this.title AS c',
    "RETURN 'it\\'s sum(' AS c",
    'RETURN this.x AS c // count(x)',
    'RETURN apoc.coll.max([this.a, this.b]) AS c',
    'RETURN this.`count(` AS c',
  ])('accepts %s', (stmt) => {
    expect(() => assertInlineableCypherField('User.c', stmt)).not.toThrow();
  });

  it('without a field label the expression builds as before', () => {
    expect(buildInlineCypherFieldExpr('RETURN count(*) AS c', 'n0')).toBe(
      'head(COLLECT { WITH n0 AS this\n  RETURN count(*) AS c\n})',
    );
  });
});

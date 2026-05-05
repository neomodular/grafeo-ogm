import { VectorCompiler } from '../src/compilers/vector.compiler';
import { NodeDefinition } from '../src/schema/types';

const makeNodeDef = (): NodeDefinition => ({
  typeName: 'Article',
  label: 'Article',
  labels: ['Article'],
  pluralName: 'articles',
  properties: new Map([
    [
      'embedding',
      {
        name: 'embedding',
        type: 'Float',
        required: true,
        isArray: true,
        isListItemRequired: true,
        isGenerated: false,
        isUnique: false,
        isCypher: false,
        directives: [],
      },
    ],
  ]),
  relationships: new Map(),
  fulltextIndexes: [],
  vectorIndexes: [
    {
      indexName: 'article_content_idx',
      queryName: 'similarArticles',
      embeddingProperty: 'embedding',
      provider: 'OpenAI',
    },
    {
      indexName: 'article_no_provider_idx',
      queryName: 'localOnly',
      embeddingProperty: 'embedding',
    },
  ],
  implementsInterfaces: [],
});

describe('VectorCompiler', () => {
  let nodeDef: NodeDefinition;
  let compiler: VectorCompiler;

  beforeEach(() => {
    nodeDef = makeNodeDef();
    compiler = new VectorCompiler();
  });

  describe('compileByVector', () => {
    it('emits the expected CALL shape with correct param names', () => {
      const result = compiler.compileByVector({
        indexName: 'article_content_idx',
        vector: [0.1, 0.2, 0.3],
        k: 5,
        nodeDef,
      });

      expect(result.cypher).toBe(
        'CALL db.index.vector.queryNodes($v_name_0, $v_k_0, $v_vector_0) YIELD node AS n, score',
      );
      expect(result.params).toEqual({
        v_name_0: 'article_content_idx',
        v_k_0: 5,
        v_vector_0: [0.1, 0.2, 0.3],
      });
    });

    it('uses the paramCounter suffix when provided', () => {
      const paramCounter = { count: 3 };
      const result = compiler.compileByVector({
        indexName: 'article_content_idx',
        vector: [1, 2, 3],
        k: 10,
        nodeDef,
        paramCounter,
      });

      expect(result.cypher).toContain('$v_name_3');
      expect(result.cypher).toContain('$v_k_3');
      expect(result.cypher).toContain('$v_vector_3');
      expect(result.params).toEqual({
        v_name_3: 'article_content_idx',
        v_k_3: 10,
        v_vector_3: [1, 2, 3],
      });
      expect(paramCounter.count).toBe(4);
    });

    it('throws on unknown indexName with descriptive error listing available indexes', () => {
      expect(() =>
        compiler.compileByVector({
          indexName: 'missing_idx',
          vector: [0.1],
          k: 1,
          nodeDef,
        }),
      ).toThrow(
        /Invalid vector index: "missing_idx" is not defined on Article\. Available: \[article_content_idx, article_no_provider_idx\]/,
      );
    });

    it('throws when nodeDef has no vectorIndexes declared', () => {
      const bareNode: NodeDefinition = { ...makeNodeDef(), vectorIndexes: [] };
      expect(() =>
        compiler.compileByVector({
          indexName: 'article_content_idx',
          vector: [0.1],
          k: 1,
          nodeDef: bareNode,
        }),
      ).toThrow(/Available: \[\]/);
    });

    it('throws when vectorIndexes is undefined (optional field)', () => {
      const bareNode: NodeDefinition = {
        ...makeNodeDef(),
        vectorIndexes: undefined,
      };
      expect(() =>
        compiler.compileByVector({
          indexName: 'article_content_idx',
          vector: [0.1],
          k: 1,
          nodeDef: bareNode,
        }),
      ).toThrow(/Available: \[\]/);
    });

    it('throws on empty vector', () => {
      expect(() =>
        compiler.compileByVector({
          indexName: 'article_content_idx',
          vector: [],
          k: 5,
          nodeDef,
        }),
      ).toThrow(/"vector" must not be empty/);
    });

    it('throws on non-array vector', () => {
      expect(() =>
        compiler.compileByVector({
          indexName: 'article_content_idx',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          vector: 'not-an-array' as any,
          k: 5,
          nodeDef,
        }),
      ).toThrow(/"vector" must be a number\[\]/);
    });

    it('throws when vector contains NaN', () => {
      expect(() =>
        compiler.compileByVector({
          indexName: 'article_content_idx',
          vector: [0.1, NaN, 0.3],
          k: 5,
          nodeDef,
        }),
      ).toThrow(/non-finite value at index 1/);
    });

    it('throws when vector contains Infinity', () => {
      expect(() =>
        compiler.compileByVector({
          indexName: 'article_content_idx',
          vector: [0.1, Infinity],
          k: 5,
          nodeDef,
        }),
      ).toThrow(/non-finite value at index 1/);
    });

    it('throws when vector contains a non-number element', () => {
      expect(() =>
        compiler.compileByVector({
          indexName: 'article_content_idx',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          vector: [0.1, '0.2' as any, 0.3],
          k: 5,
          nodeDef,
        }),
      ).toThrow(/non-finite value at index 1/);
    });

    it('throws on k < 1', () => {
      expect(() =>
        compiler.compileByVector({
          indexName: 'article_content_idx',
          vector: [0.1],
          k: 0,
          nodeDef,
        }),
      ).toThrow(/must be >= 1, got 0/);
    });

    it('throws on negative k', () => {
      expect(() =>
        compiler.compileByVector({
          indexName: 'article_content_idx',
          vector: [0.1],
          k: -5,
          nodeDef,
        }),
      ).toThrow(/must be >= 1, got -5/);
    });

    it('clamps k > 1000 to 1000 without throwing', () => {
      const result = compiler.compileByVector({
        indexName: 'article_content_idx',
        vector: [0.1],
        k: 5000,
        nodeDef,
      });
      expect(result.params.v_k_0).toBe(1000);
    });

    it('accepts k == 1000 (boundary)', () => {
      const result = compiler.compileByVector({
        indexName: 'article_content_idx',
        vector: [0.1],
        k: 1000,
        nodeDef,
      });
      expect(result.params.v_k_0).toBe(1000);
    });

    it('throws on non-integer k', () => {
      expect(() =>
        compiler.compileByVector({
          indexName: 'article_content_idx',
          vector: [0.1],
          k: 2.5,
          nodeDef,
        }),
      ).toThrow(/"k" must be an integer, got 2\.5/);
    });

    it('throws on NaN k', () => {
      expect(() =>
        compiler.compileByVector({
          indexName: 'article_content_idx',
          vector: [0.1],
          k: NaN,
          nodeDef,
        }),
      ).toThrow(/"k" must be a finite number/);
    });

    it('throws when indexName contains unsafe characters', () => {
      expect(() =>
        compiler.compileByVector({
          indexName: 'bad; DROP DATABASE',
          vector: [0.1],
          k: 1,
          nodeDef,
        }),
      ).toThrow(/Invalid identifier/);
    });
  });

  describe('compileByPhrase', () => {
    it('emits the two-step CALL with genai.vector.encode + queryNodes', () => {
      const result = compiler.compileByPhrase({
        indexName: 'article_content_idx',
        phrase: 'distributed consensus',
        k: 7,
        providerConfig: { token: 'secret-abc' },
        nodeDef,
      });

      expect(result.cypher).toBe(
        [
          'CALL genai.vector.encode($v_phrase_0, $v_provider_0, $v_providerConfig_0) YIELD vector AS __v_encoded_0',
          'CALL db.index.vector.queryNodes($v_name_0, $v_k_0, __v_encoded_0) YIELD node AS n, score',
        ].join('\n'),
      );
      expect(result.params).toEqual({
        v_name_0: 'article_content_idx',
        v_k_0: 7,
        v_phrase_0: 'distributed consensus',
        v_provider_0: 'OpenAI',
        v_providerConfig_0: { token: 'secret-abc' },
      });
    });

    it('uses {} as providerConfig when omitted', () => {
      const result = compiler.compileByPhrase({
        indexName: 'article_content_idx',
        phrase: 'hello',
        k: 3,
        nodeDef,
      });
      expect(result.params.v_providerConfig_0).toEqual({});
    });

    it('passes through providerConfig as a Cypher parameter (never interpolated)', () => {
      const cfg = { token: 'sk-live-xyz', region: 'us-east-1' };
      const result = compiler.compileByPhrase({
        indexName: 'article_content_idx',
        phrase: 'hello',
        k: 3,
        providerConfig: cfg,
        nodeDef,
      });
      expect(result.params.v_providerConfig_0).toEqual(cfg);
      expect(result.cypher).not.toContain('sk-live-xyz');
      expect(result.cypher).not.toContain('us-east-1');
    });

    it('throws when index has no provider field set', () => {
      expect(() =>
        compiler.compileByPhrase({
          indexName: 'article_no_provider_idx',
          phrase: 'hello',
          k: 3,
          nodeDef,
        }),
      ).toThrow(
        /Vector index "article_no_provider_idx" is not configured for phrase search\. Set "provider" on the @vector directive to enable searchByPhrase\./,
      );
    });

    it('throws on empty phrase', () => {
      expect(() =>
        compiler.compileByPhrase({
          indexName: 'article_content_idx',
          phrase: '',
          k: 3,
          nodeDef,
        }),
      ).toThrow(/"phrase" must be a non-empty string/);
    });

    it('throws on whitespace-only phrase', () => {
      expect(() =>
        compiler.compileByPhrase({
          indexName: 'article_content_idx',
          phrase: '   ',
          k: 3,
          nodeDef,
        }),
      ).toThrow(/"phrase" must be a non-empty string/);
    });

    // v1.7.3 — phrase length cap (DoS / billing-attack guard)
    it('throws on phrases longer than 8 KB', () => {
      const huge = 'a'.repeat(8 * 1024 + 1);
      expect(() =>
        compiler.compileByPhrase({
          indexName: 'article_content_idx',
          phrase: huge,
          k: 3,
          nodeDef,
        }),
      ).toThrow(/exceeds the maximum length/);
    });

    it('throws on unknown indexName', () => {
      expect(() =>
        compiler.compileByPhrase({
          indexName: 'missing_idx',
          phrase: 'hello',
          k: 3,
          nodeDef,
        }),
      ).toThrow(
        /Invalid vector index: "missing_idx" is not defined on Article/,
      );
    });

    it('throws on k < 1 before checking phrase', () => {
      expect(() =>
        compiler.compileByPhrase({
          indexName: 'article_content_idx',
          phrase: 'hello',
          k: 0,
          nodeDef,
        }),
      ).toThrow(/"k" must be >= 1/);
    });

    it('clamps k > 1000 to 1000 for phrase search', () => {
      const result = compiler.compileByPhrase({
        indexName: 'article_content_idx',
        phrase: 'hello',
        k: 9999,
        nodeDef,
      });
      expect(result.params.v_k_0).toBe(1000);
    });

    it('uses paramCounter suffix for encoded variable and params', () => {
      const paramCounter = { count: 2 };
      const result = compiler.compileByPhrase({
        indexName: 'article_content_idx',
        phrase: 'hello',
        k: 3,
        nodeDef,
        paramCounter,
      });
      expect(result.cypher).toContain('__v_encoded_2');
      expect(result.cypher).toContain('$v_phrase_2');
      expect(result.cypher).toContain('$v_provider_2');
      expect(result.cypher).toContain('$v_providerConfig_2');
      expect(paramCounter.count).toBe(3);
    });
  });

  describe('paramCounter sharing across invocations', () => {
    it('produces unique param keys across sequential compileByVector calls', () => {
      const paramCounter = { count: 0 };
      const a = compiler.compileByVector({
        indexName: 'article_content_idx',
        vector: [0.1],
        k: 5,
        nodeDef,
        paramCounter,
      });
      const b = compiler.compileByVector({
        indexName: 'article_content_idx',
        vector: [0.2],
        k: 5,
        nodeDef,
        paramCounter,
      });

      expect(Object.keys(a.params)).toEqual([
        'v_name_0',
        'v_k_0',
        'v_vector_0',
      ]);
      expect(Object.keys(b.params)).toEqual([
        'v_name_1',
        'v_k_1',
        'v_vector_1',
      ]);
      expect(paramCounter.count).toBe(2);
    });

    it('produces unique param keys across mixed vector + phrase calls', () => {
      const paramCounter = { count: 0 };
      const a = compiler.compileByVector({
        indexName: 'article_content_idx',
        vector: [0.1],
        k: 5,
        nodeDef,
        paramCounter,
      });
      const b = compiler.compileByPhrase({
        indexName: 'article_content_idx',
        phrase: 'hello',
        k: 5,
        nodeDef,
        paramCounter,
      });

      expect(a.cypher).toContain('$v_name_0');
      expect(b.cypher).toContain('$v_name_1');
      expect(b.cypher).toContain('__v_encoded_1');
      expect(paramCounter.count).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Gap-filling tests: boundary + security + error-path completeness
  // -------------------------------------------------------------------------

  describe('boundary conditions for k', () => {
    it('accepts k == 1 (lower boundary)', () => {
      const result = compiler.compileByVector({
        indexName: 'article_content_idx',
        vector: [0.1],
        k: 1,
        nodeDef,
      });
      expect(result.params.v_k_0).toBe(1);
    });

    it('accepts k == 1001 but clamps to 1000 (upper boundary + 1)', () => {
      const result = compiler.compileByVector({
        indexName: 'article_content_idx',
        vector: [0.1],
        k: 1001,
        nodeDef,
      });
      expect(result.params.v_k_0).toBe(1000);
    });

    it('clamps k == Number.MAX_SAFE_INTEGER to 1000', () => {
      const result = compiler.compileByVector({
        indexName: 'article_content_idx',
        vector: [0.1],
        k: Number.MAX_SAFE_INTEGER,
        nodeDef,
      });
      expect(result.params.v_k_0).toBe(1000);
    });

    it('throws on k == -Infinity (finiteness check)', () => {
      expect(() =>
        compiler.compileByVector({
          indexName: 'article_content_idx',
          vector: [0.1],
          k: -Infinity,
          nodeDef,
        }),
      ).toThrow(/"k" must be a finite number/);
    });

    it('throws on non-number k (string)', () => {
      expect(() =>
        compiler.compileByVector({
          indexName: 'article_content_idx',
          vector: [0.1],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          k: '5' as any,
          nodeDef,
        }),
      ).toThrow(/"k" must be a finite number/);
    });
  });

  describe('vector contents — edge values', () => {
    it('accepts a single-element [0] vector (zeros are finite)', () => {
      const result = compiler.compileByVector({
        indexName: 'article_content_idx',
        vector: [0],
        k: 1,
        nodeDef,
      });
      expect(result.params.v_vector_0).toEqual([0]);
    });

    it('accepts a vector of all negative floats', () => {
      const result = compiler.compileByVector({
        indexName: 'article_content_idx',
        vector: [-1.5, -0.001, -1e-10],
        k: 1,
        nodeDef,
      });
      expect(result.params.v_vector_0).toEqual([-1.5, -0.001, -1e-10]);
    });

    it('throws on -Infinity element at any position', () => {
      expect(() =>
        compiler.compileByVector({
          indexName: 'article_content_idx',
          vector: [0.1, -Infinity, 0.3],
          k: 1,
          nodeDef,
        }),
      ).toThrow(/non-finite value at index 1/);
    });

    it('throws on undefined element inside vector', () => {
      expect(() =>
        compiler.compileByVector({
          indexName: 'article_content_idx',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          vector: [0.1, undefined as any, 0.3],
          k: 1,
          nodeDef,
        }),
      ).toThrow(/non-finite value at index 1/);
    });

    it('accepts a large (10K-element) vector without throwing', () => {
      // Documents current behavior: no element-count cap in the compiler.
      // If a cap is added in future, update this test.
      const large = new Array(10_000).fill(0).map((_, i) => i / 10_000);
      const result = compiler.compileByVector({
        indexName: 'article_content_idx',
        vector: large,
        k: 5,
        nodeDef,
      });
      expect((result.params.v_vector_0 as number[]).length).toBe(10_000);
    });
  });

  describe('security — indexName validation', () => {
    it('throws on empty string indexName (fails identifier regex)', () => {
      expect(() =>
        compiler.compileByVector({
          indexName: '',
          vector: [0.1],
          k: 1,
          nodeDef,
        }),
      ).toThrow(/Invalid identifier/);
    });

    it('throws on indexName starting with a digit', () => {
      expect(() =>
        compiler.compileByVector({
          indexName: '1bad',
          vector: [0.1],
          k: 1,
          nodeDef,
        }),
      ).toThrow(/Invalid identifier/);
    });

    it('throws on indexName with backtick injection attempt', () => {
      expect(() =>
        compiler.compileByVector({
          indexName: 'idx`);--',
          vector: [0.1],
          k: 1,
          nodeDef,
        }),
      ).toThrow(/Invalid identifier/);
    });

    it('throws on indexName with newline injection attempt', () => {
      expect(() =>
        compiler.compileByVector({
          indexName: 'idx\nRETURN 1',
          vector: [0.1],
          k: 1,
          nodeDef,
        }),
      ).toThrow(/Invalid identifier/);
    });
  });

  describe('security — providerConfig is a parameter, not interpolated', () => {
    it('accepts providerConfig with prototype-pollution-looking keys (passed as param)', () => {
      // providerConfig is passed through to Neo4j's genai.vector.encode as a
      // Cypher parameter; it is NEVER merged into our own objects, so dangerous
      // keys like __proto__ cannot pollute the OGM's runtime. This test
      // documents that the compiler does not need to reject them.
      const cfg = { __proto__: { polluted: true }, normal: 'value' };
      const result = compiler.compileByPhrase({
        indexName: 'article_content_idx',
        phrase: 'hello',
        k: 3,
        providerConfig: cfg,
        nodeDef,
      });

      expect(result.cypher).not.toContain('__proto__');
      expect(result.cypher).not.toContain('polluted');
      expect(result.cypher).toContain('$v_providerConfig_0');
      // The reference is preserved exactly (Neo4j driver serializes it safely).
      expect(result.params.v_providerConfig_0).toBe(cfg);
    });

    it('does not interpolate providerConfig values containing Cypher metacharacters', () => {
      const cfg = {
        token: "'; DROP DATABASE neo4j; //",
        endpoint: 'https://example.com/\n\r',
      };
      const result = compiler.compileByPhrase({
        indexName: 'article_content_idx',
        phrase: 'hello',
        k: 3,
        providerConfig: cfg,
        nodeDef,
      });
      expect(result.cypher).not.toContain('DROP');
      expect(result.cypher).not.toContain('example.com');
      expect(result.params.v_providerConfig_0).toBe(cfg);
    });
  });

  describe('phrase — edge-character handling', () => {
    it('treats a phrase with only a null byte as non-empty (accepted)', () => {
      // `\0`.trim() === '\0' so assertValidPhrase accepts it. This documents
      // the current contract: content validation is Neo4j's responsibility.
      const result = compiler.compileByPhrase({
        indexName: 'article_content_idx',
        phrase: '\0',
        k: 3,
        nodeDef,
      });
      expect(result.params.v_phrase_0).toBe('\0');
    });

    it('accepts a phrase with mixed unicode (surrogate pairs preserved)', () => {
      const phrase = 'café 日本語 👨‍👩‍👧';
      const result = compiler.compileByPhrase({
        indexName: 'article_content_idx',
        phrase,
        k: 3,
        nodeDef,
      });
      expect(result.params.v_phrase_0).toBe(phrase);
    });

    it('throws on non-string phrase (number)', () => {
      expect(() =>
        compiler.compileByPhrase({
          indexName: 'article_content_idx',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          phrase: 123 as any,
          k: 3,
          nodeDef,
        }),
      ).toThrow(/"phrase" must be a non-empty string/);
    });

    it('throws on null phrase', () => {
      expect(() =>
        compiler.compileByPhrase({
          indexName: 'article_content_idx',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          phrase: null as any,
          k: 3,
          nodeDef,
        }),
      ).toThrow(/"phrase" must be a non-empty string/);
    });

    it('throws when provider is declared as empty-string (trim check)', () => {
      const nodeWithBlankProvider: NodeDefinition = {
        ...makeNodeDef(),
        vectorIndexes: [
          {
            indexName: 'blank_provider_idx',
            queryName: 'blankQuery',
            embeddingProperty: 'embedding',
            provider: '   ', // whitespace-only provider
          },
        ],
      };
      expect(() =>
        compiler.compileByPhrase({
          indexName: 'blank_provider_idx',
          phrase: 'hello',
          k: 3,
          nodeDef: nodeWithBlankProvider,
        }),
      ).toThrow(/is not configured for phrase search/);
    });
  });
});

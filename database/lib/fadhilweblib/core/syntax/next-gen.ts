import { gzipSync } from 'node:zlib';
import type { FadhilWebCompiledSyntax, FadhilWebFlatSyntaxObject, FadhilWebSyntax, FadhilWebSyntaxObject } from '../types';
import { GROUP_ALIASES, GROUP_KEY_SETS, KEY_ALIASES, normalizeGroupName, normalizeKey } from './constants';
import { compileSyntax, composeSyntax, FadhilWebSyntaxError, parseSyntaxInput, splitTopLevelArgs } from './parse';
import { resolveSyntax } from './style';

type StructuredGroupName = keyof typeof GROUP_KEY_SETS;

type AliasMap = Record<string, string>;

export interface NextGenSyntaxEngineConfig {
  readonly allowVerboseDeclarations?: boolean;
  readonly allowUltraShortAliases?: boolean;
  readonly contextualDefaults?: FadhilWebSyntax;
  readonly customKeyAliases?: AliasMap;
  readonly customGroupAliases?: AliasMap;
  readonly cacheSize?: number;
}

export interface NextGenCompileOptions {
  readonly defaults?: FadhilWebSyntax;
}

export interface NextGenCompileInput {
  readonly syntax?: FadhilWebSyntax;
  readonly verbose?: FadhilWebSyntaxObject;
  readonly ultra?: string;
}

export interface NextGenSyntaxBenchmark {
  readonly estimatedPayloadBytes: number;
  readonly estimatedCoreBytes: number;
  readonly estimatedPayloadGzipBytes: number;
  readonly estimatedCoreGzipBytes: number;
  readonly shorthandCompressionRatio: number;
}

export interface NextGenSyntaxDependencyGraph {
  readonly groups: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly edges: ReadonlyArray<{ from: string; to: string }>;
}

export interface NextGenSyntaxAnalysis {
  readonly keyCollisions: ReadonlyArray<{ alias: string; canonical: string }>;
  readonly groupCollisions: ReadonlyArray<{ alias: string; canonical: string }>;
  readonly unknownShortKeys: ReadonlyArray<string>;
  readonly unknownGroups: ReadonlyArray<string>;
  readonly recursiveAliasChains: ReadonlyArray<string>;
  readonly dependencyGraph: NextGenSyntaxDependencyGraph;
}

const DEFAULT_ENGINE_CONFIG = Object.freeze({
  allowVerboseDeclarations: true,
  allowUltraShortAliases: true,
  cacheSize: 200,
}) satisfies Required<Pick<NextGenSyntaxEngineConfig, 'allowVerboseDeclarations' | 'allowUltraShortAliases' | 'cacheSize'>>;

function rememberCompileCache(cache: Map<string, FadhilWebCompiledSyntax>, key: string, value: FadhilWebCompiledSyntax, max = 200) {
  if (cache.has(key)) {
    cache.delete(key);
  } else if (cache.size >= max) {
    const firstKey = cache.keys().next().value;
    if (firstKey) {
      cache.delete(firstKey);
    }
  }

  cache.set(key, value);
}

function resolveAlias(rawKey: string, aliases: AliasMap, fallback: (value: string) => string | undefined) {
  const lowered = rawKey.trim().toLowerCase();
  const override = aliases[lowered];
  if (override) {
    return override;
  }

  return fallback(rawKey);
}

function normalizeUltraShortKey(rawKey: string, customAliases: AliasMap = {}) {
  const canonical = resolveAlias(rawKey, customAliases, normalizeKey);
  if (canonical) {
    return canonical;
  }

  return resolveAlias(rawKey.replace(/[$_\s-]/g, ''), customAliases, normalizeKey);
}

function normalizeUltraShortGroup(rawGroup: string, customAliases: AliasMap = {}) {
  const canonical = resolveAlias(rawGroup, customAliases, normalizeGroupName);
  if (canonical) {
    return canonical;
  }

  return resolveAlias(rawGroup.replace(/[$_\s-]/g, ''), customAliases, normalizeGroupName);
}

function createInputFingerprint(input: FadhilWebSyntax | NextGenCompileInput | undefined, options?: NextGenCompileOptions, defaults?: FadhilWebSyntax) {
  return JSON.stringify({ input, options, defaults });
}

function toSyntaxFragments(input: FadhilWebSyntax | NextGenCompileInput | undefined) {
  if (!input) {
    return [];
  }

  if (typeof input === 'string' || (typeof input === 'object' && '__fwlbType' in input)) {
    return [input as FadhilWebSyntax];
  }

  if ('syntax' in input || 'verbose' in input || 'ultra' in input) {
    const nextGenInput = input as NextGenCompileInput;
    return [nextGenInput.syntax, nextGenInput.verbose, nextGenInput.ultra].filter(Boolean) as FadhilWebSyntax[];
  }

  return [input as FadhilWebSyntax];
}

function detectRecursiveAliasChains(aliases: AliasMap) {
  const recursive = new Set<string>();
  const visited = new Set<string>();

  const walk = (key: string, stack: string[]) => {
    if (stack.includes(key)) {
      recursive.add([...stack, key].join(' -> '));
      return;
    }

    if (visited.has(key)) {
      return;
    }

    visited.add(key);

    const next = aliases[key];
    if (!next) {
      return;
    }

    walk(next.toLowerCase(), [...stack, key]);
  };

  for (const key of Object.keys(aliases)) {
    walk(key.toLowerCase(), []);
  }

  return Array.from(recursive);
}

function createDependencyGraph(input: FadhilWebSyntax) {
  const parsed = parseSyntaxInput(input);
  const groups: Record<string, Set<string>> = {
    layout: new Set<string>(),
    spacing: new Set<string>(),
    surface: new Set<string>(),
    text: new Set<string>(),
    fx: new Set<string>(),
    logic: new Set<string>(),
    escapes: new Set<string>(),
  };

  const edges: Array<{ from: string; to: string }> = [];

  for (const key of Object.keys(parsed)) {
    if (key === 'aria' || key === 'data' || key === 'vars' || key === 'css' || key === 'attrs') {
      groups.escapes.add(key);
      edges.push({ from: 'escapes', to: key });
      continue;
    }

    let bucket: StructuredGroupName | undefined;
    for (const groupName of Object.keys(GROUP_KEY_SETS) as StructuredGroupName[]) {
      if (GROUP_KEY_SETS[groupName].has(key as keyof FadhilWebFlatSyntaxObject)) {
        bucket = groupName;
        break;
      }
    }

    const finalBucket = bucket ?? 'layout';
    groups[finalBucket].add(key);
    edges.push({ from: finalBucket, to: key });
  }

  return Object.freeze({
    groups: Object.freeze(
      Object.fromEntries(Object.entries(groups).map(([groupName, keys]) => [groupName, Object.freeze(Array.from(keys))])),
    ) as Record<string, ReadonlyArray<string>>,
    edges: Object.freeze(edges),
  }) as NextGenSyntaxDependencyGraph;
}

export function precompileUltraShortSyntax(input: FadhilWebSyntax) {
  return compileSyntax(input);
}

export function benchmarkNextGenSyntax(input: FadhilWebSyntax) {
  const parsed = parseSyntaxInput(input);
  const compact = JSON.stringify(parsed);
  const resolved = JSON.stringify(resolveSyntax(parsed));

  return Object.freeze({
    estimatedPayloadBytes: Buffer.byteLength(compact, 'utf8'),
    estimatedCoreBytes: Buffer.byteLength(resolved, 'utf8'),
    estimatedPayloadGzipBytes: gzipSync(compact).byteLength,
    estimatedCoreGzipBytes: gzipSync(resolved).byteLength,
    shorthandCompressionRatio: compact.length === 0 ? 1 : Number((resolved.length / compact.length).toFixed(3)),
  }) as NextGenSyntaxBenchmark;
}

export function analyzeNextGenSyntax(input: FadhilWebSyntax, config: Pick<NextGenSyntaxEngineConfig, 'customGroupAliases' | 'customKeyAliases'> = {}) {
  const parsed = parseSyntaxInput(input);
  const keyAliasMap = { ...KEY_ALIASES, ...(config.customKeyAliases ?? {}) };
  const groupAliasMap = { ...GROUP_ALIASES, ...(config.customGroupAliases ?? {}) };

  const unknownShortKeys = new Set<string>();
  const unknownGroups = new Set<string>();

  if (typeof input === 'string') {
    for (const segment of splitTopLevelArgs(input, ';')) {
      const trimmed = segment.trim();
      if (!trimmed) {
        continue;
      }

      const groupStartIndex = trimmed.indexOf('(');
      if (groupStartIndex > 0 && trimmed.endsWith(')')) {
        const rawGroup = trimmed.slice(0, groupStartIndex).trim();
        if (!normalizeUltraShortGroup(rawGroup, config.customGroupAliases)) {
          unknownGroups.add(rawGroup);
        }

        const body = trimmed.slice(groupStartIndex + 1, -1);
        for (const entry of splitTopLevelArgs(body, ',')) {
          const separatorIndex = entry.indexOf(':');
          if (separatorIndex < 1) {
            continue;
          }

          const rawKey = entry.slice(0, separatorIndex).trim();
          if (!normalizeUltraShortKey(rawKey, config.customKeyAliases)) {
            unknownShortKeys.add(rawKey);
          }
        }

        continue;
      }

      const separatorIndex = trimmed.indexOf(':');
      if (separatorIndex < 1) {
        continue;
      }

      const rawKey = trimmed.slice(0, separatorIndex).trim();
      if (!normalizeUltraShortKey(rawKey, config.customKeyAliases)) {
        unknownShortKeys.add(rawKey);
      }
    }
  } else {
    for (const rawKey of Object.keys(parsed)) {
      if (rawKey === 'vars' || rawKey === 'aria' || rawKey === 'data' || rawKey === 'css' || rawKey === 'attrs') {
        continue;
      }

      if (!normalizeUltraShortKey(rawKey, config.customKeyAliases)) {
        unknownShortKeys.add(rawKey);
      }
    }
  }

  const keyCollisions = Object.entries(keyAliasMap)
    .filter(([alias, canonical]) => alias !== canonical)
    .map(([alias, canonical]) => ({ alias, canonical }));

  const groupCollisions = Object.entries(groupAliasMap)
    .filter(([alias, canonical]) => alias !== canonical)
    .map(([alias, canonical]) => ({ alias, canonical }));

  return Object.freeze({
    keyCollisions,
    groupCollisions,
    unknownShortKeys: Array.from(unknownShortKeys),
    unknownGroups: Array.from(unknownGroups),
    recursiveAliasChains: [
      ...detectRecursiveAliasChains(config.customKeyAliases ?? {}),
      ...detectRecursiveAliasChains(config.customGroupAliases ?? {}),
    ],
    dependencyGraph: createDependencyGraph(parsed),
  }) as NextGenSyntaxAnalysis;
}

export function createNextGenSyntaxEngine(config: NextGenSyntaxEngineConfig = {}) {
  const resolvedConfig = {
    ...DEFAULT_ENGINE_CONFIG,
    ...config,
  };

  const compileCache = new Map<string, FadhilWebCompiledSyntax>();

  const precompile = (input: FadhilWebSyntax | NextGenCompileInput, options: NextGenCompileOptions = {}): FadhilWebCompiledSyntax => {
    const fragments: Array<FadhilWebSyntax | undefined> = [];

    if (resolvedConfig.contextualDefaults) {
      fragments.push(resolvedConfig.contextualDefaults);
    }

    if (options.defaults) {
      fragments.push(options.defaults);
    }

    for (const fragment of toSyntaxFragments(input)) {
      if (typeof fragment === 'string' && !resolvedConfig.allowUltraShortAliases) {
        throw new FadhilWebSyntaxError('fadhilweblib syntax: Ultra-short string syntax is disabled by configuration.');
      }

      if (typeof fragment === 'object' && fragment !== null && !('__fwlbType' in fragment) && !resolvedConfig.allowVerboseDeclarations) {
        throw new FadhilWebSyntaxError('fadhilweblib syntax: Verbose object syntax is disabled by configuration.');
      }

      fragments.push(fragment);
    }

    const merged = composeSyntax(...fragments);
    const cacheKey = createInputFingerprint(input, options, resolvedConfig.contextualDefaults);
    const cached = compileCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const compiled = compileSyntax(merged);
    rememberCompileCache(compileCache, cacheKey, compiled, resolvedConfig.cacheSize);
    return compiled;
  };

  const resolve = (input: FadhilWebSyntax | NextGenCompileInput, options: NextGenCompileOptions = {}) => precompile(input, options).resolved;

  const normalizeObject = (input: FadhilWebSyntaxObject): FadhilWebFlatSyntaxObject => {
    const result: Record<string, unknown> = {};

    for (const [rawKey, value] of Object.entries(input)) {
      const group = normalizeUltraShortGroup(rawKey, resolvedConfig.customGroupAliases);
      if (group && typeof value === 'object' && value && !Array.isArray(value)) {
        const normalizedGroupEntries = Object.fromEntries(
          Object.entries(value).map(([groupKey, groupValue]) => {
            const normalizedKey = normalizeUltraShortKey(groupKey, resolvedConfig.customKeyAliases);
            return [normalizedKey ?? groupKey, groupValue];
          }),
        );

        result[group] = normalizedGroupEntries;
        continue;
      }

      const key = normalizeUltraShortKey(rawKey, resolvedConfig.customKeyAliases);
      if (!key) {
        result[rawKey] = value;
        continue;
      }

      result[key] = value;
    }

    return parseSyntaxInput(result as FadhilWebSyntaxObject);
  };

  return Object.freeze({
    config: Object.freeze(resolvedConfig),
    precompile,
    resolve,
    analyze: (input: FadhilWebSyntax) => analyzeNextGenSyntax(input, resolvedConfig),
    benchmark: benchmarkNextGenSyntax,
    normalizeObject,
  });
}

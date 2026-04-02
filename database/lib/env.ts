import { AppError } from '@/lib/errors';

type ParsedDbUrl = {
  label: string;
  raw: string;
  hostname: string;
  port: string;
  username: string;
  database: string;
};

export type ResolvedDbConfig = {
  url: string;
  source: string;
  hostname: string;
  runtime: 'vercel' | 'server';
};

function parseDbUrl(rawValue: string, label: string): ParsedDbUrl {
  const raw = rawValue.trim();
  if (raw.length === 0) {
    throw new AppError(`${label} is empty`, 503);
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AppError(`${label} is invalid`, 503);
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new AppError(`${label} must use postgres/postgresql protocol`, 503);
  }

  const database = parsed.pathname.replace(/^\//, '');
  if (!parsed.username || !parsed.password || database.length === 0) {
    throw new AppError(`${label} must include username, password, and database name`, 503);
  }

  return {
    label,
    raw,
    hostname: parsed.hostname.toLowerCase(),
    port: parsed.port,
    username: parsed.username,
    database
  };
}

function isInternalRailwayHost(hostname: string): boolean {
  return hostname.endsWith('.railway.internal');
}

function withConnectionSafeguards(url: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  const isRailwayProxyHost = host.endsWith('.proxy.rlwy.net');
  const shouldRequireSsl = isRailwayProxyHost || host.endsWith('.up.railway.app');

  if (shouldRequireSsl && !parsed.searchParams.has('sslmode')) {
    parsed.searchParams.set('sslmode', 'require');
  }

  if (!parsed.searchParams.has('connect_timeout')) {
    parsed.searchParams.set('connect_timeout', '5');
  }

  if (!parsed.searchParams.has('pool_timeout')) {
    parsed.searchParams.set('pool_timeout', '10');
  }

  if (isRailwayProxyHost && !parsed.searchParams.has('pgbouncer')) {
    parsed.searchParams.set('pgbouncer', 'true');
  }

  if (isRailwayProxyHost && !parsed.searchParams.has('connection_limit')) {
    parsed.searchParams.set('connection_limit', '1');
  }

  return parsed.toString();
}

function getExplicitPublicCandidates(): ParsedDbUrl[] {
  const explicit = [
    ['DATABASE_URL_PUBLIC', process.env.DATABASE_URL_PUBLIC],
    ['DATABASE_PUBLIC_URL', process.env.DATABASE_PUBLIC_URL]
  ] as const;

  const parsed: ParsedDbUrl[] = [];
  for (const [label, value] of explicit) {
    if (!value || value.trim().length === 0) {
      continue;
    }

    parsed.push(parseDbUrl(value, label));
  }

  return parsed;
}

function isPublicRuntime(): boolean {
  return Boolean(process.env.VERCEL || process.env.VERCEL_ENV || process.env.FORCE_PUBLIC_DATABASE_URL === 'true');
}

function toConfig(parsed: ParsedDbUrl, runtime: 'vercel' | 'server'): ResolvedDbConfig {
  return {
    url: withConnectionSafeguards(parsed.raw),
    source: parsed.label,
    hostname: parsed.hostname,
    runtime
  };
}

function dedupeConfigs(configs: ResolvedDbConfig[]): ResolvedDbConfig[] {
  const seen = new Set<string>();
  const next: ResolvedDbConfig[] = [];

  for (const config of configs) {
    if (seen.has(config.url)) {
      continue;
    }

    seen.add(config.url);
    next.push(config);
  }

  return next;
}

function resolveForPublicRuntime(primary: ParsedDbUrl): ResolvedDbConfig[] {
  const publicCandidates = getExplicitPublicCandidates();

  for (const candidate of publicCandidates) {
    if (isInternalRailwayHost(candidate.hostname)) {
      throw new AppError(`${candidate.label} cannot use .railway.internal host`, 503);
    }
  }

  const candidates: ResolvedDbConfig[] = [];
  for (const candidate of publicCandidates) {
    candidates.push(toConfig(candidate, 'vercel'));
  }

  if (!isInternalRailwayHost(primary.hostname)) {
    candidates.push(toConfig(primary, 'vercel'));
  }

  const deduped = dedupeConfigs(candidates);
  if (deduped.length === 0) {
    throw new AppError(
      'Public runtime requires a public PostgreSQL URL. Set DATABASE_URL_PUBLIC or DATABASE_PUBLIC_URL to Railway public URL with ?sslmode=require.',
      503
    );
  }

  return deduped;
}

function resolveForServerRuntime(primary: ParsedDbUrl): ResolvedDbConfig[] {
  return [toConfig(primary, 'server')];
}

let cached: ResolvedDbConfig[] | null = null;

export function hasDatabaseUrlConfig(): boolean {
  return Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim().length > 0);
}

export function resolveDatabaseConfigs(): ResolvedDbConfig[] {
  if (cached) {
    return cached;
  }

  if (!hasDatabaseUrlConfig()) {
    throw new AppError('Missing required environment variable: DATABASE_URL', 503);
  }

  const primary = parseDbUrl(process.env.DATABASE_URL!, 'DATABASE_URL');
  cached = isPublicRuntime() ? resolveForPublicRuntime(primary) : resolveForServerRuntime(primary);

  return cached;
}

export function resolveDatabaseConfig(): ResolvedDbConfig {
  return resolveDatabaseConfigs()[0];
}

export function resolveDatabaseUrl(): string {
  return resolveDatabaseConfig().url;
}

export function getSafeDatabaseRuntimeMeta() {
  const config = resolveDatabaseConfig();
  return {
    source: config.source,
    hostname: config.hostname,
    runtime: config.runtime
  };
}

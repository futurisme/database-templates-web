import { PrismaClient } from '@prisma/client';
import { AppError, getPrismaAvailabilityIssue } from '@/lib/errors';
import { hasDatabaseUrlConfig, resolveDatabaseConfig, resolveDatabaseConfigs, type ResolvedDbConfig } from '@/lib/env';

type PrismaRuntimeState = {
  clients: Map<string, PrismaClient>;
  unhealthyUrls: Set<string>;
  activeUrl: string;
  activeSource: string;
};

declare global {
  // eslint-disable-next-line no-var
  var prismaState: PrismaRuntimeState | undefined;
}

function getState(): PrismaRuntimeState {
  if (!global.prismaState) {
    global.prismaState = {
      clients: new Map<string, PrismaClient>(),
      unhealthyUrls: new Set<string>(),
      activeUrl: '',
      activeSource: ''
    };
  }

  return global.prismaState;
}

function createClient(url: string): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url } },
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error']
  });
}

function getClientForUrl(url: string): PrismaClient {
  const state = getState();
  const existing = state.clients.get(url);

  if (existing) {
    return existing;
  }

  const client = createClient(url);
  state.clients.set(url, client);
  return client;
}

async function evictClient(url: string): Promise<void> {
  const state = getState();
  const client = state.clients.get(url);
  state.clients.delete(url);

  if (state.activeUrl === url) {
    state.activeUrl = '';
    state.activeSource = '';
  }

  state.unhealthyUrls.add(url);

  if (!client) {
    return;
  }

  await client.$disconnect();
}

function shouldRetryWithFallback(error: unknown): boolean {
  return Boolean(getPrismaAvailabilityIssue(error));
}

export function getDb(): PrismaClient {
  const state = getState();
  const config = resolveDatabaseConfig();
  const url = state.activeUrl || config.url;
  return getClientForUrl(url);
}

export async function withDb<T>(operation: (db: PrismaClient, source: string) => Promise<T>): Promise<T> {
  if (process.env.DB_DISABLED === 'true') {
    throw new AppError(
      'Database sedang dinonaktifkan (DB_DISABLED=true). Endpoint ini berjalan dalam mode fallback tanpa akses database.',
      503
    );
  }

  if (!hasDatabaseUrlConfig()) {
    throw new AppError(
      'Database dinonaktifkan karena DATABASE_URL belum dikonfigurasi. Jalankan mode fallback/non-database untuk endpoint yang mendukung.',
      503
    );
  }

  const state = getState();
  const configs = resolveDatabaseConfigs();

  const prioritized: ResolvedDbConfig[] = [];
  const healthyCandidates = configs.filter((item) => !state.unhealthyUrls.has(item.url));
  const candidatePool = healthyCandidates.length > 0 ? healthyCandidates : configs;

  if (state.activeUrl) {
    const active = candidatePool.find((item) => item.url === state.activeUrl);
    if (active) prioritized.push(active);
  }

  for (const config of candidatePool) {
    if (!prioritized.some((item) => item.url === config.url)) {
      prioritized.push(config);
    }
  }

  const failures: string[] = [];

  for (const config of prioritized) {
    const client = getClientForUrl(config.url);
    try {
      const result = await operation(client, config.source);
      state.activeUrl = config.url;
      state.activeSource = config.source;
      state.unhealthyUrls.delete(config.url);
      return result;
    } catch (error) {
      const issue = getPrismaAvailabilityIssue(error);
      const message = issue
        ? `${config.source}: ${issue}`
        : `${config.source}: ${error instanceof Error ? error.message : 'unknown database error'}`;
      failures.push(message);

      if (!shouldRetryWithFallback(error)) {
        throw error;
      }

      await evictClient(config.url);
    }
  }

  throw new AppError(
    `Database unavailable across configured sources (${failures.join(' | ')}). Validate public/internal connection strings and credentials.`,
    503
  );
}

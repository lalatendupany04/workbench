import { Queue, type RedisOptions } from "bullmq";
import { Cluster, Redis } from "ioredis";

/**
 * Discover BullMQ queues on a Redis connection by scanning for `<prefix>:*:meta`
 * keys. Returns one `Queue` instance per discovered queue, each constructed
 * with a fresh clone of the connection options.
 *
 * Used by `WorkbenchCore.fromOptions` for the desktop client where the user
 * supplies a Redis URL but no explicit queue list.
 */
export async function discoverQueues(
  connection: string | RedisOptions,
  prefix = "bull",
): Promise<Queue[]> {
  const normalized = normalizeConnection(connection);
  try {
    const names = await discoverQueueNamesStandalone(normalized, prefix);
    return names.map(
      (name) =>
        new Queue(name, {
          connection: { ...normalized },
          prefix,
        }),
    );
  } catch (error) {
    if (!shouldTryClusterFallback(error, normalized)) {
      throw error;
    }

    const cluster = await connectClusterWithRetry(normalized);
    try {
      const names = await scanQueueNamesCluster(cluster, prefix);
      return names.map(
        (name) =>
          new Queue(name, {
            connection: cluster,
            prefix,
          }),
      );
    } catch (clusterError) {
      cluster.disconnect();
      throw clusterError;
    }
  }
}

async function discoverQueueNamesStandalone(
  normalized: RedisOptions & { url?: string },
  prefix: string,
): Promise<string[]> {
  const client = createScanClient(normalized);
  const firstError = captureFirstError(client);
  try {
    await Promise.race([client.ping(), firstError.promise]);
    return scanQueueNames(client, prefix);
  } finally {
    firstError.dispose();
    client.disconnect();
  }
}

function captureFirstError(client: Redis | Cluster): {
  promise: Promise<never>;
  dispose: () => void;
} {
  let onError: ((err: Error) => void) | null = null;
  const promise = new Promise<never>((_, reject) => {
    onError = (err) => reject(err);
    client.once("error", onError);
  });
  // Swallow further errors after the first so ioredis doesn't kill the
  // process with an "unhandled error event" once we've already rejected.
  client.on("error", () => {});
  return {
    promise,
    dispose: () => {
      if (onError) client.off("error", onError);
    },
  };
}

/**
 * Normalize a `string | RedisOptions` connection into a single `RedisOptions`
 * shape with `{ url }` (when a URL string was passed). BullMQ's `Queue`
 * accepts `{ url: "redis://..." }` but not a bare URL string, so this is the
 * canonical adapter form.
 */
function normalizeConnection(
  connection: string | RedisOptions,
): RedisOptions & { url?: string } {
  if (typeof connection === "string") {
    return { url: connection } as RedisOptions & { url?: string };
  }
  return { ...connection };
}

function createScanClient(opts: RedisOptions & { url?: string }): Redis {
  // ioredis accepts the `url` field directly via its constructor; we pass it
  // explicitly to make the `bun build --compile` static analysis happy.
  const { url, ...rest } = opts;
  if (url) {
    return new Redis(url, {
      ...rest,
      lazyConnect: false,
      maxRetriesPerRequest: 1,
    });
  }
  return new Redis({ ...rest, lazyConnect: false, maxRetriesPerRequest: 1 });
}

function createClusterClient(opts: RedisOptions & { url?: string }): Cluster {
  const { url, ...rest } = opts;
  const startupNode = getStartupNode(url, rest);
  const parsed = url ? new URL(url) : null;
  const usernameFromUrl = parsed?.username
    ? decodeURIComponent(parsed.username)
    : "";
  const passwordFromUrl = parsed?.password
    ? decodeURIComponent(parsed.password)
    : "";
  const isTls = (parsed?.protocol ?? "").toLowerCase() === "rediss:";

  return new Cluster([startupNode], {
    // Keep hostnames for TLS cert validation on managed Redis cluster nodes.
    dnsLookup: (address, callback) => callback(null, address),
    redisOptions: {
      ...rest,
      username: rest.username ?? (usernameFromUrl || undefined),
      password: rest.password ?? (passwordFromUrl || undefined),
      tls: rest.tls ?? (isTls ? {} : undefined),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    },
  });
}

function getStartupNode(
  url: string | undefined,
  opts: RedisOptions,
): { host: string; port: number } {
  if (url) {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 6379,
    };
  }
  return {
    host: opts.host ?? "127.0.0.1",
    port: opts.port ?? 6379,
  };
}

async function connectClusterWithRetry(
  normalized: RedisOptions & { url?: string },
): Promise<Cluster> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const cluster = createClusterClient(normalized);
    cluster.on("error", () => {});
    try {
      try {
        await withTimeout(
          cluster.connect(),
          5000,
          "Redis cluster connect timed out",
        );
      } catch (connectError) {
        if (!isAlreadyConnectingError(connectError)) {
          throw connectError;
        }
      }
      await withTimeout(cluster.ping(), 5000, "Redis cluster ping timed out");
      return cluster;
    } catch (error) {
      lastError = error;
      cluster.disconnect();
      if (!isRetryableClusterError(error) || attempt >= 2) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to connect to Redis cluster");
}

/**
 * Cursored SCAN for `<prefix>:*:meta` keys. BullMQ writes a meta key for each
 * queue on first use; using that as the discovery signal avoids matching
 * jobs, locks, or other namespaced sub-keys.
 */
async function scanQueueNames(
  client: Redis,
  prefix: string,
): Promise<string[]> {
  const pattern = `${prefix}:*:meta`;
  const names = new Set<string>();
  let cursor = "0";

  do {
    const [next, batch] = await client.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      500,
    );
    cursor = next;
    for (const key of batch) {
      const name = parseQueueName(key, prefix);
      if (name) names.add(name);
    }
  } while (cursor !== "0");

  return Array.from(names).sort();
}

async function scanQueueNamesCluster(
  cluster: Cluster,
  prefix: string,
): Promise<string[]> {
  const names = new Set<string>();
  const nodes = cluster.nodes("master");
  for (const node of nodes) {
    const fromNode = await scanQueueNames(node, prefix);
    for (const name of fromNode) names.add(name);
  }
  return Array.from(names).sort();
}

function shouldTryClusterFallback(
  error: unknown,
  normalized: RedisOptions & { url?: string },
): boolean {
  if (isMovedError(error) || isRetryableClusterError(error)) {
    return true;
  }
  const host = normalized.url ? new URL(normalized.url).hostname : normalized.host;
  return typeof host === "string" && host.toLowerCase().startsWith("clustercfg.");
}

function isMovedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /^\s*MOVED\s+\d+\s+\S+:\d+/i.test(error.message);
}

function isRetryableClusterError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.trim().toLowerCase();
  return (
    msg.includes("connection is closed") ||
    msg.includes("failed to refresh slots cache") ||
    msg.includes("cluster all failed") ||
    msg.includes("timed out")
  );
}

function isAlreadyConnectingError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /already connecting\/connected/i.test(error.message);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseQueueName(key: string, prefix: string): string | null {
  const head = `${prefix}:`;
  const tail = ":meta";
  if (!key.startsWith(head) || !key.endsWith(tail)) return null;
  return key.slice(head.length, key.length - tail.length);
}

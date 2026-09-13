export type PinnedReadCacheStats = { hits: number; misses: number; bypassed: number };

function stable(value: unknown, seen = new Set<object>()): string | null {
  if (value === null) return "null";
  switch (typeof value) {
    case "string": return JSON.stringify(value);
    case "boolean": return value ? "true" : "false";
    case "number": return Number.isFinite(value) ? `n:${value}` : null;
    case "bigint": return `b:${value}`;
    case "undefined": return "u";
    case "object": break;
    default: return null;
  }
  const object = value as object;
  if (Reflect.ownKeys(object).some(key => typeof key === "symbol" || !Object.getOwnPropertyDescriptor(object, key)?.enumerable && key !== "length" || !!Object.getOwnPropertyDescriptor(object, key)?.get || !!Object.getOwnPropertyDescriptor(object, key)?.set)) return null;
  if (seen.has(object)) return null;
  seen.add(object);
  let result: string | null;
  if (Array.isArray(value)) {
    const parts = value.map(item => stable(item, seen));
    result = parts.some(item => item === null) ? null : `[${parts.join(",")}]`;
  } else if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const parts: string[] = [];
    result = "";
    for (const key of keys) {
      const part = stable((value as Record<string, unknown>)[key], seen);
      if (part === null) { result = null; break; }
      parts.push(`${JSON.stringify(key)}:${part}`);
    }
    if (result !== null) result = `{${parts.join(",")}}`;
  } else result = null;
  seen.delete(object);
  return result;
}

function identity(call: Record<string, unknown>, blockNumber: bigint): string | null {
  if (call.blockNumber !== blockNumber || Object.prototype.hasOwnProperty.call(call, "blockTag")) return null;
  return stable(call);
}

/** A bounded cache for one already-pinned request; it never caches chain or block reads. */
export function createPinnedReadCache(client: any, blockNumber: bigint, signal?: AbortSignal) {
  const entries = new Map<string, Promise<unknown>>();
  const stats: PinnedReadCacheStats = { hits: 0, misses: 0, bypassed: 0 };
  const readContract = async (call: Record<string, unknown>) => {
    signal?.throwIfAborted();
    const key = identity(call, blockNumber);
    if (key === null || (!entries.has(key) && entries.size >= 4096)) {
      stats.bypassed += 1;
      const value = await client.readContract(call);
      signal?.throwIfAborted();
      return value;
    }
    let pending = entries.get(key);
    if (pending) stats.hits += 1;
    else {
      stats.misses += 1;
      pending = Promise.resolve().then(() => client.readContract(call));
      entries.set(key, pending);
      pending.catch(() => { if (entries.get(key!) === pending) entries.delete(key!); });
    }
    const value = await pending;
    signal?.throwIfAborted();
    return structuredClone(value);
  };
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "readContract") return readContract;
      if (property === "pinnedReadCacheStats") return stats;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

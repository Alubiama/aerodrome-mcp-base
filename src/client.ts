import { createPublicClient, fallback, http, type Transport } from "viem";
import { base } from "viem/chains";
import { setTimeout as delay } from "node:timers/promises";
import type { AppConfig } from "./types.js";

const officialStandardRpc = "https://mainnet.base.org";
const officialFlashblocksRpc = "https://mainnet-preconf.base.org";
const publicNodeFallbackRpc = "https://base-rpc.publicnode.com";
type RpcThrottleState = {
  queue: Promise<void>;
  windowStartedAt: number;
  requestsInWindow: number;
  cooldownUntil: number;
};
const rpcThrottleStates = new Map<string, RpcThrottleState>();

function rpcThrottleState(url: string): RpcThrottleState {
  const existing = rpcThrottleStates.get(url);
  if (existing) return existing;
  const state: RpcThrottleState = {
    queue: Promise.resolve(),
    windowStartedAt: 0,
    requestsInWindow: 0,
    cooldownUntil: 0
  };
  rpcThrottleStates.set(url, state);
  return state;
}

export function isRateLimitedRpcError(error: Error): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const item = current as { code?: unknown; status?: unknown; message?: unknown; cause?: unknown };
    const message = typeof item.message === "string" ? item.message : "";
    if (
      item.code === -32016 ||
      item.code === -32001 ||
      item.status === 429 ||
      /rate limit|usage limit|too many requests|limit exceeded|current plan|Cannot read properties of undefined \(reading 'error'\)/i.test(message)
    ) {
      return true;
    }
    current = item.cause;
  }
  return false;
}

export function shouldStopRpcFallback(error: Error): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const item = current as { name?: unknown; message?: unknown; cause?: unknown };
    const name = typeof item.name === "string" ? item.name : "";
    const message = typeof item.message === "string" ? item.message : "";
    if (name === "ContractFunctionRevertedError" || name === "ExecutionRevertedError") return true;
    if (/execution reverted|contract function .*reverted|reverted with|out of bounds|invalid opcode/i.test(message)) return true;
    current = item.cause;
  }
  return false;
}

function throttledHttp(url: string, batchRpc = false, retryRateLimits = true, timeoutMs = 30_000, signal?: AbortSignal): Transport {
  const requestsPerWindow = batchRpc ? 4 : 2;
  const windowMs = 1_000;
  const transport = http(url, {
    batch: batchRpc ? { batchSize: 4, wait: 50 } : false,
    timeout: timeoutMs,
    // Combine caller cancellation with viem's own per-request timeout signal.
    fetchFn: signal ? (input, init) => fetch(input, {
      ...init,
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs), ...(init?.signal ? [init.signal] : [])])
    }) : undefined,
    retryCount: 0
  });
  return (options) => {
    const inner = transport(options);
    const state = rpcThrottleState(url);
    const request = (async (args: Parameters<typeof inner.request>[0], override?: Parameters<typeof inner.request>[1]) => {
      signal?.throwIfAborted();
      const turn = state.queue.then(async () => {
        signal?.throwIfAborted();
        if (retryRateLimits && state.cooldownUntil > Date.now()) {
          throw Object.assign(new Error("RPC endpoint is cooling down after a rate limit."), { code: -32016 });
        }
        let now = Date.now();
        if (state.windowStartedAt === 0 || now - state.windowStartedAt >= windowMs) {
          state.windowStartedAt = now;
          state.requestsInWindow = 0;
        }
        if (state.requestsInWindow >= requestsPerWindow) {
          const waitMs = Math.max(0, state.windowStartedAt + windowMs - now);
          if (waitMs > 0) await delay(waitMs, undefined, { signal });
          now = Date.now();
          state.windowStartedAt = now;
          state.requestsInWindow = 0;
        }
        state.requestsInWindow += 1;
      });
      state.queue = turn.catch(() => undefined);
      await turn;
      signal?.throwIfAborted();
      try {
        // viem keys batch schedulers by request signal as well as URL. Keep
        // concurrent MCP requests isolated so cancelling one cannot abort another.
        return await inner.request(args, signal ? { ...override, signal } : override);
      } catch (error) {
        if (retryRateLimits && error instanceof Error && isRateLimitedRpcError(error)) {
          state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + 30_000);
        }
        throw error;
      }
    }) as typeof inner.request;
    return {
      ...inner,
      config: {
        ...inner.config,
        key: `${inner.config.key}-throttled`,
        name: `${inner.config.name} (rate limited)`
      },
      request
    };
  };
}

export function makeClient(cfg: AppConfig, options: { batchRpc?: boolean; timeoutMs?: number; signal?: AbortSignal } = {}) {
  const batchRpc = options.batchRpc === true;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const standard = throttledHttp(cfg.baseRpcUrl, batchRpc, true, timeoutMs, options.signal);
  const transport = fallback([
    standard,
    throttledHttp(officialFlashblocksRpc, batchRpc, true, timeoutMs, options.signal),
    throttledHttp(publicNodeFallbackRpc, batchRpc, true, timeoutMs, options.signal)
  ], {
    rank: false,
    retryCount: 0,
    retryDelay: 1_000,
    shouldThrow: (error) => options.signal?.aborted === true || shouldStopRpcFallback(error)
  });
  return createPublicClient({
    chain: base,
    transport
  });
}

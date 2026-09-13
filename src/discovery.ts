const MAX_PARALLEL_READS = 4;
function isReadTransportFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out|stale|rate.?limit|network error|disconnected|read-only rpc relay|browser stopped the read-only rpc/i.test(message);
}

export async function readContractsBounded(
  client: any,
  contracts: any[],
  requestedConcurrency: number,
  failFastOnTransportError = true
): Promise<any[]> {
  const results = new Array<any>(contracts.length);
  const concurrency = Math.max(1, Math.min(MAX_PARALLEL_READS, requestedConcurrency, contracts.length));
  let nextIndex = 0;
  let transportFailure: Error | undefined;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (!transportFailure && nextIndex < contracts.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: "success", result: await client.readContract(contracts[index]) };
      } catch (error) {
        results[index] = { status: "failure", error };
        if (failFastOnTransportError && isReadTransportFailure(error)) {
          transportFailure = error instanceof Error ? error : new Error(String(error));
        }
      }
    }
  }));
  if (transportFailure) throw transportFailure;
  return results;
}


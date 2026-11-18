export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Run tasks with at most `limit` in flight. Results keep task order. Tasks are expected to handle their own errors. */
export async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker));
  return results;
}

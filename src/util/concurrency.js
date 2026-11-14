// src/util/concurrency.js
// Minimal counting semaphore for bounded concurrency.

export class Semaphore {
  constructor(limit) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("Semaphore limit must be an integer >= 1");
    }
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active += 1;
  }

  release() {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }

  /** Run fn under the limit. */
  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/** Map over items with bounded concurrency; preserves input order. */
export async function mapWithConcurrency(items, limit, fn) {
  const sem = new Semaphore(limit);
  const results = new Array(items.length);
  await Promise.all(
    items.map((item, index) => sem.run(async () => {
      results[index] = await fn(item, index);
    })),
  );
  return results;
}

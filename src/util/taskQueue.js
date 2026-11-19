// src/util/taskQueue.js — in-process bounded worker pool with round-robin
// fairness across jobs and two priorities (rerun/zoom ahead of bulk analyze).
// Global singleton — all jobs share `VLM_CONCURRENCY` workers; tests can construct
// a fresh TaskQueue with their own concurrency.

const PRIORITY = { analyze: 10, rerun: 1, zoom: 1 };

export class TaskQueue {
  constructor({ concurrency = 3 } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("concurrency must be a positive integer");
    this.concurrency = concurrency;
    this.activeWorkerCount = concurrency;
    this.pending = [];
    this.active = new Set(); // Task objects currently running
    this.taskId = 0;
    this._last429At = 0;
  }

  enqueue(task) {
    if (!task || typeof task.run !== "function") throw new Error("task must have run()");
    if (!task.jobId) throw new Error("task must have jobId");
    task.priority = Number.isFinite(task.priority) ? task.priority : (PRIORITY[task.type] ?? 10);
    task.id = ++this.taskId;
    task.status = "queued";
    task.createdAt = Date.now();
    this.pending.push(task);
    this.drain();
    return task;
  }

  drain() {
    while (this.active.size < this.activeWorkerCount && this.pending.length > 0) {
      const idx = this._pickIndex();
      const [task] = this.pending.splice(idx, 1);
      this._start(task);
    }
  }

  _pickIndex() {
    const pending = this.pending;
    const firstPrio = Math.min(...pending.map((t) => t.priority));
    const inPrio = pending.filter((t) => t.priority === firstPrio);
    const jobIds = [...new Set(inPrio.map((t) => t.jobId))];
    // Round-robin across jobs within the same priority band.
    this._rr ??= new Map();
    const lastJob = this._rr.get(firstPrio);
    const idx = (jobIds.indexOf(lastJob) + 1) % jobIds.length;
    const chosenJob = jobIds[idx];
    this._rr.set(firstPrio, chosenJob);
    return pending.findIndex((t) => t.priority === firstPrio && t.jobId === chosenJob);
  }

  _start(task) {
    this.active.add(task);
    task.status = "running";
    task.startedAt = Date.now();
    task._doneResolve = null;
    task._doneReject = null;
    task.run()
      .then(() => { task.status = "done"; task.finishedAt = Date.now(); })
      .catch((err) => {
        task.status = "failed";
        task.error = String(err?.message ?? err).slice(0, 400);
        task.finishedAt = Date.now();
        if (/HTTP 429|rate.?limit|too many/i.test(task.error)) this._noteRateLimit(task);
      })
      .finally(() => {
        this.active.delete(task);
        this.drain();
        task.settled?.(task); // letAwait wrappers hook in here
      });
  }

  _noteRateLimit(task) {
    this._last429At = Date.now();
    if (this.activeWorkerCount > 1) {
      this.activeWorkerCount--;
      console.log(`[vlm] 429 seen (job ${task.jobId} slide ${task.slide ?? "?"}) — active workers ${this.activeWorkerCount}/${this.concurrency}`);
    }
  }

  restoreWorkerCountIfQuiet() {
    if (this.activeWorkerCount < this.concurrency && Date.now() - this._last429At > 60_000) {
      this.activeWorkerCount = Math.min(this.concurrency, this.activeWorkerCount + 1);
      console.log(`[vlm] quiet 60s — restored active workers to ${this.activeWorkerCount}/${this.concurrency}`);
    }
  }

  cancelJob(jobId) {
    let cancelled = 0;
    for (const t of [...this.pending]) {
      if (t.jobId === jobId) { t.status = "cancelled"; t.finishedAt = Date.now(); this.pending.splice(this.pending.indexOf(t), 1); cancelled++; }
    }
    for (const t of this.active) {
      if (t.jobId === jobId) { t.status = "cancelled"; /* best effort */ cancelled++; }
    }
    return cancelled;
  }

  retryFailedInJob(jobId, predicate = () => true) {
    let requeued = 0;
    for (const t of this.pending) {
      if (t.jobId === jobId && predicate(t)) { t.status = "queued"; t.error = null; t.attempts = (t.attempts ?? 0) + 1; requeued++; }
    }
    this.drain();
    return requeued;
  }

  pendingFor(jobId) { return this.pending.filter((t) => t.jobId === jobId).length; }
  activeFor(jobId) { return [...this.active].filter((t) => t.jobId === jobId).length; }

  stats() {
    return {
      concurrency: this.activeWorkerCount,
      maxConcurrency: this.concurrency,
      running: this.active.size,
      queued: this.pending.length,
      byPriority: {
        1: this.pending.filter((t) => t.priority === 1).length,
        10: this.pending.filter((t) => t.priority !== 1).length,
      },
    };
  }
}

/** Global worker pool — all jobs in this server process. */
export const queue = new TaskQueue({ concurrency: Number(process.env.VLM_CONCURRENCY) || 3 });

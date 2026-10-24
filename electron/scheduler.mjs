// Each pool represents one model runtime, never one runtime per conversation.
// Reservations cover independent KV/prefill growth; already-resident weights aren't charged per session.
// A resident managed runtime preallocated its KV/cache at launch, so MemAvailable already reflects it.
export class Scheduler {
  constructor({ inspect, memory, reserveGiB, execute, changed = () => {} }) {
    Object.assign(this, { inspect, memory, reserveGiB, execute, changed });
    this.pending = [];
    this.active = new Map();
    this.paused = new Set();
    this.pumping = false;
  }
  enqueue(job) {
    if (this.closed) throw new Error("The scheduler is closed");
    if (
      this.active.has(job.sessionId) ||
      this.pending.some((j) => j.sessionId === job.sessionId)
    )
      throw new Error("This session already has a pending turn");
    this.pending.push(job);
    // Child fan-out waits behind foreground turns already in the queue.
    this.pending.sort((a, b) => Number(!!a.taskId) - Number(!!b.taskId));
    this.pump();
  }
  reason(job) {
    const pool = this.inspect(job.modelId);
    if (pool.blocked) return pool.blocked;
    if (this.paused.has(pool.key)) return "This model queue is paused";
    const active = [...this.active.values()];
    if (
      active.filter((j) => this.inspect(j.modelId).key === pool.key).length >=
      pool.parallel
    )
      return `All ${pool.parallel} shared inference slots are busy`;
    if (pool.local && !pool.resident) {
      const mem = this.memory();
      if (!Number.isFinite(mem.availableGiB))
        return "Memory telemetry is unavailable; local work is waiting";
      const reserved = active
        .map((j) => this.inspect(j.modelId))
        .filter((p) => p.local && !p.resident)
        .reduce((n, p) => n + p.slotGiB, 0);
      if (mem.availableGiB - reserved - pool.slotGiB < this.reserveGiB())
        return "Waiting for memory headroom (KV cache + system reserve)";
    }
    return "";
  }
  async pump() {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      // Visit all pools so a blocked local model cannot block cloud work.
      for (const job of [...this.pending]) {
        const reason = this.reason(job);
        if (reason) {
          job.waiting?.(reason);
          continue;
        }
        this.pending.splice(this.pending.indexOf(job), 1);
        this.active.set(job.sessionId, job);
        Promise.resolve()
          .then(() => this.execute(job))
          .catch((error) => job.failed?.(error))
          .finally(() => {
            this.active.delete(job.sessionId);
            job.settled?.();
            this.changed();
            this.pump();
          });
      }
    } finally {
      this.pumping = false;
      this.changed();
    }
  }
  cancel(sid) {
    const index = this.pending.findIndex((j) => j.sessionId === sid);
    if (index >= 0) {
      this.pending.splice(index, 1)[0].controller.abort();
      this.changed();
      return true;
    }
    this.active.get(sid)?.controller.abort();
    return false;
  }
  pause(key, paused) {
    paused ? this.paused.add(key) : this.paused.delete(key);
    this.pump();
  }
  close() {
    this.closed = true;
    for (const job of [...this.pending.splice(0), ...this.active.values()])
      job.controller.abort();
  }
}

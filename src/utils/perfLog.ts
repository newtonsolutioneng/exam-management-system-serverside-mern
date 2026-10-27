// Lightweight timing logs, so slow screens can be diagnosed from the server console.
//   [perf] slow request   — any request taking longer than SLOW_MS
//   [perf] event loop     — the server process was too busy to answer anything for a while
//                           (this is what makes a browser show a long "initial connection")
import type { Request, Response, NextFunction } from "express";

const SLOW_MS = Number(process.env.PERF_SLOW_MS || 2000);
const LAG_MS  = Number(process.env.PERF_LAG_MS  || 500);

export function requestTiming(req: Request, res: Response, next: NextFunction) {
  const t0 = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms >= SLOW_MS) console.warn(`[perf] slow request ${req.method} ${req.originalUrl.split("?")[0]} -> ${res.statusCode} in ${(ms / 1000).toFixed(1)}s`);
  });
  next();
}

export function startEventLoopMonitor() {
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - last - 1000;
    last = now;
    if (lag >= LAG_MS) console.warn(`[perf] event loop blocked for ~${(lag / 1000).toFixed(1)}s (CPU-bound work in the server)`);
  }, 1000);
  timer.unref();
}

/**
 * Phase timer: `const lap = lapTimer("name"); ...; lap("phase one"); ...; lap("phase two"); lap.done();`
 * Prints one line with every phase, but only when the whole thing took SLOW_MS or more.
 */
export function lapTimer(name: string) {
  const start = Date.now();
  let last = start;
  const laps: string[] = [];
  const lap = (label: string) => { const now = Date.now(); laps.push(`${label} ${((now - last) / 1000).toFixed(1)}s`); last = now; };
  lap.done = () => {
    const total = Date.now() - start;
    if (total >= SLOW_MS) console.warn(`[perf] ${name}: total ${(total / 1000).toFixed(1)}s | ${laps.join(" | ")}`);
  };
  return lap;
}
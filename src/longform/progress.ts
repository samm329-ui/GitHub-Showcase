/**
 * Terminal progress reporting for the Long-form production.
 * Every counter shown derives from actual completed tasks — nothing here
 * fabricates progress.
 */
import { PHASES, type PhaseName } from "./config.js";

export class Progress {
  private started = new Map<string, number>();
  private finished = new Map<PhaseName, number>();
  /** Name of the most recently started phase — used for failure reporting. */
  static currentPhase = "LONG-FORM";

  header(title: string): void {
    const line = "=".repeat(48);
    console.log(`\n${line}\n  ${title}\n${line}\n`);
  }

  phaseStart(phase: PhaseName, index: number): void {
    Progress.currentPhase = phase;
    this.started.set(phase, Date.now());
    console.log(`\n[${index + 1}/${PHASES.length}] ${phase}`);
  }

  phaseDone(phase: PhaseName, detail?: string): void {
    const ms = this.started.has(phase) ? Date.now() - this.started.get(phase)! : 0;
    this.finished.set(phase, ms);
    console.log(`[${PHASES.indexOf(phase) + 1}/${PHASES.length}] ${phase} — COMPLETE (${(ms / 1000).toFixed(1)}s)${detail ? ` — ${detail}` : ""}`);
  }

  phaseFailed(phase: PhaseName, detail?: string): void {
    console.log(`[${PHASES.indexOf(phase) + 1}/${PHASES.length}] ${phase} — FAILED${detail ? ` — ${detail}` : ""}`);
  }

  /** Sub-steps inside a repository section. */
  step(label: string, state: "RUNNING" | "COMPLETE" | "WAITING" = "RUNNING"): void {
    console.log(`    [${state.padEnd(8)}] ${label}`);
  }

  repoHeader(rank: number, fullName: string): void {
    console.log(`\n  REPOSITORY RANK ${rank} — ${fullName}`);
    console.log("  " + "-".repeat(46));
  }

  /** Rendering progress: percent derived from frames actually written. */
  renderFrame(frame: number, total: number): void {
    const pct = Math.floor((frame / total) * 100);
    const last = Progress.lastRenderPct;
    if (pct !== last && (pct % 5 === 0 || frame === 1 || frame === total)) {
      Progress.lastRenderPct = pct;
      console.log(`    render ${pct}% (${frame}/${total} frames)`);
    }
  }

  private static lastRenderPct = -1;
}

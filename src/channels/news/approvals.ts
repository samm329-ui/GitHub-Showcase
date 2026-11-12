import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { ApprovalState, GateApproval, GateId } from "./types.js";

/**
 * File-based editorial approvals for the Lazy News channel.
 *
 * Gates A (factual package) and B (script+voice) are MANDATORY before
 * rendering under every configuration — no environment variable may bypass
 * them. Gate C remains mandatory before any publication. Approvals are
 * recorded as JSON artifacts (gate-approvals.json) with a SHA-256 of the
 * exact payload shown to the editor, so the record is reproducible.
 *
 * No interactive blocking prompt here: the pipeline is run in two phases —
 * prepare (produces reports) → review (someone writes approvals.json) →
 * render (fails loudly without approvals).
 */

export class ApprovalError extends Error {
  override name = "ApprovalError";
}

export function payloadHashOf(payload: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export async function readApprovalState(runDir: string): Promise<ApprovalState> {
  try {
    const raw = await fs.readFile(path.join(runDir, "gate-approvals.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<ApprovalState>;
    return {
      gateA: parsed.gateA ?? null,
      gateB: parsed.gateB ?? null,
      gateC: parsed.gateC ?? null,
    };
  } catch {
    return { gateA: null, gateB: null, gateC: null };
  }
}

export async function writeApprovalState(runDir: string, state: ApprovalState): Promise<void> {
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, "gate-approvals.json"), JSON.stringify(state, null, 2));
}

export async function recordGateApproval(
  runDir: string,
  gate: GateId,
  payload: unknown,
  approved: boolean,
  note: string
): Promise<GateApproval> {
  const state = await readApprovalState(runDir);
  const approval: GateApproval = {
    gate,
    approved,
    approvedAt: new Date().toISOString(),
    note,
    payloadHash: payloadHashOf(payload),
  };
  if (gate === "A") state.gateA = approval;
  else if (gate === "B") state.gateB = approval;
  else state.gateC = approval;
  await writeApprovalState(runDir, state);
  return approval;
}

/** The exact pre-render contract. Throws unless Gates A and B are approved. */
export function requireRenderApproval(ledgerVerifierPassed: boolean, state: ApprovalState): void {
  if (!ledgerVerifierPassed) {
    throw new ApprovalError("EVIDENCE_VERIFICATION_FAILED: the ledger did not pass deterministic verification.");
  }
  if (!state.gateA?.approved) {
    throw new ApprovalError(
      "FACT_APPROVAL_REQUIRED: Gate A (factual package) is not approved. " +
        "Run with --dry-run to produce the evidence report, review it, and write gate A approval via --approve A."
    );
  }
  if (!state.gateB?.approved) {
    throw new ApprovalError(
      "SCRIPT_APPROVAL_REQUIRED: Gate B (script + voice preview) is not approved. " +
        "Run with --dry-run to produce the script report, review it, and write gate B approval via --approve B."
    );
  }
}

export function requirePublicationReadiness(state: ApprovalState): void {
  if (!state.gateC?.approved) {
    throw new ApprovalError(
      "FINAL_RENDER_REVIEW_REQUIRED: Gate C (final MP4 preview) is not approved. " +
        "Preview the render, then record approval via --approve C before any publication."
    );
  }
}

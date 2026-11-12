import type { EvidenceLedger, EvidenceRecord } from "./types.js";

/**
 * Source credits (docs §14, credits rule).
 *
 * Credits name ONLY sources that support approved facts — primary records and
 * independent reporting. Discovery-only outlets never appear on-screen as
 * corroboration; their URLs may live in source-records.json for audit but
 * they are excluded here, period. Dates and attribution are preserved.
 */

export type SourceCredit = {
  name: string;
  url: string;
  role: "primary" | "independent_reporting";
  publishedAt: string | null;
  asOf?: string;
};

export type SourceCredits = {
  headline: string;   // e.g. "Based on reporting by X, Y — Nov 10"
  credits: SourceCredit[];
  primary: SourceCredit[];
  reporting: SourceCredit[];
};

const PUBLISHER_NAMES: Record<string, string> = {
  "Bennett, Coleman & Co. Ltd (Times Group)": "The Economic Times",
  "The Hindu Group": "The Hindu",
  "Government of India": "Government of India (PIB)",
  "Reserve Bank of India": "RBI",
  "Ministry of External Affairs": "MEA",
  "Parliament of India": "Sansad",
  "Election Commission of India": "Election Commission of India",
  "Supreme Court of India": "Supreme Court of India",
  "CAG": "CAG",
  "Ministry of Statistics and Programme Implementation": "MoSPI",
  "United Nations": "UN",
  "WHO": "WHO",
  "IMF": "IMF",
  "World Bank": "World Bank",
  "IAEA": "IAEA",
  "UNHCR": "UNHCR",
  "US SEC": "SEC (EDGAR)",
  "Cornell University": "arXiv",
  "OpenAI": "OpenAI newsroom",
  "Anthropic": "Anthropic newsroom",
  "Google": "Google blog",
  "NVIDIA": "NVIDIA newsroom",
  "PRS Legislative Research": "PRS",
};

function publisherDisplayName(evidence: EvidenceRecord): string {
  return PUBLISHER_NAMES[evidence.parentPublisherGroup] ?? evidence.parentPublisherGroup;
}

/** The exact set of sources allowed on-screen: evidence for approved facts with supporting role. */
export function buildSourceCredits(ledger: EvidenceLedger, publishedAtIso: string): SourceCredits {
  // Evidence backing approved (verified|attributed, contentClass=fact) facts only.
  const supportingFacts = ledger.facts.filter(
    f => f.contentClass === "fact" && (f.status === "verified" || f.status === "attributed")
  );
  const byPolicy = new Map<string, EvidenceRecord>();
  for (const fact of supportingFacts) {
    for (const e of fact.evidence) {
      const key = `${e.policy.sourceId}::${e.url}`;
      if (!byPolicy.has(key)) byPolicy.set(key, e);
    }
  }
  const evidence = [...byPolicy.values()].filter(e =>
    (e.policy.sourceRole === "primary" || e.policy.sourceRole === "independent_reporting") &&
    e.policy.permissionBasis !== "discovery_only" &&
    e.policy.enabled
  );

  const primary: SourceCredit[] = [];
  const reporting: SourceCredit[] = [];
  for (const e of evidence) {
    const credit: SourceCredit = {
      name: publisherDisplayName(e),
      url: e.url,
      role: e.policy.sourceRole === "primary" ? "primary" : "independent_reporting",
      publishedAt: e.publishedAt ?? null,
      asOf: e.eventDate ?? undefined,
    };
    if (credit.role === "primary") primary.push(credit);
    else reporting.push(credit);
  }

  const date = new Date(publishedAtIso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const seen = new Set<string>();
  const unique = (list: SourceCredit[]) => list.filter(c => (seen.has(c.name) ? false : (seen.add(c.name), true)));
  const primaryU = unique(primary);
  const reportingU = unique(reporting);
  const names = [...primaryU, ...reportingU].map(c => c.name).slice(0, 4);
  const headline = names.length > 0
    ? `Based on reporting by ${names.join(" · ")} — ${date}`
    : `Primary source reporting — ${date}`;

  return { headline, credits: [...primaryU, ...reportingU], primary: primaryU, reporting: reportingU };
}

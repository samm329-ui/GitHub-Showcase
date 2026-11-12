import assert from "node:assert/strict";
import { test, describe } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildSystemPrompt,
  buildUserPrompt,
  composeLlmScript,
} from "../src/llm-script.js";
import { resolveTargetSeconds, estimatedWordsForSeconds } from "../src/config.js";
import {
  matchPriorityCategories,
  priorityBonus,
  scoreCandidate,
} from "../src/github.js";
import { loadEnvFile } from "../src/load-env.js";
import { GroqError } from "../src/groq.js";
import type { EnrichedRepo, FactLedger, Repo } from "../src/types.js";

// The Groq client reads the key at call time; give the mocked tests a key so
// the missing-key error never fires (tests never reach the network).
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || "gsk_test_key";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function fakeRepo(overrides: Partial<Repo> = {}): Repo {
  const now = new Date().toISOString();
  return {
    full_name: "acme/rocket-cli",
    name: "rocket-cli",
    description: "Launch deployment previews from your terminal in one command",
    updated_at: now,
    created_at: now,
    pushed_at: now,
    stargazers_count: 1200,
    forks_count: 60,
    open_issues_count: 3,
    language: "TypeScript",
    languages: { TypeScript: 9000, Shell: 500 },
    default_branch: "main",
    license: { key: "mit", name: "MIT License", spdx_id: "MIT" },
    topics: ["cli", "developer-tools"],
    homepage: null,
    archived: false,
    disabled: false,
    fork: false,
    size: 256,
    ...overrides,
  } as Repo;
}

function fakeEnriched(overrides: Partial<EnrichedRepo> = {}): EnrichedRepo {
  const repo = fakeRepo();
  return {
    ...repo,
    nodeId: "node:acme/rocket-cli",
    owner: "acme",
    name: "rocket-cli",
    createdAt: repo.created_at!,
    updatedAt: repo.updated_at,
    pushedAt: repo.pushed_at ?? null,
    archived: false,
    disabled: false,
    fork: false,
    topics: repo.topics ?? [],
    homepage: null,
    languages: { TypeScript: 9000, Shell: 500 },
    primaryLanguage: "TypeScript",
    licenseSpdxId: "MIT",
    licenseName: "MIT License",
    openSourceLicense: "MIT",
    readmeText:
      "# Rocket CLI\n\nRocket CLI launches deployment previews from your terminal. " +
      "It works by creating an isolated ephemeral environment per branch and printing the URL.\n\n" +
      "## Install\n\n```bash\nnpm install -g rocket-cli\n```\n\n## Usage\n\nRun `rocket deploy`\n",
    readmeUrl: "https://github.com/acme/rocket-cli#readme",
    latestRelease: null,
    rootFiles: [],
    latestCommit: null,
    sizeKb: 256,
    capturedAt: new Date().toISOString(),
    ...overrides,
  } as EnrichedRepo;
}

function fakeLedger(): FactLedger {
  return {
    repositoryNodeId: "node:acme/rocket-cli",
    fullName: "acme/rocket-cli",
    capturedAt: new Date().toISOString(),
    facts: [
      {
        id: "purpose:readme-intro:rocket-cli-launches",
        kind: "purpose",
        semantic: "purpose",
        claim: "Rocket CLI launches deployment previews from your terminal in one command",
        spoken: "Rocket CLI launches deployment previews from your terminal in one command",
        source: { kind: "readme-section", location: "README.md#readme", capturedAt: new Date().toISOString() },
        confidence: 0.9,
      },
      {
        id: "mechanism:readme-how:isolated-environment",
        kind: "mechanism",
        semantic: "mechanism",
        claim: "It creates an isolated ephemeral environment per branch and prints the URL",
        spoken: "It creates an isolated ephemeral environment per branch and prints the URL",
        source: { kind: "readme-section", location: "README.md#how-it-works", capturedAt: new Date().toISOString() },
        provenance: { excerpt: "creates an isolated ephemeral environment per branch" },
        confidence: 0.85,
      },
      {
        id: "install:readme-install:npm-install",
        kind: "install",
        semantic: "setup",
        claim: "Install with `npm install -g rocket-cli`",
        spoken: "Install with npm install -g rocket cli",
        source: { kind: "readme-code", location: "README.md#install", capturedAt: new Date().toISOString() },
        confidence: 0.8,
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Mocked fetch                                                        */
/* ------------------------------------------------------------------ */

type MockCall = { url: string; body: { model: string; max_tokens: number } };

function mockFetch(
  responder: (call: MockCall, index: number) => {
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
  }
): { fetchImpl: typeof fetch; calls: MockCall[] } {
  const calls: MockCall[] = [];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const call: MockCall = {
      url: String(url),
      body: JSON.parse(String((init as { body: string }).body)),
    };
    calls.push(call);
    const answered = responder(call, calls.length - 1);
    const bodyText =
      answered.body === undefined ? "" : JSON.stringify(answered.body);
    return {
      ok: answered.status >= 200 && answered.status < 300,
      status: answered.status,
      headers: {
        get: (name: string) =>
          answered.headers?.[name.toLowerCase()] ?? null,
      },
      json: async () => JSON.parse(bodyText),
      text: async () => bodyText,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function completionResponse(segmentCount: number, wordsPerSegment: number) {
  const words = Array(wordsPerSegment).fill("rocket").join(" ");
  const purposes = ["identify", "explain", "demo", "install", "cta"];
  const segments = Array.from({ length: segmentCount }, (_, index) => ({
    purpose: purposes[index % purposes.length],
    spokenText: `Rocket CLI statement number ${index + 1} ${words}.`,
    captionText: `Rocket CLI statement number ${index + 1} (LLM-powered).`,
    visualAnchor: "repo-header",
    calloutText: null as string | null,
    calloutRole: null,
    emphasis: ["rocket"],
  }));
  return {
    model: "llama-3.3-70b-versatile",
    choices: [{ message: { content: JSON.stringify({ segments }) } }],
    usage: { prompt_tokens: 900, completion_tokens: 300, total_tokens: 1200 },
  };
}

/* ------------------------------------------------------------------ */
/* Prompt construction                                                  */
/* ------------------------------------------------------------------ */

describe("llm prompt construction", () => {
  test("system prompt carries the length budget and the JSON contract", () => {
    const prompt = buildSystemPrompt(45);
    assert.match(prompt, /116 spoken words/);
    assert.match(prompt, /"segments"/);
    assert.match(prompt, /hard limit/i);
  });

  test("user prompt embeds repo metadata, facts and a truncated README", () => {
    const repo = fakeEnriched({ readmeText: "x".repeat(9000) });
    const prompt = buildUserPrompt(repo, fakeLedger(), 35);
    assert.match(prompt, /acme\/rocket-cli/);
    assert.match(prompt, /Rocket CLI launches deployment previews/i);
    assert.match(prompt, /"truncated": true/);
    // The README payload must not exceed the configured cap.
    assert.ok(prompt.length < 9000 + 4000);
  });
});

describe("length resolution", () => {
  test("explicit override wins and clamps to the bounds", () => {
    assert.equal(resolveTargetSeconds(45), 45);
    assert.equal(resolveTargetSeconds(5), 18);
    assert.equal(resolveTargetSeconds(999), 58);
  });

  test("word budget scales with seconds", () => {
    assert.equal(estimatedWordsForSeconds(60), 155);
    assert.ok(estimatedWordsForSeconds(35) < estimatedWordsForSeconds(58));
  });
});

/* ------------------------------------------------------------------ */
/* Response handling                                                    */
/* ------------------------------------------------------------------ */

describe("composeLlmScript", () => {
  test("a valid JSON completion becomes a narration plan", async () => {
    const { fetchImpl, calls } = mockFetch(() => ({
      status: 200,
      body: completionResponse(5, 8),
    }));
    const result = await composeLlmScript(fakeEnriched(), fakeLedger(), {
      targetDurationSeconds: 35,
      fetchImpl,
      log: () => {},
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.max_tokens > 0, true);
    assert.equal(result.plan.segments.length, 5);
    assert.equal(result.plan.structure, "groq-llm");
    assert.equal(result.plan.styleVariant, "groq-llama-3.3-70b-versatile");
    assert.equal(result.plan.targetDurationSeconds, 35);
    assert.equal(result.plan.voiceId.length > 0, true);
    // LLM segments inherit an audit trail from the ledger by role.
    assert.ok(
      result.plan.segments.some(segment => segment.factIds.length > 0),
      "at least one segment should inherit ledger facts"
    );
    // Last segment carries an explicit zero pause.
    assert.equal(result.plan.segments.at(-1)!.pauseAfterMs, 0);
    // Captions keep display spelling; speech passes through toSpoken.
    assert.ok(
      result.plan.segments.some(segment => /LLM-powered/.test(segment.captionText))
    );
    assert.match(result.plan.segments[0].spokenText, /[.!?]$/);
    // Usage is surfaced for run.log / llm-response.json.
    assert.equal(result.usage?.totalTokens, 1200);
  });

  test("unparseable JSON fails the run", async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 200,
      body: { choices: [{ message: { content: "not json at all" } }] },
    }));
    await assert.rejects(
      composeLlmScript(fakeEnriched(), fakeLedger(), {
        targetDurationSeconds: 35,
        fetchImpl,
        log: () => {},
      }),
      (error: unknown) => error instanceof GroqError
    );
  });

  test("an over-long draft triggers exactly one shorten retry", async () => {
    let n = 0;
    const { fetchImpl, calls } = mockFetch(() => {
      n += 1;
      // First draft: far over the 58s ceiling. Second: compact.
      return { status: 200, body: completionResponse(6, n === 1 ? 60 : 4) };
    });
    const result = await composeLlmScript(fakeEnriched(), fakeLedger(), {
      targetDurationSeconds: 35,
      fetchImpl,
      log: () => {},
    });
    assert.equal(calls.length, 2);
    assert.equal(result.completions.length, 2);
  });

  test("a draft still over the ceiling after the retry fails the run", async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 200,
      body: completionResponse(6, 60),
    }));
    await assert.rejects(
      composeLlmScript(fakeEnriched(), fakeLedger(), {
        targetDurationSeconds: 35,
        fetchImpl,
        log: () => {},
      }),
      /still over the 58s ceiling/
    );
  });

  test("429 honours Retry-After and retries, then succeeds", async () => {
    const waits: number[] = [];
    const { fetchImpl, calls } = mockFetch((_call, index) => {
      if (index === 0) {
        return { status: 429, body: { error: { message: "rate limited" } }, headers: { "retry-after": "1" } };
      }
      return { status: 200, body: completionResponse(4, 6) };
    });
    const result = await composeLlmScript(fakeEnriched(), fakeLedger(), {
      targetDurationSeconds: 35,
      fetchImpl,
      sleep: async (ms: number) => {
        waits.push(ms);
      },
      log: () => {},
    });
    assert.equal(calls.length, 2);
    // Retry-After (1000ms) is a floor; the pipeline never waits less.
    assert.ok(waits[0] >= 1000);
    assert.equal(result.retries, 1);
  });

  test("persistent 429 exhausts the retry budget and fails", async () => {
    const waits: number[] = [];
    const { fetchImpl, calls } = mockFetch(() => ({
      status: 429,
      body: { error: { message: "rate limited" } },
      headers: { "retry-after": "0" },
    }));
    await assert.rejects(
      composeLlmScript(fakeEnriched(), fakeLedger(), {
        targetDurationSeconds: 35,
        fetchImpl,
        sleep: async (ms: number) => {
          waits.push(ms);
        },
        log: () => {},
      }),
      (error: unknown) =>
        error instanceof GroqError && error.status === 429
    );
    // 1 initial attempt + 3 retries = 4 calls, never more.
    assert.equal(calls.length, 4);
  });

  test("a 400 fails fast with no retry", async () => {
    const { fetchImpl, calls } = mockFetch(() => ({
      status: 400,
      body: { error: { message: "bad request" } },
    }));
    await assert.rejects(
      composeLlmScript(fakeEnriched(), fakeLedger(), {
        targetDurationSeconds: 35,
        fetchImpl,
        log: () => {},
      }),
      (error: unknown) => error instanceof GroqError && error.status === 400
    );
    assert.equal(calls.length, 1);
  });
});

/* ------------------------------------------------------------------ */
/* Priority scoring                                                     */
/* ------------------------------------------------------------------ */

describe("priority categories", () => {
  test("an agent repository matches the agents category", () => {
    const matches = matchPriorityCategories({
      topics: ["ai-agent", "mcp"],
      description: "An agent framework for autonomous tool use",
      name: "agent-x",
      full_name: "acme/agent-x",
    } as Repo);
    assert.equal(matches[0]?.id, "agents");
    assert.equal(priorityBonus({ topics: ["ai-agent"], description: "x", name: "x", full_name: "a/x" } as unknown as Repo), 10);
  });

  test("a finance repository matches by keyword even without topics", () => {
    const bonus = priorityBonus({
      topics: [],
      description: "Personal finance budgeting and invoicing for freelancers",
      name: "ledgerline",
      full_name: "acme/ledgerline",
    } as unknown as Repo);
    assert.equal(bonus, 8);
  });

  test("an AI repository matches by topic", () => {
    const bonus = priorityBonus({
      topics: ["llm", "rag"],
      description: "Retrieval augmented generation toolkit",
      name: "ragkit",
      full_name: "acme/ragkit",
    } as Repo);
    assert.equal(bonus, 8);
  });

  test("matching several categories takes the best bonus, capped at 10", () => {
    const bonus = priorityBonus({
      topics: ["llm", "ai-agent", "finance"],
      description: "Agentic LLM trading system",
      name: "tradebot",
      full_name: "acme/tradebot",
    } as Repo);
    assert.equal(bonus, 10);
  });

  test("a generic repository gets no bonus", () => {
    assert.equal(
      priorityBonus({
        topics: ["cli"],
        description: "A small command line utility",
        name: "util",
        full_name: "acme/util",
      } as Repo),
      0
    );
  });

  test("the bonus lands in the breakdown and the reasons", () => {
    const result = scoreCandidate({
      repo: fakeRepo({ topics: ["ai-agent", "llm"], description: "An AI agent framework" }),
      mode: "practical",
      readmeText:
        "# Agent X\n\nAgent X is an agent framework.\n\n## Install\n\n```bash\npip install agent-x\n```\n\n## Usage\n\nrun agent-x serve\n",
      release: null,
      momentum: { previousStars: null, previousCapturedAt: null, currentStars: 1200 },
    });
    assert.equal(result.breakdown.priority, 10);
    assert.ok(result.reasons.some(reason => /priority category: AI agents/.test(reason)));
  });
});

/* ------------------------------------------------------------------ */
/* .env loading                                                        */
/* ------------------------------------------------------------------ */

describe("load-env", () => {
  test("loads values from a .env file without overwriting the shell", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "load-env-"));
    fs.writeFileSync(
      path.join(dir, ".env"),
      [
        "# comment",
        "SHOWCASE_TEST_NEW=fresh",
        'SHOWCASE_TEST_QUOTED="quoted value"',
        "SHOWCASE_TEST_KEEP=from-file",
        "not a line",
        "",
      ].join("\n"),
      "utf8"
    );
    process.env.SHOWCASE_TEST_KEEP = "from-shell";
    try {
      loadEnvFile(dir, { force: true });
      assert.equal(process.env.SHOWCASE_TEST_NEW, "fresh");
      assert.equal(process.env.SHOWCASE_TEST_QUOTED, "quoted value");
      assert.equal(process.env.SHOWCASE_TEST_KEEP, "from-shell");
    } finally {
      delete process.env.SHOWCASE_TEST_NEW;
      delete process.env.SHOWCASE_TEST_QUOTED;
      delete process.env.SHOWCASE_TEST_KEEP;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

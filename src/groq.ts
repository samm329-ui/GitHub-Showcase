import {
  GROQ_BASE_URL,
  GROQ_MAX_RETRIES,
  GROQ_MAX_TOKENS,
  GROQ_MODEL,
  GROQ_TIMEOUT_MS,
} from "./config.js";

/**
 * Minimal Groq (groq.com) chat-completions client.
 *
 * Rate-limit discipline (by construction, not by hope):
 *   - exactly one HTTP request per call; callers never loop per segment;
 *   - `max_tokens` is capped so a runaway completion cannot drain budget;
 *   - on HTTP 429 the `Retry-After` header is honoured, otherwise exponential
 *     backoff with full jitter (2s -> 4s -> 8s);
 *   - other 5xx responses get a single retry with backoff; everything else
 *     fails fast;
 *   - every call logs prompt/completion token usage so consumption is
 *     visible in `run.log`.
 *
 * No retries are attempted on 4xx (other than 429) — a malformed request
 * will fail identically every time.
 */

export class GroqError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly bodyExcerpt?: string
  ) {
    super(message);
    this.name = "GroqError";
  }
}

export type GroqChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type GroqUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

export type GroqCompletion = {
  content: string;
  model: string;
  usage: GroqUsage;
  /** How many retries were needed (0 = succeeded on the first try). */
  retries: number;
};

export type GroqChatOptions = {
  model?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** gpt-oss models only: "low" | "medium" | "high". Defaults to "low" for
   * gpt-oss ids (keeps reasoning from eating the completion budget), never
   * sent to other models. Set GROQ_REASONING_EFFORT=off to disable. */
  reasoningEffort?: "low" | "medium" | "high" | "off";
  /** Ask Groq for strict JSON output; the default for this pipeline. */
  json?: boolean;
  /** Injectable for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests. Defaults to a real sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Logger; defaults to console.error so the line still reaches run.log. */
  log?: (line: string) => void;
};

const defaultSleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * gpt-oss reasoning models put their chain-of-thought in `reasoning`, which
 * still counts against `max_tokens`. "low" keeps that small; other models
 * receive no `reasoning_effort` field at all. `GROQ_REASONING_EFFORT`
 * overrides the default; `off` disables the field entirely.
 */
function resolveReasoningEffort(
  model: string,
  override?: "low" | "medium" | "high" | "off"
): "low" | "medium" | "high" | null {
  const fromEnv = (process.env.GROQ_REASONING_EFFORT ?? "").toLowerCase();
  const requested =
    override ??
    (fromEnv === "low" || fromEnv === "medium" || fromEnv === "high" || fromEnv === "off"
      ? (fromEnv as "low" | "medium" | "high" | "off")
      : undefined);
  if (requested === "off") return null;
  if (requested) return requested;
  return model.includes("gpt-oss") ? "low" : null;
}

function backoffMs(attempt: number): number {
  // attempt is 1-based for the first retry. Full jitter over [base/2, base];
  // the floor grows generously because Groq 429s usually mean the token
  // budget for the current window is exhausted and needs a real pause.
  const base = 3000 * 2 ** (attempt - 1);
  return Math.round(base / 2 + Math.random() * (base / 2) + 1500 * attempt);
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

async function responseExcerpt(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.replace(/\s+/g, " ").trim().slice(0, 300);
  } catch {
    return "";
  }
}

export async function groqChatCompletion(
  messages: GroqChatMessage[],
  options: GroqChatOptions = {}
): Promise<GroqCompletion> {
  // Read at call time so tests can set/unset the key per case.
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new GroqError(
      "GROQ_API_KEY is not set. Add it to .env (see .env.example) or export it in the shell.",
      null
    );
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? ((line: string) => console.error(line));
  const model = options.model ?? GROQ_MODEL;
  const reasoningEffort = resolveReasoningEffort(model, options.reasoningEffort);
  const url = `${GROQ_BASE_URL.replace(/\/+$/, "")}/chat/completions`;

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: options.temperature ?? 0.7,
    top_p: options.topP ?? 0.95,
    max_tokens: options.maxTokens ?? GROQ_MAX_TOKENS,
    stream: false,
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(options.json === false ? {} : { response_format: { type: "json_object" } }),
  };

  let retries = 0;
  // Total attempts = 1 initial + GROQ_MAX_RETRIES retries.
  for (let attempt = 0; attempt <= GROQ_MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      const aborted =
        error instanceof Error && error.name === "AbortError";
      const message = aborted
        ? `Groq request timed out after ${GROQ_TIMEOUT_MS}ms`
        : `Groq request failed: ${error instanceof Error ? error.message : String(error)}`;
      if (attempt < GROQ_MAX_RETRIES) {
        const wait = backoffMs(attempt + 1);
        log(`  groq: ${message}; retrying in ${wait}ms (attempt ${attempt + 1}/${GROQ_MAX_RETRIES})...`);
        retries += 1;
        await sleep(wait);
        continue;
      }
      throw new GroqError(message, null);
    }
    clearTimeout(timer);

    if (response.ok) {
      let parsed: {
        model?: string;
        choices?: { message?: { content?: string | null } }[];
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      };
      try {
        parsed = (await response.json()) as typeof parsed;
      } catch {
        throw new GroqError("Groq returned a response that was not valid JSON.", response.status);
      }
      const content = parsed.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new GroqError("Groq returned an empty completion.", response.status);
      }
      const usage: GroqUsage = {
        promptTokens: parsed.usage?.prompt_tokens ?? null,
        completionTokens: parsed.usage?.completion_tokens ?? null,
        totalTokens: parsed.usage?.total_tokens ?? null,
      };
      log(
        `  groq: model=${parsed.model ?? model} ` +
          `prompt_tokens=${usage.promptTokens ?? "?"} ` +
          `completion_tokens=${usage.completionTokens ?? "?"} ` +
          `retries=${retries}`
      );
      return { content, model: parsed.model ?? model, usage, retries };
    }

    const excerpt = await responseExcerpt(response);

    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      if (attempt < GROQ_MAX_RETRIES) {
        // Retry-After is a floor from the server; never wait less than our
        // own backoff either (a short Retry-After often arrives mid-window).
        const wait = Math.max(retryAfterMs ?? 0, backoffMs(attempt + 1));
        log(
          `  groq: rate limited (429); waiting ${wait}ms ` +
            `(attempt ${attempt + 1}/${GROQ_MAX_RETRIES})...`
        );
        retries += 1;
        await sleep(wait);
        continue;
      }
      throw new GroqError(
        `Groq rate limit persisted after ${retries + 1} attempts (429).`,
        429,
        excerpt
      );
    }

    if (response.status >= 500 && attempt < GROQ_MAX_RETRIES) {
      const wait = backoffMs(attempt + 1);
      log(
        `  groq: server error (${response.status}); backing off for ${wait}ms ` +
          `(attempt ${attempt + 1}/${GROQ_MAX_RETRIES})...`
      );
      retries += 1;
      await sleep(wait);
      continue;
    }

    // 4xx (except 429) and exhausted 5xx: fail fast.
    throw new GroqError(
      `Groq request failed (${response.status}): ${excerpt || "no response body"}`,
      response.status,
      excerpt
    );
  }

  // Unreachable in practice (the loop always returns or throws), but keeps TS happy.
  throw new GroqError("Groq request failed unexpectedly.", null);
}

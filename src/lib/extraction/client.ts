import Anthropic from "@anthropic-ai/sdk";
import type { SupportedMimeType } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { ExtractionError, classifyError } from "./errors";
import {
  EXTRACTION_SYSTEM_PROMPT,
  EXTRACTION_USER_PROMPT,
  PROMPT_VERSION,
} from "./prompt";
import { buildOutputSchema } from "./schema";

export const EXTRACTION_MODEL = env.EXTRACTION_MODEL;
export const EXTRACTION_EFFORT = env.EXTRACTION_EFFORT;
const DEFAULT_MAX_TOKENS = env.EXTRACTION_MAX_TOKENS;
const RETRY_MAX_TOKENS = env.EXTRACTION_RETRY_MAX_TOKENS;

export interface CompletionRequest {
  bytes: Buffer;
  mimeType: SupportedMimeType;
  /** Set on the repair attempt; appended to the user turn. */
  repairHint?: string;
  maxTokens?: number;
}

export interface CompletionResult {
  text: string;
  model: string;
  effort: string;
  inputTokens: number;
  outputTokens: number;
}

/** Seam for tests: the whole pipeline runs against a fake completion. */
export type CompletionFn = (
  request: CompletionRequest,
  signal: AbortSignal,
) => Promise<CompletionResult>;

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  // Checked here rather than at import time: importing this module must not
  // break the upload/list/detail routes on a deploy that has no key yet.
  // The SDK's own message for this ("Could not resolve authentication
  // method…") does not say which variable to set or where.
  if (env.ANTHROPIC_API_KEY === undefined) {
    throw new ExtractionError(
      "NOT_AUTHORISED",
      "ANTHROPIC_API_KEY is not set. Add it to .env.local for local development, or to the project's environment variables when deploying.",
    );
  }

  // Passed explicitly rather than relying on the SDK reading process.env, so
  // the value that was validated at boot is the value that gets used.
  cachedClient ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2 });
  return cachedClient;
}

/**
 * PDFs go in as a `document` block, images as an `image` block. Both are
 * base64 inline — architecture.md deferred the Files API. The document block
 * comes before the text instruction, which is the documented ordering.
 */
function buildContent(request: CompletionRequest) {
  const data = request.bytes.toString("base64");
  const text = request.repairHint
    ? `${EXTRACTION_USER_PROMPT}\n\n${request.repairHint}`
    : EXTRACTION_USER_PROMPT;

  const source =
    request.mimeType === "application/pdf"
      ? ({
          type: "document" as const,
          source: { type: "base64" as const, media_type: "application/pdf" as const, data },
        })
      : ({
          type: "image" as const,
          source: { type: "base64" as const, media_type: request.mimeType, data },
        });

  return [source, { type: "text" as const, text }];
}

/**
 * `output_config.effort` is not universal: Haiku 4.5 and the Sonnet/Haiku 4.5
 * generation reject it outright with a 400. Sending it unconditionally would
 * make the cheapest models unusable, which is exactly backwards when the whole
 * reason to try them is cost.
 */
function supportsEffort(model: string): boolean {
  return !/haiku/i.test(model) && !/sonnet-4-5/i.test(model);
}

export const completeWithClaude: CompletionFn = async (request, signal) => {
  const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;

  let message;
  try {
    // Streaming is for timeout safety, not UI: the SDK guards against
    // non-streaming requests with large max_tokens, and an open stream avoids
    // an idle-connection drop mid-extraction.
    const stream = getClient().messages.stream(
      {
        model: EXTRACTION_MODEL,
        max_tokens: maxTokens,
        // Stable across every request, so it caches. The document is the only
        // varying part and it sits after this in the rendered prompt.
        system: [
          {
            type: "text",
            text: EXTRACTION_SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        output_config: {
          ...(supportsEffort(EXTRACTION_MODEL) ? { effort: EXTRACTION_EFFORT } : {}),
          format: { type: "json_schema", schema: buildOutputSchema() },
        },
        messages: [{ role: "user", content: buildContent(request) }],
      } as Anthropic.MessageStreamParams,
      { signal },
    );
    message = await stream.finalMessage();
  } catch (err) {
    throw classifyError(err);
  }

  // Checked before touching content: a refusal has no text block, and reading
  // content[0] first would throw a TypeError that tells us nothing.
  if (message.stop_reason === "refusal") {
    throw new ExtractionError("REFUSED", "Model declined to process the document.");
  }
  if (message.stop_reason === "max_tokens") {
    throw new ExtractionError(
      "OUTPUT_TRUNCATED",
      `Output hit the ${maxTokens} token cap.`,
    );
  }

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  if (text.trim() === "") {
    throw new ExtractionError("SCHEMA_INVALID", "Model returned no text content.");
  }

  return {
    text,
    model: message.model,
    effort: `${EXTRACTION_EFFORT}@${PROMPT_VERSION}`,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
};

export const retryMaxTokens = RETRY_MAX_TOKENS;

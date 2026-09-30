import { generateText, hasToolCall, stepCountIs, ToolChoiceViolationError, type LanguageModel, type ModelMessage } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import type { ModelDecision } from "./policy";
import type { ModelRequest, ModelResponse } from "./runner";

export const DEFAULT_AGENT_MODEL = "@cf/moonshotai/kimi-k2.5";
const MODEL_TIMEOUT_MS = 90_000;
const MAX_STEPS = 6;
const FINAL_TURN_MS = 25_000;

const DecisionSchema = z.object({
  decision: z.enum(["send", "draft", "skip"]),
  intent: z.string().max(60),
  grounded: z.boolean(),
  body: z.string().max(12_000),
  reason: z.string().max(500),
});

/** What the model is told when it stopped without submitting its answer. */
export const SUBMIT_NOW = "Submit your answer now by calling submit_answer, using only what you found. If nothing you found answers the question, set decision to draft and say why in reason.";

/**
 * Runs the agent on any language model. Granted tools and `submit_answer` are
 * the only tools offered; the structured decision is captured from
 * `submit_answer`, and the policy — not the model — decides what is sent.
 *
 * A model that keeps calling tools, or stops with prose, still ends with an
 * answer: the last allowed step may only call `submit_answer`, and if the run
 * still ended without one, a single extra turn is given that can do nothing
 * else (seen live 2026-09-29: two identical searches, then no answer).
 */
export async function runModel(model: LanguageModel, request: ModelRequest): Promise<ModelResponse> {
  let decision: ModelDecision | null = null;
  const submit = {
    description: "Submit the final answer and decision. Call exactly once, last.",
    inputSchema: DecisionSchema,
    execute: async (input: ModelDecision) => {
      decision = DecisionSchema.parse(input);
      return "Recorded.";
    },
  };
  const tools: Record<string, unknown> = { submit_answer: submit };
  for (const tool of request.tools) {
    if (tool.name === "submit_answer") continue;
    tools[tool.name] = tool.name === "search_knowledge"
      ? {
          description: tool.description,
          inputSchema: z.object({ query: z.string().min(2).max(300).describe("What to look for, in the words the knowledge would use") }),
          execute: async ({ query }: { query: string }) => tool.run({ query }),
        }
      : {
          description: tool.description,
          inputSchema: z.object({ arguments: z.record(z.unknown()).default({}).describe("Arguments for the tool") }),
          execute: async ({ arguments: args }: { arguments: Record<string, unknown> }) => tool.run(args ?? {}),
        };
  }
  const abortSignal = AbortSignal.timeout(MODEL_TIMEOUT_MS);
  const result = await generateText({
    model,
    system: request.system,
    prompt: request.prompt,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: tools as any,
    stopWhen: [stepCountIs(MAX_STEPS), hasToolCall("submit_answer")],
    // The last step offers submit_answer alone. Not a forced tool choice: a model that
    // ignores one throws ToolChoiceViolationError and the whole run would be lost.
    prepareStep: ({ stepNumber }) => (stepNumber >= MAX_STEPS - 1 ? { activeTools: ["submit_answer"] } : undefined),
    abortSignal,
    maxRetries: 1,
  });
  if (decision) return { decision, text: result.text };
  const messages: ModelMessage[] = [
    { role: "user", content: request.prompt },
    ...result.response.messages,
    { role: "user", content: SUBMIT_NOW },
  ];
  let lastText = "";
  try {
    const last = await generateText({
      model,
      system: request.system,
      messages,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: { submit_answer: submit } as any,
      toolChoice: { type: "tool", toolName: "submit_answer" },
      stopWhen: stepCountIs(1),
      // Its own short deadline: the first call may have used most of the 90 s.
      abortSignal: AbortSignal.timeout(FINAL_TURN_MS),
      maxRetries: 0,
    });
    lastText = last.text;
  } catch (error) {
    // Refusing the one allowed call, or running out of time for it, is "no answer";
    // whatever text the first call produced is kept for a draft.
    const aborted = (error as Error)?.name === "AbortError" || (error as Error)?.name === "TimeoutError";
    if (!ToolChoiceViolationError.isInstance(error) && !aborted) throw error;
  }
  return { decision, text: (result.text || lastText).trim() };
}

/** The agent on Workers AI (`AGENT_MODEL`, default kimi-k2.5). */
export async function workersAiModel(ai: Ai, modelName: string | undefined, request: ModelRequest): Promise<ModelResponse> {
  const workersai = createWorkersAI({ binding: ai });
  return runModel(workersai((modelName || DEFAULT_AGENT_MODEL) as Parameters<typeof workersai>[0]), request);
}

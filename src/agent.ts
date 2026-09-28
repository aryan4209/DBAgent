import OpenAI from "openai";
import type { DbTools, ToolOutcome } from "./tools.ts";
import { toolDefinitions } from "./tools.ts";

export type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface ToolCallInfo {
  id: string;
  name: string;
  input: unknown;
}

export interface AgentEvents {
  onText(delta: string): void;
  onNotice(message: string): void;
  onToolStart?(call: ToolCallInfo): void;
  onToolEnd?(call: ToolCallInfo, outcome: ToolOutcome): void;
  /** Called after each message is appended to the history, so callers can persist progress. */
  onMessage?(message: Message): void;
}

export interface AgentOptions {
  model: string;
  system: string;
  /** Safety cap on model round-trips per user question. */
  maxIterations?: number;
}

/**
 * Tool-calling loop over any OpenAI-compatible chat completions API
 * (Ollama, Groq, Gemini, OpenRouter, ...). Stateless: the caller owns the
 * conversation history, which lets one agent serve many stored chats.
 */
export class DbAgent {
  constructor(
    private readonly client: OpenAI,
    private readonly tools: DbTools,
    private readonly options: AgentOptions,
  ) {}

  /** Answers `question`, appending every new message to `history` (which excludes the system prompt). */
  async run(history: Message[], question: string, events: AgentEvents, signal?: AbortSignal): Promise<void> {
    const append = (message: Message) => {
      history.push(message);
      events.onMessage?.(message);
    };

    append({ role: "user", content: question });

    const maxIterations = this.options.maxIterations ?? 25;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const stream = this.client.chat.completions.stream(
        {
          model: this.options.model,
          messages: [{ role: "system", content: this.options.system }, ...history],
          tools: toolDefinitions,
        },
        { signal },
      );
      stream.on("content", (delta) => events.onText(delta));

      const completion = await stream.finalChatCompletion();
      const choice = completion.choices[0];
      if (!choice) {
        events.onNotice("The model returned no response.");
        return;
      }

      const message = choice.message;
      const toolCalls = (message.tool_calls ?? []).filter((c) => c.type === "function");

      append({
        role: "assistant",
        content: message.content ?? "",
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });

      if (toolCalls.length === 0) {
        if (choice.finish_reason === "length") events.onNotice("Response hit the output limit and was cut off.");
        return;
      }

      // Independent calls run concurrently; each gets its own tool message.
      const results = await Promise.all(
        toolCalls.map(async (call): Promise<Message> => {
          let outcome: ToolOutcome;
          let input: unknown;
          try {
            input = JSON.parse(call.function.arguments || "{}");
          } catch {
            input = call.function.arguments;
          }
          const info: ToolCallInfo = { id: call.id, name: call.function.name, input };
          events.onToolStart?.(info);

          if (typeof input === "string") {
            outcome = { content: `arguments were not valid JSON: ${input}`, isError: true };
          } else {
            outcome = await this.tools.execute(call.function.name, input);
          }
          events.onToolEnd?.(info, outcome);

          return {
            role: "tool",
            tool_call_id: call.id,
            content: outcome.isError ? `ERROR: ${outcome.content}` : outcome.content,
          };
        }),
      );
      results.forEach(append);

      if (signal?.aborted) return;
    }

    events.onNotice(`Stopped after ${maxIterations} steps without a final answer. Try a narrower question.`);
  }
}

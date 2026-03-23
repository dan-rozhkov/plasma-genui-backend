import type { FastifyInstance } from "fastify";
import { streamText } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});

export async function chatRoutes(app: FastifyInstance) {
  app.post("/api/chat", async (request, reply) => {
    const { messages, systemPrompt } = request.body as {
      messages: Array<{ role: string; content: string }>;
      systemPrompt?: string;
    };

    if (!systemPrompt) {
      reply.code(400).send({ error: "systemPrompt is required" });
      return;
    }

    const model = process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4";

    const abortController = new AbortController();

    // Abort LLM generation if client disconnects
    reply.raw.on("close", () => abortController.abort());

    const result = streamText({
      model: openrouter(model),
      system: systemPrompt,
      messages: messages.map((m) => ({
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
      })),
      abortSignal: abortController.signal,
    });

    reply
      .code(200)
      .header("Content-Type", "text/event-stream")
      .header("Cache-Control", "no-cache")
      .header("Connection", "keep-alive");
    // Send Fastify-managed headers (including CORS) to the client
    reply.raw.writeHead(
      200,
      reply.getHeaders() as Record<string, string | string[]>
    );
    reply.hijack();

    let isFirst = true;
    for await (const chunk of result.textStream) {
      if (abortController.signal.aborted) break;

      const data = {
        choices: [
          {
            delta: {
              content: chunk,
              ...(isFirst ? { role: "assistant" } : {}),
            },
            index: 0,
            finish_reason: null,
          },
        ],
      };
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      isFirst = false;
    }

    if (!abortController.signal.aborted) {
      const doneData = {
        choices: [{ delta: {}, index: 0, finish_reason: "stop" }],
      };
      reply.raw.write(`data: ${JSON.stringify(doneData)}\n\n`);
      reply.raw.write("data: [DONE]\n\n");
    }
    reply.raw.end();
  });
}

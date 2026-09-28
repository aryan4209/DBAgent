import OpenAI from "openai";
import readline from "node:readline/promises";
import { styleText } from "node:util";
import { DbAgent, type Message } from "./agent.ts";
import { ConfigError, buildSystemPrompt, createLlmClient, loadSettings, reloadEnvFile } from "./config.ts";
import { MssqlAdapter } from "./db/mssql/mssqlAdapter.ts";
import { DbTools } from "./tools.ts";

async function main() {
  reloadEnvFile();
  const settings = loadSettings();
  const { baseURL, model } = settings.llm;

  const db = new MssqlAdapter(settings.db);
  console.log(styleText("dim", "Connecting to SQL Server..."));
  await db.connect();
  const info = await db.serverInfo();
  console.log(styleText("green", `Connected to ${info.database} as ${info.login}`));
  console.log(styleText("dim", info.description));
  console.log(styleText("dim", `Model: ${model} via ${baseURL}`));

  if (info.writeCapabilities.length > 0) {
    console.log(
      styleText(
        "yellow",
        `\nWARNING: login '${info.login}' has write-capable roles (${info.writeCapabilities.join(", ")}).\n` +
          "The agent still blocks writes, but use a db_datareader-only login for real protection " +
          "(see sql/create-readonly-login.sql).",
      ),
    );
  }

  const agent = new DbAgent(createLlmClient(settings.llm), new DbTools(db, settings.maxRows), {
    model,
    system: buildSystemPrompt(db, info, settings.maxRows),
  });

  let history: Message[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(styleText("dim", "\nAsk a question about your data. Commands: /reset (new conversation), /exit\n"));

  try {
    while (true) {
      const line = (await rl.question(styleText("bold", "you> "))).trim();
      if (!line) continue;
      if (line === "/exit" || line === "/quit") break;
      if (line === "/reset") {
        history = [];
        console.log(styleText("dim", "Conversation cleared."));
        continue;
      }

      process.stdout.write(styleText("bold", "\nagent> "));
      try {
        await agent.run(history, line, {
          onText: (delta) => process.stdout.write(delta),
          onNotice: (msg) => console.log(styleText("yellow", `\n[${msg}]`)),
          onToolStart({ name, input }) {
            const i = (input ?? {}) as Record<string, string | undefined>;
            if (name === "run_query") {
              if (i.purpose) console.log(styleText("cyan", `\n▸ ${i.purpose}`));
              console.log(styleText("dim", i.sql ?? ""));
            } else if (name === "describe_table") {
              console.log(styleText("cyan", `\n▸ describe ${i.schema}.${i.table}`));
            } else {
              console.log(styleText("cyan", `\n▸ list tables${i.schema ? ` in ${i.schema}` : ""}${i.name_pattern ? ` like '${i.name_pattern}'` : ""}`));
            }
          },
        });
      } catch (err) {
        if (err instanceof OpenAI.APIConnectionError) {
          console.error(styleText("red", `\nCan't reach the model at ${baseURL}. Is Ollama running? (start the Ollama app or run \`ollama serve\`)`));
        } else if (err instanceof OpenAI.AuthenticationError) {
          console.error(styleText("red", "\nModel API authentication failed. For Ollama cloud models run `ollama signin`; otherwise check LLM_API_KEY."));
        } else if (err instanceof OpenAI.RateLimitError) {
          console.error(styleText("red", "\nFree-tier usage limit reached; wait a while and try again, or switch LLM_MODEL."));
        } else if (err instanceof OpenAI.NotFoundError) {
          console.error(styleText("red", `\nModel '${model}' not found. Run \`ollama pull ${model}\` or check LLM_MODEL.`));
        } else if (err instanceof OpenAI.APIError) {
          console.error(styleText("red", `\nModel API error ${err.status}: ${err.message}`));
        } else {
          console.error(styleText("red", `\nError: ${err instanceof Error ? err.message : String(err)}`));
        }
      }
      console.log("\n");
    }
  } finally {
    rl.close();
    await db.close();
  }
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    console.error(`${err.message}. Copy .env.example to .env and fill it in.`);
  } else {
    console.error(styleText("red", `Fatal: ${err instanceof Error ? err.message : String(err)}`));
  }
  process.exit(1);
});

// Manual smoke test: runs the real agent loop against the configured model with a fake database.
// Usage: npx tsx test/smoke-agent.ts
import OpenAI from "openai";
import { DbAgent, type Message } from "../src/agent.ts";
import type { DatabaseAdapter } from "../src/db/adapter.ts";
import { assertReadOnly } from "../src/db/mssql/sqlGuard.ts";
import { DbTools } from "../src/tools.ts";

const fakeDb: DatabaseAdapter = {
  dialect: "T-SQL (Microsoft SQL Server)",
  async connect() {},
  async close() {},
  async serverInfo() {
    return { description: "fake", database: "Shop", login: "reader", writeCapabilities: [] };
  },
  async listTables() {
    return { columns: ["schema", "name", "type", "approx_rows"], rows: [["dbo", "Orders", "USER_TABLE", 3]], truncated: false };
  },
  async describeTable() {
    return {
      object_type: "USER_TABLE",
      approx_rows: 3,
      columns: {
        columns: ["column_name", "data_type"],
        rows: [["OrderId", "int"], ["Customer", "nvarchar"], ["Total", "decimal"]],
        truncated: false,
      },
    };
  },
  async runReadOnlyQuery(sql) {
    assertReadOnly(sql);
    console.log(`\n[fake db ran] ${sql}`);
    return { columns: ["Customer", "Total"], rows: [["Asha", 500], ["Ravi", 300]], truncated: false };
  },
};

const tools = new DbTools(fakeDb, 200);
const agent = new DbAgent(
  new OpenAI({ baseURL: process.env.LLM_BASE_URL || "http://localhost:11434/v1", apiKey: process.env.LLM_API_KEY || "ollama" }),
  tools,
  {
    model: process.env.LLM_MODEL || "nemotron-3-ultra:cloud",
    system: "You are a read-only SQL Server data assistant. Use the tools; never guess column names.",
  },
);

const events = {
  onText: (d: string) => process.stdout.write(d),
  onNotice: (m: string) => console.log(`\n[notice] ${m}`),
  onToolStart: (c: { name: string; input: unknown }) => console.log(`\n[tool] ${c.name} ${JSON.stringify(c.input)}`),
};
const history: Message[] = [];
await agent.run(history, "Who is the top customer by total order value?", events);
console.log("\n---");
await agent.run(history, "Delete all orders for Ravi.", events);
console.log();

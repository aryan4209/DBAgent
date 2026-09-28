import type OpenAI from "openai";
import { z } from "zod";
import type { DatabaseAdapter, QueryResult } from "./db/adapter.ts";

/** Hard cap on characters sent back to the model per tool result, to protect context. */
const MAX_RESULT_CHARS = 60_000;
const MAX_CELL_CHARS = 1_000;

const ListTablesInput = z.object({
  schema: z.string().optional(),
  name_pattern: z.string().optional(),
});
const DescribeTableInput = z.object({
  schema: z.string(),
  table: z.string(),
});
const RunQueryInput = z.object({
  sql: z.string().min(1),
  purpose: z.string().optional(),
});

export const toolDefinitions: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "list_tables",
      description:
        "List user tables and views in the connected database with approximate row counts. " +
        "Use this first to discover what data exists. Optionally filter by schema and/or a SQL LIKE pattern on the name (e.g. '%order%').",
      parameters: {
        type: "object",
        properties: {
          schema: { type: "string", description: "Exact schema name, e.g. 'dbo'." },
          name_pattern: { type: "string", description: "SQL LIKE pattern for the table/view name." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "describe_table",
      description:
        "Get columns (types, nullability, identity, defaults), indexes, foreign keys (both directions) and approximate row count for one table or view. " +
        "Call this before writing a query against a table so column names and join keys are correct.",
      parameters: {
        type: "object",
        properties: {
          schema: { type: "string", description: "Schema name, e.g. 'dbo'." },
          table: { type: "string", description: "Table or view name without brackets." },
        },
        required: ["schema", "table"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_query",
      description:
        "Run ONE read-only T-SQL query (must start with SELECT or WITH) and get the rows back. " +
        "Writes, DDL, EXEC, SET, SELECT INTO, temp tables and multiple statements are rejected. " +
        "Results are capped at the configured row limit; use TOP, WHERE and aggregation to keep results small. " +
        "Give every output column a unique name.",
      parameters: {
        type: "object",
        properties: {
          sql: { type: "string", description: "A single T-SQL SELECT statement (CTEs allowed)." },
          purpose: { type: "string", description: "One short line on what this query is for; shown to the user." },
        },
        required: ["sql"],
        additionalProperties: false,
      },
    },
  },
];

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

export class DbTools {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly maxRows: number,
  ) {}

  async execute(name: string, rawInput: unknown): Promise<ToolOutcome> {
    try {
      switch (name) {
        case "list_tables": {
          const input = ListTablesInput.parse(rawInput);
          const result = await this.db.listTables({ schema: input.schema, namePattern: input.name_pattern });
          return ok(formatResult(result));
        }
        case "describe_table": {
          const input = DescribeTableInput.parse(rawInput);
          if (/^(sys|INFORMATION_SCHEMA)$/i.test(input.schema)) {
            return fail("Blocked for security: system and security objects can't be described. Only user tables and views are available.");
          }
          const info = await this.db.describeTable(input.schema, input.table);
          const formatted = Object.fromEntries(
            Object.entries(info).map(([k, v]) => [k, isQueryResult(v) ? compact(v) : v]),
          );
          return ok(clip(JSON.stringify(formatted)));
        }
        case "run_query": {
          const input = RunQueryInput.parse(rawInput);
          const result = await this.db.runReadOnlyQuery(input.sql, this.maxRows);
          return ok(formatResult(result));
        }
        default:
          return fail(`Unknown tool: ${name}`);
      }
    } catch (err) {
      if (err instanceof z.ZodError) {
        return fail(`INVALID_INPUT: ${JSON.stringify(rawInput)} — ${err.message}`);
      }
      // SQL errors go back to the model so it can fix the query and retry.
      return fail(err instanceof Error ? err.message : String(err));
    }
  }
}

function ok(content: string): ToolOutcome {
  return { content, isError: false };
}
function fail(content: string): ToolOutcome {
  return { content, isError: true };
}

function isQueryResult(v: unknown): v is QueryResult {
  return typeof v === "object" && v !== null && "columns" in v && "rows" in v;
}

function compact(result: QueryResult) {
  return {
    columns: result.columns,
    rows: result.rows.map((row) => row.map(formatCell)),
    row_count: result.rows.length,
    truncated: result.truncated,
  };
}

function formatResult(result: QueryResult): string {
  const data = compact(result);
  let json = JSON.stringify(data);
  if (json.length <= MAX_RESULT_CHARS) return json;

  // Too large: drop rows until it fits, and say so.
  let keep = data.rows.length;
  while (keep > 0 && json.length > MAX_RESULT_CHARS) {
    keep = Math.floor(keep * 0.75);
    json = JSON.stringify({ ...data, rows: data.rows.slice(0, keep), row_count: keep, truncated: true });
  }
  return json;
}

function formatCell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) {
    const hex = value.subarray(0, 32).toString("hex").toUpperCase();
    return `0x${hex}${value.length > 32 ? `… (${value.length} bytes)` : ""}`;
  }
  if (typeof value === "string" && value.length > MAX_CELL_CHARS) {
    return `${value.slice(0, MAX_CELL_CHARS)}… (${value.length} chars)`;
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

function clip(s: string): string {
  return s.length <= MAX_RESULT_CHARS ? s : `${s.slice(0, MAX_RESULT_CHARS)}… [truncated]`;
}

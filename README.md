# db-agent

An AI chat app that answers questions about a SQL Server database in plain English.
It explores the schema, writes T-SQL, runs it **read-only**, and shows you every query it ran.
It runs on free models through any OpenAI-compatible API. The default is Ollama's `nemotron-3-ultra:cloud`.

- **Web chat UI:** saved chat history in a sidebar with search, rename and delete, plus answers that stream in as they're written.
  Each step the agent takes (tables listed, tables described, queries run) appears as an expandable panel with the SQL and the result rows.
  There's a Stop button, and it has light and dark themes and works on phones.
- **Terminal chat** (`npm run cli`) for quick use from a console.

## Setup

Requirements: Node.js 22+ and SQL Server 2017+ (the schema queries use `STRING_AGG`).

```powershell
npm install
copy .env.example .env      # then fill in the values
npm start                   # web UI at http://127.0.0.1:3000
npm run cli                 # or: terminal chat
```

**Connecting from the UI:** click **Connection settings** in the sidebar. It opens automatically on first run.

- Enter the server, port, login, password and database, and set the options (encrypt, trust server certificate, read-only intent).
- **Test connection** checks the login, shows the server version and any write-capable roles, and fills the Database box with a list of databases you can pick from.
- The **connection string** updates as you type, in ADO.NET, ODBC or JDBC format. The password is masked unless you tick "Show password", and there's a Copy button.
- You can also **paste a connection string** in any of those three formats to fill in the fields.
- **Save & connect** tests the settings first and writes them to `.env` only if the connection succeeds. The saved password is never sent back to the browser.
- Alternatively, edit `.env` by hand and click **Retry**; you don't need to restart.

Chats are saved as JSON files in `data/chats/`, one file per chat. They keep the full conversation, so a follow-up question has all the earlier context.
Deleting a chat in the UI deletes its file.

The server listens on `127.0.0.1` only, because anyone who can open the page can query your database.
`HOST` and `PORT` can be overridden, but don't expose it on a network without adding authentication.

**AI model:** install [Ollama](https://ollama.com) and keep it running. Run `ollama signin` once so you can use the free cloud models.
To use a different free model, change `LLM_BASE_URL`, `LLM_MODEL` and `LLM_API_KEY` in `.env`:

| Option | Settings | Where your data goes |
|---|---|---|
| Ollama cloud (default) | `LLM_MODEL=nemotron-3-ultra:cloud` | Ollama's servers (free tier has usage limits) |
| Ollama local | `LLM_MODEL=qwen3:4b` (run `ollama pull qwen3:4b` first) | Stays on this PC. Slower, and weaker on complex SQL. |
| Groq | `LLM_BASE_URL=https://api.groq.com/openai/v1`, `LLM_MODEL=llama-3.3-70b-versatile`, free key | Groq |
| Gemini | `LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/`, `LLM_MODEL=gemini-2.5-flash`, free key | Google (free-tier data may be used for training) |

The model must support tool calling. To check an Ollama model, run `ollama show <model>` and look for `tools` under Capabilities.

**Database login:** run [sql/create-readonly-login.sql](sql/create-readonly-login.sql) to create a login that
has only `db_datareader` and `VIEW DEFINITION`. The agent prints a warning at startup if its login has
write-capable roles (`sysadmin`, `db_owner`, `db_datawriter`, `db_ddladmin`).

Terminal chat commands: `/reset` starts a new conversation, and `/exit` quits.

## How read-only is enforced

The agent has three independent layers of protection:

1. **Permissions (primary layer).** The login has `db_datareader` only. Use `DENY` to hide sensitive tables or columns.
2. **SQL guard.** [src/db/mssql/sqlGuard.ts](src/db/mssql/sqlGuard.ts) accepts one `SELECT` or `WITH` statement and nothing else.
   Before checking, it strips comments, string literals and quoted identifiers, so keywords that appear inside them are ignored.
   It rejects DML, DDL, `EXEC`, `SET`, `SELECT INTO`, `WAITFOR`, `OPENROWSET`, `sp_`/`xp_` procedures, multiple statements, and so on.
   It fails closed. If a legitimate column is named after a keyword, the error tells the model to wrap the name in `[brackets]`.
3. **Always-rollback transaction.** Every query runs inside a transaction that is rolled back afterwards.

Every result has limits:

- A row cap (`AGENT_MAX_ROWS`, enforced on the server via `SET ROWCOUNT`).
- A per-query timeout (`AGENT_QUERY_TIMEOUT_MS`).
- A character cap on what is sent back to the model.

`MSSQL_READONLY_INTENT=true` sets `ApplicationIntent=ReadOnly`, which routes the agent to a readable Availability Group secondary when one exists.

## Tools the agent has

| Tool | What it does |
|---|---|
| `list_tables` | Lists user tables and views with approximate row counts. Can filter by schema or name pattern. |
| `describe_table` | Shows columns, types, identity and default values, indexes, foreign keys in both directions, and the approximate row count. |
| `run_query` | Runs one guarded, read-only `SELECT` and returns the rows. |

## Project layout

```
src/
  server.ts                Web UI entry point (npm start)
  webApp.ts                HTTP server: REST API for chats, streaming answers (SSE), static files
  chatStore.ts             Saves chats as JSON files in data/chats/
  cli.ts                   Terminal chat (npm run cli)
  config.ts                .env loading, settings, system prompt
  agent.ts                 Tool-calling loop for OpenAI-compatible APIs (streaming, parallel tool calls)
  tools.ts                 Tool schemas, input validation, result formatting
  db/adapter.ts            DatabaseAdapter interface (engine-agnostic)
  db/mssql/mssqlAdapter.ts SQL Server implementation
  db/mssql/sqlGuard.ts     Read-only T-SQL validator
public/                    Chat UI (index.html, app.css, app.js)
sql/create-readonly-login.sql
test/sqlGuard.test.ts
test/smoke-agent.ts        Runs the agent against the configured model with a fake database
```

## Adding another database engine

To add another engine, implement `DatabaseAdapter` (for example `src/db/postgres/postgresAdapter.ts`) along with its own read-only guard, then pick the adapter in `webApp.ts` (`createDb`) and `cli.ts`.
The agent and tools don't change.

## Development

```powershell
npm test          # SQL guard tests
npm run typecheck
npx tsx test/smoke-agent.ts   # checks the model and tool calling without a database
```

## Notes

- Query results are sent to the model provider, except with a local Ollama model. Use `DENY` on columns that must not leave the server.
- Windows (integrated) authentication isn't supported yet. It needs the `msnodesqlv8` driver.

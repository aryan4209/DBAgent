import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import OpenAI from "openai";
import { DbAgent } from "./agent.ts";
import { ChatStore } from "./chatStore.ts";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  ConfigError,
  buildSystemPrompt,
  createLlmClient,
  loadSettings,
  reloadEnvFile,
  writeEnvValues,
  type Settings,
} from "./config.ts";
import type { DatabaseAdapter, ServerInfo } from "./db/adapter.ts";
import { MssqlAdapter } from "./db/mssql/mssqlAdapter.ts";
import { DbTools } from "./tools.ts";

/** Project root, so the app works no matter which directory it's started from. */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");

export interface ServerOptions {
  // Localhost only by default: anyone who can reach this server can query the database.
  host?: string;
  port?: number;
  dataDir?: string;
  /** .env file re-read on each connection attempt; null to skip. */
  envFile?: string | null;
  createDb?: (settings: Settings) => DatabaseAdapter;
}

let opts: Required<ServerOptions>;
let store: ChatStore;

// ---------- Database + agent lifecycle ----------

interface Ready {
  settings: Settings;
  db: DatabaseAdapter;
  info: ServerInfo;
  agent: DbAgent;
}

let ready: Ready | null = null;
let connecting: Promise<Ready> | null = null;
let lastError: string | null = null;

/** Connects on first use; re-reads .env each attempt so fixed credentials work without a restart. */
function ensureReady(): Promise<Ready> {
  if (ready) return Promise.resolve(ready);
  if (connecting) return connecting;
  const attempt = (async () => {
    try {
      if (opts.envFile) reloadEnvFile(opts.envFile);
      const settings = loadSettings();
      const db = opts.createDb(settings);
      await db.connect();
      try {
        const info = await db.serverInfo();
        const agent = new DbAgent(createLlmClient(settings.llm), new DbTools(db, settings.maxRows), {
          model: settings.llm.model,
          system: buildSystemPrompt(db, info, settings.maxRows),
        });
        ready = { settings, db, info, agent };
        lastError = null;
        return ready;
      } catch (err) {
        await db.close().catch(() => {});
        throw err;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  })();
  // Clear the flag once settled. Done here, not in a finally inside the async
  // function: a synchronous failure (e.g. missing settings) would run that
  // finally before `connecting` was even assigned, leaving it stuck.
  connecting = attempt;
  attempt.then(
    () => { if (connecting === attempt) connecting = null; },
    () => { if (connecting === attempt) connecting = null; },
  );
  return attempt;
}

async function reconnect(): Promise<void> {
  const old = ready;
  ready = null;
  await old?.db.close().catch(() => {});
  await ensureReady().catch(() => {});
}

// ---------- Connection settings (dialog in the UI) ----------

const ConnectionInput = z.object({
  server: z.string().trim().min(1, "Server is required"),
  port: z.coerce.number().int().min(1).max(65535),
  database: z.string().trim(),
  user: z.string().trim().min(1, "Login is required"),
  /** Empty or missing = keep the saved password. */
  password: z.string().optional(),
  encrypt: z.boolean(),
  trustServerCertificate: z.boolean(),
  readOnlyIntent: z.boolean(),
  requestTimeoutMs: z.coerce.number().int().min(1000).max(600_000),
  maxRows: z.coerce.number().int().min(1).max(10_000),
});
type ConnectionInput = z.infer<typeof ConnectionInput>;

const envBool = (name: string, fallback: boolean) =>
  (process.env[name] || String(fallback)).toLowerCase() === "true";

/** Current settings for the dialog. The password itself never leaves the server. */
function currentConnection() {
  if (opts.envFile) reloadEnvFile(opts.envFile);
  const e = process.env;
  return {
    server: e.MSSQL_SERVER || "localhost",
    port: Number(e.MSSQL_PORT || 1433),
    database: e.MSSQL_DATABASE || "",
    user: e.MSSQL_USER || "",
    hasPassword: Boolean(e.MSSQL_PASSWORD),
    encrypt: envBool("MSSQL_ENCRYPT", true),
    trustServerCertificate: envBool("MSSQL_TRUST_SERVER_CERT", false),
    readOnlyIntent: envBool("MSSQL_READONLY_INTENT", false),
    requestTimeoutMs: Number(e.AGENT_QUERY_TIMEOUT_MS || 30_000),
    maxRows: Number(e.AGENT_MAX_ROWS || 200),
    canSave: Boolean(opts.envFile),
  };
}

function settingsFrom(input: ConnectionInput): Settings {
  return {
    db: {
      server: input.server,
      port: input.port,
      database: input.database,
      user: input.user,
      password: input.password || process.env.MSSQL_PASSWORD || "",
      encrypt: input.encrypt,
      trustServerCertificate: input.trustServerCertificate,
      readOnlyIntent: input.readOnlyIntent,
      requestTimeoutMs: input.requestTimeoutMs,
    },
    llm: {
      baseURL: process.env.LLM_BASE_URL || "http://localhost:11434/v1",
      model: process.env.LLM_MODEL || "nemotron-3-ultra:cloud",
      apiKey: process.env.LLM_API_KEY || "ollama",
    },
    maxRows: input.maxRows,
  };
}

/** Opens a throwaway connection with the given settings and reports what it finds. */
async function testConnection(settings: Settings) {
  if (!settings.db.password) throw new ConfigError("Password is required");
  const db = opts.createDb(settings);
  try {
    await db.connect();
    const info = await db.serverInfo();
    const databases = (await db.listDatabases?.()) ?? [];
    return { ...info, databases };
  } finally {
    await db.close().catch(() => {});
  }
}

async function handleConnection(pathname: string, req: http.IncomingMessage, res: http.ServerResponse) {
  if (pathname === "/api/connection" && req.method === "GET") return sendJson(res, 200, currentConnection());

  const parsed = ConnectionInput.safeParse(await readJson(req));
  if (!parsed.success) return sendJson(res, 400, { error: parsed.error.issues.map((i) => i.message).join("; ") });
  const input = parsed.data;
  const settings = settingsFrom(input);

  if (pathname === "/api/connection/test") {
    try {
      return sendJson(res, 200, { ok: true, ...(await testConnection(settings)) });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Save & connect: only write .env once the settings are proven to work.
  if (!opts.envFile) return sendJson(res, 400, { error: "Saving is disabled: no .env file configured." });
  if (!input.database) return sendJson(res, 400, { error: "Choose a database before saving." });
  try {
    await testConnection(settings);
  } catch (err) {
    return sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
  const values: Record<string, string> = {
    MSSQL_SERVER: input.server,
    MSSQL_PORT: String(input.port),
    MSSQL_DATABASE: input.database,
    MSSQL_USER: input.user,
    MSSQL_ENCRYPT: String(input.encrypt),
    MSSQL_TRUST_SERVER_CERT: String(input.trustServerCertificate),
    MSSQL_READONLY_INTENT: String(input.readOnlyIntent),
    AGENT_QUERY_TIMEOUT_MS: String(input.requestTimeoutMs),
    AGENT_MAX_ROWS: String(input.maxRows),
  };
  if (input.password) values.MSSQL_PASSWORD = input.password;
  try {
    writeEnvValues(opts.envFile, values);
  } catch (err) {
    return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
  await reconnect();
  return sendJson(res, 200, { ok: ready !== null, error: ready ? null : lastError, status: statusPayload() });
}

function statusPayload() {
  let model = process.env.LLM_MODEL || "nemotron-3-ultra:cloud";
  if (ready) model = ready.settings.llm.model;
  return {
    connected: ready !== null,
    connecting: connecting !== null,
    error: lastError,
    model,
    maxRows: ready?.settings.maxRows ?? null,
    server: ready?.info.description ?? null,
    database: ready?.info.database ?? null,
    login: ready?.info.login ?? null,
    writeCapabilities: ready?.info.writeCapabilities ?? [],
  };
}

// ---------- HTTP helpers ----------

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return typeof parsed === "object" && parsed !== null ? parsed : {};
}

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

// Third-party browser scripts served straight from node_modules (no CDN needed).
const VENDOR: Record<string, string> = {
  "/vendor/marked.js": "node_modules/marked/lib/marked.umd.js",
  "/vendor/purify.js": "node_modules/dompurify/dist/purify.min.js",
};

async function serveStatic(pathname: string, res: http.ServerResponse): Promise<void> {
  let file: string;
  if (VENDOR[pathname]) {
    file = path.join(ROOT, VENDOR[pathname]);
  } else {
    file = path.resolve(PUBLIC_DIR, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: "Not found" });
  }
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, {
      "Content-Type": STATIC_TYPES[path.extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

// ---------- Chat streaming ----------

const busyChats = new Set<string>();

async function streamAnswer(chatId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJson(req);
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) return sendJson(res, 400, { error: "Message is empty" });

  const chat = await store.get(chatId);
  if (!chat) return sendJson(res, 404, { error: "Chat not found" });
  if (busyChats.has(chatId)) return sendJson(res, 409, { error: "This chat is already answering a question" });

  let r: Ready;
  try {
    r = await ensureReady();
  } catch {
    return sendJson(res, 503, { error: `Not connected to the database: ${lastError}` });
  }

  busyChats.add(chatId);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event: string, data: unknown) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Browser pressed Stop or closed the tab: abort the model request.
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  // Persist after every message so a crash or Stop keeps what was already done.
  let saving = Promise.resolve();
  const persist = () => {
    saving = saving.then(() => store.save(chat)).catch((err) => console.error("Failed to save chat:", err));
  };

  try {
    await r.agent.run(
      chat.messages,
      content,
      {
        onText: (delta) => send("text", { delta }),
        onNotice: (message) => send("notice", { message }),
        onToolStart: (call) => send("tool_start", call),
        onToolEnd: (call, outcome) => send("tool_end", { id: call.id, content: outcome.content, isError: outcome.isError }),
        onMessage: persist,
      },
      controller.signal,
    );
  } catch (err) {
    if (!controller.signal.aborted) send("error", { message: describeError(err, r.settings) });
  } finally {
    await saving;
    busyChats.delete(chatId);
    send("done", { title: chat.title });
    res.end();
  }
}

function describeError(err: unknown, settings: Settings): string {
  const { baseURL, model } = settings.llm;
  if (err instanceof OpenAI.APIConnectionError) return `Can't reach the model at ${baseURL}. Is Ollama running?`;
  if (err instanceof OpenAI.AuthenticationError) return "Model API authentication failed. For Ollama cloud models run `ollama signin`; otherwise check LLM_API_KEY.";
  if (err instanceof OpenAI.RateLimitError) return "Free-tier usage limit reached. Wait a while or switch LLM_MODEL.";
  if (err instanceof OpenAI.NotFoundError) return `Model '${model}' not found. Run \`ollama pull ${model}\` or check LLM_MODEL.`;
  if (err instanceof OpenAI.APIError) return `Model API error ${err.status}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

// ---------- Routes ----------

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const { pathname } = url;
  const method = req.method ?? "GET";

  if (!pathname.startsWith("/api/")) {
    if (method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
    return serveStatic(pathname, res);
  }

  if (pathname === "/api/status" && method === "GET") return sendJson(res, 200, statusPayload());
  if (pathname === "/api/reconnect" && method === "POST") {
    await reconnect();
    return sendJson(res, 200, statusPayload());
  }

  if (
    (pathname === "/api/connection" && (method === "GET" || method === "PUT")) ||
    (pathname === "/api/connection/test" && method === "POST")
  ) {
    return handleConnection(pathname, req, res);
  }

  if (pathname === "/api/chats") {
    if (method === "GET") return sendJson(res, 200, await store.list());
    if (method === "POST") return sendJson(res, 201, await store.create());
  }

  const match = pathname.match(/^\/api\/chats\/([0-9a-f-]{36})(\/messages)?$/);
  if (match) {
    const [, id, messages] = match;
    if (messages && method === "POST") return streamAnswer(id, req, res);
    if (!messages && method === "GET") {
      const chat = await store.get(id);
      return chat ? sendJson(res, 200, chat) : sendJson(res, 404, { error: "Chat not found" });
    }
    if (!messages && method === "PATCH") {
      const body = await readJson(req);
      const chat = await store.rename(id, String(body.title ?? ""));
      return chat ? sendJson(res, 200, chat) : sendJson(res, 404, { error: "Chat not found" });
    }
    if (!messages && method === "DELETE") {
      if (busyChats.has(id)) return sendJson(res, 409, { error: "Chat is busy" });
      return (await store.delete(id)) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: "Chat not found" });
    }
  }

  sendJson(res, 404, { error: "Not found" });
}

export async function startServer(options: ServerOptions = {}): Promise<http.Server> {
  opts = {
    host: options.host ?? (process.env.HOST || "127.0.0.1"),
    port: options.port ?? Number(process.env.PORT || 3000),
    dataDir: options.dataDir ?? path.join(ROOT, "data"),
    envFile: options.envFile === undefined ? path.join(ROOT, ".env") : options.envFile,
    createDb: options.createDb ?? ((settings) => new MssqlAdapter(settings.db)),
  };
  store = new ChatStore(path.join(opts.dataDir, "chats"));
  await store.init();

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: err instanceof Error ? err.message : "Server error" });
      else res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port, opts.host, resolve));
  console.log(`DB Agent UI running at http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${opts.port}`);
  ensureReady()
    .then((r) => console.log(`Connected to ${r.info.database} as ${r.info.login}; model ${r.settings.llm.model}`))
    .catch(() => console.log(`Database not connected yet: ${lastError}\nFix .env, then click "Retry connection" in the UI.`));

  server.on("close", () => {
    ready?.db.close().catch(() => {});
  });
  return server;
}

/**
 * Everything the agent needs from a database. Add a new engine (PostgreSQL,
 * MySQL, ...) by implementing this interface; the agent and tools don't change.
 */

export type Row = unknown[];

export interface QueryResult {
  columns: string[];
  rows: Row[];
  /** True when more rows existed than were returned. */
  truncated: boolean;
}

export interface ServerInfo {
  /** Human-readable engine + version, shown to the model. */
  description: string;
  database: string;
  login: string;
  /** Roles/permissions that let this login write. Empty means read-only as intended. */
  writeCapabilities: string[];
}

export interface DatabaseAdapter {
  /** SQL dialect name the model should write, e.g. "T-SQL (Microsoft SQL Server)". */
  readonly dialect: string;

  connect(): Promise<void>;
  close(): Promise<void>;

  serverInfo(): Promise<ServerInfo>;

  /** Databases this login can access (used by the connection dialog). Optional per engine. */
  listDatabases?(): Promise<string[]>;

  /** Tables and views, optionally filtered by schema and a LIKE pattern on the name. */
  listTables(filter: { schema?: string; namePattern?: string }): Promise<QueryResult>;

  /** Columns, keys, indexes and approximate row count for one table or view. */
  describeTable(schema: string, table: string): Promise<Record<string, QueryResult | string | number | null>>;

  /**
   * Validates that `sql` is read-only, runs it, and returns at most `maxRows` rows.
   * Must throw (not run the query) if validation fails.
   */
  runReadOnlyQuery(sql: string, maxRows: number): Promise<QueryResult>;
}

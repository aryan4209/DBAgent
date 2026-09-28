import sql from "mssql";
import type { DatabaseAdapter, QueryResult, ServerInfo } from "../adapter.ts";
import { assertReadOnly } from "./sqlGuard.ts";

export interface MssqlSettings {
  server: string;
  port: number;
  database: string;
  user: string;
  password: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
  readOnlyIntent: boolean;
  requestTimeoutMs: number;
}

export class MssqlAdapter implements DatabaseAdapter {
  readonly dialect = "T-SQL (Microsoft SQL Server)";
  private pool?: sql.ConnectionPool;

  constructor(private readonly settings: MssqlSettings) {}

  async connect(): Promise<void> {
    const s = this.settings;
    this.pool = await new sql.ConnectionPool({
      server: s.server,
      port: s.port,
      // Blank database = the login's default database (used when testing a connection).
      database: s.database || undefined,
      user: s.user,
      password: s.password,
      requestTimeout: s.requestTimeoutMs,
      pool: { max: 5, min: 0, idleTimeoutMillis: 30_000 },
      options: {
        encrypt: s.encrypt,
        trustServerCertificate: s.trustServerCertificate,
        readOnlyIntent: s.readOnlyIntent,
        appName: "db-agent",
      },
    }).connect();
  }

  async close(): Promise<void> {
    await this.pool?.close();
  }

  private request(): sql.Request {
    if (!this.pool) throw new Error("Not connected. Call connect() first.");
    return this.pool.request();
  }

  async serverInfo(): Promise<ServerInfo> {
    const result = await this.request().query(`
      SELECT
        @@VERSION                         AS version,
        DB_NAME()                         AS database_name,
        SUSER_SNAME()                     AS login_name,
        IS_SRVROLEMEMBER('sysadmin')      AS is_sysadmin,
        IS_ROLEMEMBER('db_owner')         AS is_db_owner,
        IS_ROLEMEMBER('db_datawriter')    AS is_datawriter,
        IS_ROLEMEMBER('db_ddladmin')      AS is_ddladmin;
    `);
    const r = result.recordset[0];
    const writeCapabilities = [
      r.is_sysadmin === 1 && "sysadmin",
      r.is_db_owner === 1 && "db_owner",
      r.is_datawriter === 1 && "db_datawriter",
      r.is_ddladmin === 1 && "db_ddladmin",
    ].filter((x): x is string => typeof x === "string");

    return {
      description: String(r.version).split("\n")[0].trim(),
      database: r.database_name,
      login: r.login_name,
      writeCapabilities,
    };
  }

  async listDatabases(): Promise<string[]> {
    const result = await this.request().query(`
      SELECT name FROM sys.databases
      WHERE database_id > 4 AND state_desc = 'ONLINE' AND HAS_DBACCESS(name) = 1
      ORDER BY name;
    `);
    return result.recordset.map((r: { name: string }) => r.name);
  }

  async listTables(filter: { schema?: string; namePattern?: string }): Promise<QueryResult> {
    const req = this.request();
    req.input("schema", sql.NVarChar(128), filter.schema ?? null);
    req.input("pattern", sql.NVarChar(256), filter.namePattern ?? null);
    const result = await req.query(`
      SELECT TOP (501)
        s.name      AS [schema],
        o.name      AS [name],
        o.type_desc AS [type],
        (SELECT SUM(p.rows) FROM sys.partitions p
          WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)) AS approx_rows
      FROM sys.objects o
      JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE o.type IN ('U', 'V')
        AND o.is_ms_shipped = 0
        AND (@schema IS NULL OR s.name = @schema)
        AND (@pattern IS NULL OR o.name LIKE @pattern)
      ORDER BY s.name, o.name;
    `);
    return toQueryResult(result.recordset, 500);
  }

  async describeTable(schema: string, table: string) {
    const req = this.request();
    req.input("schema", sql.NVarChar(128), schema);
    req.input("table", sql.NVarChar(128), table);
    const result = await req.query(`
      DECLARE @oid INT = OBJECT_ID(QUOTENAME(@schema) + '.' + QUOTENAME(@table));

      SELECT type_desc,
        (SELECT SUM(p.rows) FROM sys.partitions p
          WHERE p.object_id = @oid AND p.index_id IN (0, 1)) AS approx_rows
      FROM sys.objects WHERE object_id = @oid;

      SELECT
        c.name                  AS column_name,
        TYPE_NAME(c.user_type_id) AS data_type,
        CASE
          WHEN TYPE_NAME(c.user_type_id) IN ('nvarchar', 'nchar')
            THEN IIF(c.max_length = -1, 'max', CAST(c.max_length / 2 AS VARCHAR(10)))
          WHEN TYPE_NAME(c.user_type_id) IN ('varchar', 'char', 'varbinary', 'binary')
            THEN IIF(c.max_length = -1, 'max', CAST(c.max_length AS VARCHAR(10)))
          WHEN TYPE_NAME(c.user_type_id) IN ('decimal', 'numeric')
            THEN CONCAT(c.precision, ',', c.scale)
        END                     AS size,
        c.is_nullable,
        c.is_identity,
        c.is_computed,
        dc.definition           AS default_value
      FROM sys.columns c
      LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
      WHERE c.object_id = @oid
      ORDER BY c.column_id;

      SELECT
        i.name AS index_name,
        i.type_desc,
        i.is_primary_key,
        i.is_unique,
        STRING_AGG(IIF(ic.is_included_column = 0, c.name, NULL), ', ')
          WITHIN GROUP (ORDER BY ic.key_ordinal) AS key_columns,
        STRING_AGG(IIF(ic.is_included_column = 1, c.name, NULL), ', ') AS included_columns
      FROM sys.indexes i
      JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
      JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
      WHERE i.object_id = @oid AND i.type > 0
      GROUP BY i.name, i.type_desc, i.is_primary_key, i.is_unique;

      SELECT
        fk.name AS fk_name,
        OBJECT_SCHEMA_NAME(fk.parent_object_id) + '.' + OBJECT_NAME(fk.parent_object_id) AS from_table,
        STRING_AGG(pc.name, ', ') WITHIN GROUP (ORDER BY fkc.constraint_column_id) AS from_columns,
        OBJECT_SCHEMA_NAME(fk.referenced_object_id) + '.' + OBJECT_NAME(fk.referenced_object_id) AS to_table,
        STRING_AGG(rc.name, ', ') WITHIN GROUP (ORDER BY fkc.constraint_column_id) AS to_columns
      FROM sys.foreign_keys fk
      JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
      JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
      JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
      WHERE fk.parent_object_id = @oid OR fk.referenced_object_id = @oid
      GROUP BY fk.name, fk.parent_object_id, fk.referenced_object_id;
    `);

    const [objects, columns, indexes, foreignKeys] = result.recordsets as unknown as sql.IRecordSet<any>[];
    if (objects.length === 0) {
      throw new Error(`Table or view ${schema}.${table} was not found (or this login cannot see it).`);
    }
    return {
      object_type: objects[0].type_desc as string,
      approx_rows: (objects[0].approx_rows as number | null) ?? null,
      columns: toQueryResult(columns),
      indexes: toQueryResult(indexes),
      foreign_keys: toQueryResult(foreignKeys),
    };
  }

  async runReadOnlyQuery(query: string, maxRows: number): Promise<QueryResult> {
    const safeQuery = assertReadOnly(query);
    if (!this.pool) throw new Error("Not connected. Call connect() first.");

    // Belt and braces: even if something slipped past the guard and the login
    // could write, the transaction is always rolled back.
    const tx = new sql.Transaction(this.pool);
    await tx.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
    try {
      // SET ROWCOUNT stops the server after maxRows + 1 rows, so huge tables
      // aren't streamed to the client just to be thrown away.
      const result = await new sql.Request(tx).query(`SET ROWCOUNT ${maxRows + 1};\n${safeQuery}\n`);
      return toQueryResult(result.recordset ?? [], maxRows);
    } finally {
      // SET ROWCOUNT is session-scoped; reset it before the connection goes back to the pool.
      await new sql.Request(tx).batch("SET ROWCOUNT 0;").catch(() => {});
      await tx.rollback().catch(() => {});
    }
  }
}

function toQueryResult(recordset: sql.IRecordSet<any> | any[], maxRows = Infinity): QueryResult {
  const columns =
    "columns" in recordset && recordset.columns
      ? Object.values(recordset.columns)
          .sort((a, b) => a.index - b.index)
          .map((c) => c.name)
      : Object.keys(recordset[0] ?? {});
  const truncated = recordset.length > maxRows;
  const rows = recordset.slice(0, maxRows).map((r: Record<string, unknown>) => columns.map((c) => r[c]));
  return { columns, rows, truncated };
}

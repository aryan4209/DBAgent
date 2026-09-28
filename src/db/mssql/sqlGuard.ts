/**
 * Read-only guard for T-SQL written by the model.
 *
 * This is one layer of defense, not the only one. The real guarantee is a
 * login that only has db_datareader (see sql/create-readonly-login.sql);
 * queries also run inside a transaction that is always rolled back.
 * The guard fails closed: anything it can't prove is a single SELECT is rejected.
 */

export class SqlGuardError extends Error {}

const ALLOWED_FIRST_KEYWORDS = new Set(["SELECT", "WITH"]);

// Any of these as a bare word (outside strings/comments/quoted identifiers) rejects the query.
const BLOCKED_KEYWORDS = [
  // DML / DDL
  "INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE", "DROP", "ALTER", "CREATE",
  "INTO", "UPDATETEXT", "WRITETEXT",
  // Security
  "GRANT", "REVOKE", "DENY",
  // Procedural / session / transaction control
  "EXEC", "EXECUTE", "SET", "USE", "GO", "BEGIN", "COMMIT", "ROLLBACK", "SAVE",
  "WAITFOR",
  // Server administration
  "BACKUP", "RESTORE", "DBCC", "SHUTDOWN", "KILL", "RECONFIGURE", "CHECKPOINT",
  // External data access
  "BULK", "OPENROWSET", "OPENQUERY", "OPENDATASOURCE",
];

const BLOCKED_PATTERNS: Array<[RegExp, string]> = [
  [/\b(sp|xp)_\w+/i, "system/extended stored procedures"],
  [/\bNEXT\s+VALUE\s+FOR\b/i, "NEXT VALUE FOR (advances a sequence)"],
];

const BLOCKED_RE = new RegExp(`\\b(${BLOCKED_KEYWORDS.join("|")})\\b`, "i");

// ---- Confidentiality: the agent may only read data and schema of the connected database ----

const SENSITIVE_LABEL = "logins, passwords, permissions, server settings or other databases";

// Checked against the query with [bracketed] / "quoted" identifiers unwrapped, so brackets can't hide a name.
const SENSITIVE_PATTERNS: RegExp[] = [
  // Security, server-level and cross-database catalog views / DMVs (these require the sys. prefix).
  /\bsys\s*\.\s*(sql_logins|server_\w+|credentials|database_credentials|database_scoped_credentials|database_principals|database_role_members|database_permissions|linked_logins|remote_logins|servers|databases|master_files|login_token|user_token|symmetric_keys|asymmetric_keys|certificates|master_key_passwords|key_encryptions|crypt_properties|column_master_keys|column_encryption_keys|dm_\w+|fn_\w+|syslogins|sysdatabases|sysusers|sysprocesses)\b/i,
  // Compatibility views and system functions that work without the sys. prefix.
  /\b(syslogins|sysxlogins|sysdatabases|sysaltfiles|sysusers|sysmembers|sysprotects|sysremotelogins|sysservers|sysoledbusers|sysprocesses|fn_my_permissions|fn_builtin_permissions|fn_get_audit_file|fn_dblog|fn_dump_dblog|fn_trace_gettable|fn_virtualfilestats)\b/i,
  // Login / security / server functions.
  /\b(LOGINPROPERTY|PWDCOMPARE|PWDENCRYPT|HAS_DBACCESS|HAS_PERMS_BY_NAME|IS_SRVROLEMEMBER|IS_MEMBER|IS_ROLEMEMBER|SUSER_SNAME|SUSER_NAME|SUSER_ID|SUSER_SID|ORIGINAL_LOGIN|SYSTEM_USER|DB_NAME|DB_ID|SERVERPROPERTY|CONNECTIONPROPERTY|CERTENCODED|DECRYPTBY\w*)\b/i,
  /@@(SERVERNAME|SERVICENAME|SPID)\b/i,
];

// A name with 3+ parts (db.schema.object or server.db.schema.object) reaches outside the connected database.
const ID = String.raw`(?:[A-Za-z_#][\w@#$]*|\[q\]|"q")`;
const MULTIPART_RE = new RegExp(String.raw`${ID}\s*\.\s*(?:${ID})?\s*\.\s*(${ID})(\s*\()?`, "g");
// ...except XML / spatial method calls on a column, e.g. t.XmlCol.value('...', 'int').
const METHOD_RE = /^(value|query|exist|nodes|ST\w*|ToString|Get\w+|Is\w+)$/i;

/**
 * Replaces comments, string literals and quoted identifiers with inert
 * placeholders so keyword checks only see real SQL tokens. With
 * keepIdentifiers, quoted identifiers are unwrapped to their names instead.
 */
export function neutralize(sql: string, { keepIdentifiers = false } = {}): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];

    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      out += " ";
    } else if (c === "/" && next === "*") {
      // T-SQL block comments nest.
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      if (depth > 0) throw new SqlGuardError("Unterminated block comment.");
      out += " ";
    } else if (c === "'") {
      i = skipQuoted(sql, i, "'");
      out += "''";
    } else if (c === "[" || c === '"') {
      const start = i;
      i = skipQuoted(sql, i, c === "[" ? "]" : '"');
      if (keepIdentifiers) out += ` ${sql.slice(start + 1, i - 1)} `;
      else out += c === "[" ? "[q]" : '"q"';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Returns the index just past the closing delimiter; a doubled delimiter is an escape. */
function skipQuoted(sql: string, start: number, close: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === close) {
      if (sql[i + 1] === close) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  throw new SqlGuardError("Unterminated string literal or quoted identifier.");
}

/**
 * Throws SqlGuardError unless `sql` is a single read-only SELECT (optionally
 * with CTEs). Returns the query with surrounding whitespace and trailing
 * semicolons removed, ready to execute.
 */
export function assertReadOnly(sql: string): string {
  const trimmed = sql.trim().replace(/;+\s*$/, "").trim();
  const code = neutralize(trimmed).trim();

  if (code.length === 0) throw new SqlGuardError("Query is empty.");

  if (code.includes(";")) {
    throw new SqlGuardError("Only a single statement is allowed (found ';').");
  }

  const first = code.match(/^[A-Za-z]+/)?.[0]?.toUpperCase();
  if (!first || !ALLOWED_FIRST_KEYWORDS.has(first)) {
    throw new SqlGuardError("Read-only mode: the query must start with SELECT or WITH.");
  }

  const blocked = code.match(BLOCKED_RE);
  if (blocked) {
    throw new SqlGuardError(
      `Read-only mode: '${blocked[1].toUpperCase()}' is not allowed. ` +
        "If it is a column or table name, wrap it in [brackets].",
    );
  }

  for (const [pattern, label] of BLOCKED_PATTERNS) {
    if (pattern.test(code)) throw new SqlGuardError(`Read-only mode: ${label} are not allowed.`);
  }

  for (const m of code.matchAll(MULTIPART_RE)) {
    const isMethodCall = Boolean(m[2]) && METHOD_RE.test(m[1]);
    if (!isMethodCall) {
      throw new SqlGuardError(
        "Blocked for security: only the connected database can be queried, so three-part names " +
          "(database.schema.table) are not allowed. Use schema.table, and table aliases for columns.",
      );
    }
  }

  const names = neutralize(trimmed, { keepIdentifiers: true });
  if (SENSITIVE_PATTERNS.some((p) => p.test(names))) {
    throw new SqlGuardError(
      `Blocked for security: queries can't read ${SENSITIVE_LABEL}. ` +
        "Only the data and schema of the connected database are available. Tell the user this information can't be shared.",
    );
  }

  return trimmed;
}

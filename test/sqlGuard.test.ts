import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SqlGuardError, assertReadOnly } from "../src/db/mssql/sqlGuard.ts";

describe("confidentiality: allowed queries on the connected database", () => {
  const allowed = [
    "SELECT o.OrderId, o.Total FROM dbo.Orders o",
    "SELECT name, type_desc FROM sys.objects WHERE type = 'U'",
    "SELECT t.name, c.name FROM sys.tables t JOIN sys.columns c ON c.object_id = t.object_id",
    "SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'Orders'",
    "SELECT d.XmlData.value('(/root/id)[1]', 'int') AS id FROM dbo.Docs d",
    "SELECT * FROM dbo.Servers",
    "SELECT Password FROM dbo.Users WHERE 1 = 0", // user tables are the user's data; row-level policy is up to DB permissions
    "SELECT 'sys.sql_logins' AS just_text",
  ];
  for (const sql of allowed) {
    it(sql, () => assert.doesNotThrow(() => assertReadOnly(sql)));
  }
});

describe("confidentiality: blocked", () => {
  const blocked = [
    // other databases / linked servers
    "SELECT * FROM otherdb.dbo.Customers",
    "SELECT * FROM [otherdb].[dbo].[Customers]",
    "SELECT * FROM otherdb..Customers",
    "SELECT * FROM linked.otherdb.dbo.T",
    "SELECT name FROM sys.databases",
    "SELECT name FROM [sys].[databases]",
    "SELECT * FROM master.sys.databases",
    "SELECT name FROM sysdatabases",
    "SELECT DB_NAME(5)",
    "SELECT * FROM sys.servers",
    // logins, passwords, users, permissions
    "SELECT name, password_hash FROM sys.sql_logins",
    'SELECT name FROM "sys"."sql_logins"',
    "SELECT * FROM sys . [server_principals]",
    "SELECT * FROM syslogins",
    "SELECT * FROM sys.database_principals",
    "SELECT * FROM sys.database_role_members",
    "SELECT LOGINPROPERTY('sa', 'PasswordHash')",
    "SELECT PWDCOMPARE('x', 0x01)",
    "SELECT SUSER_SNAME()",
    "SELECT SYSTEM_USER",
    "SELECT * FROM fn_my_permissions(NULL, 'SERVER')",
    "SELECT * FROM sys.credentials",
    // server configuration / sessions
    "SELECT SERVERPROPERTY('MachineName')",
    "SELECT @@SERVERNAME",
    "SELECT * FROM sys.dm_exec_sessions",
    "SELECT * FROM sys.dm_exec_connections",
  ];
  for (const sql of blocked) {
    it(sql, () => assert.throws(() => assertReadOnly(sql), SqlGuardError));
  }
});

describe("assertReadOnly allows", () => {
  const allowed = [
    "SELECT 1",
    "select top (10) * from dbo.Orders where Status = 'Shipped';",
    "WITH recent AS (SELECT * FROM dbo.Orders WHERE OrderDate > '2026-01-01') SELECT COUNT(*) FROM recent",
    "SELECT [Update], [Delete] FROM dbo.AuditLog",
    `SELECT "Insert" FROM dbo.T`,
    "SELECT * FROM dbo.T WHERE Note = 'please DELETE this; DROP TABLE x'",
    "SELECT * FROM dbo.T WHERE Name = N'O''Brien'",
    "SELECT 1 -- DELETE FROM x",
    "SELECT /* outer /* nested DROP */ still comment */ 1",
    "SELECT UpdatedAt, CreatedBy, IsDeleted FROM dbo.T",
    "SELECT o.* FROM dbo.Orders o FOR JSON PATH",
  ];
  for (const sql of allowed) {
    it(sql, () => assert.doesNotThrow(() => assertReadOnly(sql)));
  }

  it("strips trailing semicolons", () => {
    assert.equal(assertReadOnly("  SELECT 1 ;; "), "SELECT 1");
  });
});

describe("assertReadOnly rejects", () => {
  const rejected = [
    "",
    "   ;  ",
    "DELETE FROM dbo.Orders",
    "UPDATE dbo.Orders SET Status = 'x'",
    "INSERT INTO dbo.T VALUES (1)",
    "SELECT * INTO dbo.Copy FROM dbo.Orders",
    "SELECT 1; DROP TABLE dbo.Orders",
    "SELECT 1 DELETE FROM dbo.Orders",
    "WITH x AS (SELECT 1 AS a) DELETE FROM x",
    "WITH x AS (SELECT 1 AS a) MERGE dbo.T USING x ON 1=0 WHEN NOT MATCHED THEN INSERT (a) VALUES (x.a)",
    "EXEC sp_who",
    "SELECT * FROM OPENROWSET('SQLNCLI', 'Server=x;', 'SELECT 1')",
    "SELECT 1 WAITFOR DELAY '00:10:00'",
    "SELECT NEXT VALUE FOR dbo.MySeq",
    "SELECT * FROM sys.objects CROSS APPLY xp_cmdshell",
    "TRUNCATE TABLE dbo.Orders",
    "DECLARE @x INT = 1; SELECT @x",
    "SELECT 1 /* unterminated",
    "SELECT 'unterminated",
    "SELECT [unterminated",
    "SELECT 1 COMMIT",
    "select 1 go",
  ];
  for (const sql of rejected) {
    it(JSON.stringify(sql), () => assert.throws(() => assertReadOnly(sql), SqlGuardError));
  }
});

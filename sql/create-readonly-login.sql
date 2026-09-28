-- Creates a least-privilege login for the DB agent.
-- This is the primary read-only guarantee; the agent's SQL guard is a second layer.
-- Replace <YourDatabase> and the password, then run as a sysadmin / securityadmin.

USE [master];
GO
CREATE LOGIN [db_agent_reader]
    WITH PASSWORD = N'<ChangeMe-Strong-Password!>',
         CHECK_POLICY = ON,
         DEFAULT_DATABASE = [<YourDatabase>];
GO

USE [<YourDatabase>];
GO
CREATE USER [db_agent_reader] FOR LOGIN [db_agent_reader];
ALTER ROLE [db_datareader] ADD MEMBER [db_agent_reader];

-- Lets describe_table see index and FK metadata without granting data access beyond db_datareader.
GRANT VIEW DEFINITION TO [db_agent_reader];

-- Optional: hide sensitive tables or columns from the agent entirely.
-- DENY SELECT ON [dbo].[Employees] ([SSN], [Salary]) TO [db_agent_reader];
-- DENY SELECT ON SCHEMA::[hr] TO [db_agent_reader];
GO

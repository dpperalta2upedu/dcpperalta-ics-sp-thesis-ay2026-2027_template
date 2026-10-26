-- Run from the repository root with a database administrator account.
-- This script creates schema and sample layout data only; it never creates users
-- or passwords. Configure the application and bootstrap credentials as environment
-- variables before starting the service.

SOURCE sql/indoor_navigation_db.sql;
SOURCE sql/initial_data.sql;

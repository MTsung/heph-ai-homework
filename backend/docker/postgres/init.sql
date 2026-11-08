-- 每個微服務擁有自己的資料庫(database-per-service),彼此不跨庫查詢。
-- 本機只起一個 Postgres 實例以節省資源;正式環境可各自獨立一台,應用程式端無需修改。
CREATE DATABASE auth;
CREATE DATABASE character;
CREATE DATABASE chat;
CREATE DATABASE billing;

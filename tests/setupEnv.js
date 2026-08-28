// Setup test environment variables before tests execute
process.env.LANGCHAIN_TRACING_V2 = 'false';
process.env.LANGCHAIN_CALLBACKS_BACKGROUND = 'false';
process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = 'database.test.sqlite';

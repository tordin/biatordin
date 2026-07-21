import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

export const checkpointer = SqliteSaver.fromConnString("database.sqlite");

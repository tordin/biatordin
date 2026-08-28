import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { getDbPath } from "./db.js";

export const checkpointer = SqliteSaver.fromConnString(getDbPath());


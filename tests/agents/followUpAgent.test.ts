import { describe, test, expect } from '@jest/globals';
import {
  followUpAgentNode,
  addFollowUpTool,
  listFollowUpsTool,
  resolveFollowUpTool,
  cancelFollowUpTool,
  updateFollowUpTool
} from "../../src/agents/followUpAgent.js";

describe("FollowUp Agent Node & Tool Schemas", () => {
  test("deve validar schemas e metadados das ferramentas do followUpAgent", () => {
    expect(addFollowUpTool.name).toBe("add_follow_up");
    expect(listFollowUpsTool.name).toBe("list_follow_ups");
    expect(resolveFollowUpTool.name).toBe("resolve_follow_up");
    expect(cancelFollowUpTool.name).toBe("cancel_follow_up");
    expect(updateFollowUpTool.name).toBe("update_follow_up");
  });

  test("followUpAgentNode deve estar definido e ser função", () => {
    expect(typeof followUpAgentNode).toBe("function");
  });
});

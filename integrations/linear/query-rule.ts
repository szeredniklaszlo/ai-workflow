import type { IssueTrackerQueryRule } from "@integrations/sdk";

export function linearQueryProblem(query: string): string | null {
  if (query.trim() === "") return null;
  return (
    "Linear does not have a text-based query language like JQL. " +
    "Leave the query empty so the search uses the ticket's keywords."
  );
}

export const linearQueryRule: IssueTrackerQueryRule = {
  problem: linearQueryProblem,
};

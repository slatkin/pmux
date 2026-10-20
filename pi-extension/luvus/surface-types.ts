/**
 * Shared surface types — host independent.
 */

/** Shape of the prompt delivery result both backends return. */
export interface AgentPromptResult {
  submitted?: boolean;
  evidence?: string;
  pane?: string | number;
  status?: string;
  [key: string]: unknown;
}

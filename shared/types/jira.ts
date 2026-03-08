/**
 * Jira integration types shared between electron and renderer processes
 *
 * This implementation is designed to be extensible for future issue tracking
 * integrations (e.g., Linear, GitHub Issues, etc.). To add support for a new
 * provider:
 *
 * 1. Create similar types in shared/types/{provider}.ts
 * 2. Create IPC handlers in electron/src/ipc/{provider}.ts
 * 3. Create storage utilities in electron/src/lib/{provider}-store.ts
 * 4. Create UI components in src/components/{Provider}BoardPanel.tsx
 * 5. Add to ToolPicker as a new tool option
 * 6. Add provider-specific authentication flow if needed
 */

export interface JiraProjectConfig {
  instanceUrl: string; // https://your-domain.atlassian.net
  projectKey?: string; // e.g., "PROJ"
  boardId: string; // e.g., "1"
  boardName: string; // e.g., "Sprint Board"
  authMethod: "oauth" | "apitoken";
  isAuthenticated: boolean;
  createdAt: number;
  lastSync?: number;
}

export interface JiraBoard {
  id: string;
  name: string;
  type: "scrum" | "kanban" | "simple";
  projectKey?: string;
}

export interface JiraIssue {
  id: string;
  key: string;
  summary: string;
  description?: string;
  status: string;
  statusId?: string;
  statusCategory?: "todo" | "indeterminate" | "done";
  assignee?: {
    displayName: string;
    emailAddress?: string;
    avatarUrl?: string;
  };
  priority?: {
    name: string;
    iconUrl?: string;
  };
  issueType?: {
    name: string;
    iconUrl?: string;
  };
  url: string;
}

export interface JiraSprint {
  id: string;
  name: string;
  state: "active" | "closed" | "future";
  startDate?: string;
  endDate?: string;
}

export interface JiraGetSprintsParams {
  instanceUrl: string;
  boardId: string;
}

export interface JiraOAuthData {
  accessToken: string;
  email?: string; // Required for Jira Cloud Basic auth (base64(email:apiToken))
  refreshToken?: string;
  expiresAt?: number;
  instanceUrl: string;
  storedAt: number;
}

export interface JiraAuthResult {
  ok?: boolean;
  error?: string;
}

export interface JiraGetBoardsParams {
  instanceUrl: string;
  projectKey?: string;
}

export interface JiraGetIssuesParams {
  instanceUrl: string;
  boardId: string;
  sprintId?: string;
  maxResults?: number;
}

export interface JiraComment {
  id: string;
  author: string;
  authorAvatarUrl?: string;
  body: string;
  created: string;
}

export interface JiraGetCommentsParams {
  instanceUrl: string;
  issueKey: string;
}

export interface JiraTransition {
  id: string;
  name: string;
  toStatus: {
    id: string;
    name: string;
    category?: "todo" | "indeterminate" | "done";
  };
}

export interface JiraGetTransitionsParams {
  instanceUrl: string;
  issueKey: string;
}

export interface JiraTransitionIssueParams extends JiraGetTransitionsParams {
  transitionId: string;
}

export interface JiraBoardColumn {
  id: string;
  name: string;
  statusIds: string[];
  min?: number;
  max?: number;
}

export interface JiraBoardConfiguration {
  id: string;
  name: string;
  columns: JiraBoardColumn[];
}

export interface JiraProjectSummary {
  id: string;
  key: string;
  name: string;
}

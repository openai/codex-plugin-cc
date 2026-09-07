import type {
  ClientInfo,
  InitializeCapabilities,
  InitializeParams,
  InitializeResponse,
  ServerNotification
} from "../../.generated/app-server-types/index.js";
import type {
  ExternalAgentConfigImportParams,
  ExternalAgentConfigImportResponse,
  ReviewStartParams,
  ReviewStartResponse,
  ReviewTarget,
  Thread,
  ThreadItem,
  ThreadListParams,
  ThreadListResponse,
  ThreadResumeParams as RawThreadResumeParams,
  ThreadResumeResponse,
  ThreadSetNameParams,
  ThreadSetNameResponse,
  ThreadStartParams as RawThreadStartParams,
  ThreadStartResponse,
  Turn,
  TurnInterruptParams,
  TurnInterruptResponse,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
  TurnSteerResponse,
  TurnCompletedNotification,
  ToolRequestUserInputParams,
  UserInput
} from "../../.generated/app-server-types/v2/index.js";

export type {
  ClientInfo,
  InitializeCapabilities,
  InitializeParams,
  InitializeResponse,
  ReviewTarget,
  Thread,
  ThreadItem,
  ThreadListParams,
  Turn,
  TurnInterruptParams,
  TurnStartParams,
  UserInput
};

export type ThreadStartParams = Omit<RawThreadStartParams, "persistExtendedHistory">;
export type ThreadResumeParams = Omit<RawThreadResumeParams, "persistExtendedHistory">;

export interface CodexAppServerClientOptions {
  env?: NodeJS.ProcessEnv;
  clientInfo?: ClientInfo;
  capabilities?: InitializeCapabilities;
  brokerEndpoint?: string;
  disableBroker?: boolean;
  reuseExistingBroker?: boolean;
  requestUserInput?: boolean;
  requireBroker?: boolean;
}

export interface PendingMessage {
  id: string;
  input: UserInput[];
  status: "sending" | "accepted";
}

export interface LiveTurnStatus {
  threadId: string;
  turnId: string | null;
  pendingMessages: PendingMessage[];
  undeliveredMessages: PendingMessage[];
  questions: Array<ToolRequestUserInputParams & { requestId: string | number; expiresAt: number }>;
  interrupting: boolean;
  partialChanges: Array<{ path: string; status: string }>;
  error: string | null;
  workspaceStatus?: string;
}

export interface AppServerMethodMap {
  initialize: { params: InitializeParams; result: InitializeResponse };
  "externalAgentConfig/import": { params: ExternalAgentConfigImportParams; result: ExternalAgentConfigImportResponse };
  "thread/start": { params: ThreadStartParams; result: ThreadStartResponse };
  "thread/resume": { params: ThreadResumeParams; result: ThreadResumeResponse };
  "thread/name/set": { params: ThreadSetNameParams; result: ThreadSetNameResponse };
  "thread/list": { params: ThreadListParams; result: ThreadListResponse };
  "review/start": { params: ReviewStartParams; result: ReviewStartResponse };
  "turn/start": { params: TurnStartParams; result: TurnStartResponse };
  "turn/interrupt": { params: TurnInterruptParams; result: TurnInterruptResponse };
  "turn/steer": { params: TurnSteerParams; result: TurnSteerResponse & { messageId?: string } };
  "broker/status": { params: { threadId: string }; result: LiveTurnStatus };
  "broker/answer": { params: { threadId: string; turnId: string; requestId: string | number; answers: unknown }; result: { answered: boolean; requestId: string | number } };
  "broker/redirect": { params: { threadId: string; turnId: string; input: UserInput[] }; result: { interrupted: boolean; threadId: string; turnId: string; partialChanges: LiveTurnStatus["partialChanges"] } };
}

export type AppServerMethod = keyof AppServerMethodMap;
export type AppServerRequestParams<M extends AppServerMethod> = AppServerMethodMap[M]["params"];
export type AppServerResponse<M extends AppServerMethod> = AppServerMethodMap[M]["result"];
export type AppServerNotification = Exclude<ServerNotification, { method: "turn/completed" }> |
  { method: "turn/completed"; params: TurnCompletedNotification & { redirectInput?: UserInput[]; controlError?: string; interruptedWorkspaceStatus?: string } } |
  { method: "companion/question"; params: { threadId: string; turnId: string; requestId: string | number } };
export type AppServerNotificationHandler = (message: AppServerNotification) => void;

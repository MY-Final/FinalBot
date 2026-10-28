export interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc?: "2.0";
  id?: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
}

export type CodexIncoming =
  | {
      jsonrpc?: "2.0";
      id: number | string;
      result?: unknown;
      error?: {
        code: number;
        message: string;
        data?: unknown;
      };
      method?: undefined;
      params?: undefined;
    }
  | {
      jsonrpc?: "2.0";
      id?: undefined;
      method: string;
      params?: unknown;
      result?: undefined;
      error?: undefined;
    }
  | {
      id: number | string;
      method: string;
      params?: unknown;
      result?: undefined;
      error?: undefined;
    };

export interface CodexThreadStartResult {
  thread: {
    id: string;
    sessionId: string;
  };
}

export interface CodexThreadResumeResult {
  thread: {
    id: string;
    sessionId: string;
  };
}

export interface CodexTurnStartResult {
  turn: {
    id: string;
    status: string;
  };
}

export type CodexCommandApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export type CodexFileChangeApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

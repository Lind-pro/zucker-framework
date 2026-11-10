/** Shapes of the server's `/chat` endpoints. */
export type ChatRole = 'user' | 'assistant';
export type ChatMessageStatus = 'COMPLETE' | 'FAILED' | 'ABORTED' | 'STREAMING';

export interface ChatUsage {
  input: number;
  output: number;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  reasoning: string | null;
  status: ChatMessageStatus;
  providerId?: string | null;
  model?: string | null;
  usage?: ChatUsage | null;
  cost?: number | null;
  errorCode?: string | null;
  createdAt?: string;
  completedAt?: string | null;
}

export interface ChatSummary {
  id: string;
  title: string | null;
  providerId: string;
  model: string;
  messageCount: number;
  cost: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatDetail extends ChatSummary {
  messages: ChatMessage[];
}

export interface ChatPage {
  items: ChatSummary[];
  next: string | null;
}

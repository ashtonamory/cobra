// The request and answer of the home model (homeModel.ts, `--home-ai`):
// Anthropic's Messages shape, whatever local model runs underneath.

export interface MessageBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface MessageRequest {
  model: string;
  max_tokens: number;
  system?: string | Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
  messages: Array<{ role: "user" | "assistant"; content: string | MessageBlock[] }>;
  temperature?: number;
}

export interface MessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: MessageBlock[];
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

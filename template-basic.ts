// index.ts — Minimal MCP JSON-RPC template (Cloudflare Worker, TS)

export interface Env {
  MCP_SERVER_NAME?: string;
  MCP_SERVER_VERSION?: string;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number | string | null;
  result: Json;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: number | string | null;
  error: {
    code: number;
    message: string;
    data?: Json;
  };
}

interface ToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

const PROTOCOL_VERSION = "2025-06-18" as const;

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Minimal CORS for local testing
    const cors: HeadersInit = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const serverInfo = {
      name: env.MCP_SERVER_NAME ?? "MinimalMCP",
      version: env.MCP_SERVER_VERSION ?? "0.1.0",
    };

    // Tiny "about" page for GET /
    if (request.method === "GET" && url.pathname === "/") {
      return json({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo }, cors);
    }

    // Treat ANY POST path as MCP JSON-RPC
    if (request.method !== "POST") return new Response("Not Found", { status: 404 });

    let rpc: JsonRpcRequest | undefined;
    try {
      rpc = (await request.json()) as JsonRpcRequest;
    } catch {
      return jsonRpcError(null, -32700, "Parse error", cors);
    }

    const id = rpc?.id ?? null;
    const method = rpc?.method;

    // ========== MCP methods ==========
    if (method === "initialize") {
      return json(
        {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } }, // add other caps as needed
            serverInfo,
          },
        } as JsonRpcSuccess,
        cors,
      );
    }

    if (method === "initialized") {
      // Notification: no body required
      return new Response(null, { status: 204, headers: cors });
    }

    if (method === "tools/list") {
      // --- Placeholder tool descriptor ---
      const tools: ToolDescriptor[] = [
        {
          name: "your_tool_name",
          title: "Your Tool Title",
          description: "What this tool does in one sentence.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              // e.g., query: { type: "string" }
            },
            // required: ["query"]
          },
          outputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              // e.g., data: { type: "string" }
            },
            // required: ["data"]
          },
        },
      ];

      return json({ jsonrpc: "2.0", id, result: { tools } } as JsonRpcSuccess, cors);
    }

    if (method === "tools/call") {
      const { name, arguments: args = {} } =
        (rpc?.params as { name?: string; arguments?: Record<string, Json> }) ?? {};

      // --- Implement your tool(s) here ---
      if (name === "your_tool_name") {
        // Example: echo the args back as a stub
        const line = `your_tool_name called with: ${JSON.stringify(args)}`;

        return json(
          {
            jsonrpc: "2.0",
            id,
            result: {
              // Human-readable output for the chat surface
              content: [{ type: "text", text: line }],
              // Machine-usable payload matching outputSchema
              structuredContent: {
                // e.g., data: "result"
              },
            },
          } as JsonRpcSuccess,
          cors,
        );
      }

      // Unknown tool
      return jsonRpcError(id, -32601, `Unknown tool: ${name}`, cors);
    }

    // Unknown method
    return jsonRpcError(id, -32601, `Method not found: ${String(method)}`, cors);
  },
};

// ===== Helpers =====
function json(body: Json, cors?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...(cors ?? {}) },
  });
}

function jsonRpcError(id: number | string | null, code: number, message: string, cors?: HeadersInit): Response {
  const payload: JsonRpcError = { jsonrpc: "2.0", id, error: { code, message } };
  return json(payload as unknown as Json, cors);
}


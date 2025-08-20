// index.ts — Minimal MCP JSON-RPC template (Cloudflare Worker, TS) with Bearer auth on POSTs
// Reads the secret from env.MCP_API_KEY (set it in wrangler.toml).
// GET / stays open.
// OPTIONS is allowed (CORS preflight).
// Missing or wrong token → 401 Unauthorized with a WWW-Authenticate: Bearer header.
// If the env var isn’t set, you’ll get a 500 (misconfiguration) so you don’t accidentally run open

export interface Env {
  MCP_SERVER_NAME?: string;
  MCP_SERVER_VERSION?: string;
  MCP_API_KEY?: string; // set in wrangler.toml
}

type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONValue[]
  | { [key: string]: JSONValue };

interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number | string | null;
  result: JSONValue;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: number | string | null;
  error: {
    code: number;
    message: string;
    data?: JSONValue;
  };
}

interface ToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, JSONValue>;
  outputSchema: Record<string, JSONValue>;
}

const PROTOCOL_VERSION = "2025-06-18" as const;

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Minimal CORS for local testing
    const cors: HeadersInit = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    // Allow CORS preflight without auth
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const serverInfo = {
      name: env.MCP_SERVER_NAME ?? "MinimalMCP",
      version: env.MCP_SERVER_VERSION ?? "0.1.0",
    };

    // Public: tiny "about" page
    if (request.method === "GET" && url.pathname === "/") {
      return json({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo }, cors);
    }

    // Require Bearer auth on ALL POSTs (JSON-RPC)
    if (request.method === "POST") {
      // Fail closed if server not configured with a key
      if (!env.MCP_API_KEY) {
        return serverMisconfigured(cors);
      }

      const authHeader = request.headers.get("Authorization");
      const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;

      if (!token || token !== env.MCP_API_KEY) {
        return unauthorized(cors);
      }
    }

    // Only POST is supported beyond this point (except GET / handled above)
    if (request.method !== "POST") {
      return new Response("Not Found", { status: 404, headers: cors });
    }

    // === JSON-RPC handling ===
    let rpc: JsonRpcRequest | undefined;
    try {
      rpc = (await request.json()) as JsonRpcRequest;
    } catch {
      return jsonRpcError(null, -32700, "Parse error", cors);
    }

    const id = rpc?.id ?? null;
    const method = rpc?.method;

    if (method === "initialize") {
      return json(
        {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo,
          },
        } as JsonRpcSuccess,
        cors,
      );
    }

    if (method === "initialized") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (method === "tools/list") {
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
        (rpc?.params as { name?: string; arguments?: Record<string, JSONValue> }) ?? {};

      if (name === "your_tool_name") {
        const line = `your_tool_name called with: ${JSON.stringify(args)}`;

        return json(
          {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: line }],
              structuredContent: {
                // e.g., data: "result"
              },
            },
          } as JsonRpcSuccess,
          cors,
        );
      }

      return jsonRpcError(id, -32601, `Unknown tool: ${name}`, cors);
    }

    return jsonRpcError(id, -32601, `Method not found: ${String(method)}`, cors);
  },
};

// ===== Helpers =====
function json(body: unknown, cors?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...(cors ?? {}) },
  });
}

function jsonRpcError(id: number | string | null, code: number, message: string, cors?: HeadersInit): Response {
  const payload: JsonRpcError = { jsonrpc: "2.0", id, error: { code, message } };
  return new Response(JSON.stringify(payload), {
    status: 200, // JSON-RPC errors still 200 at transport layer
    headers: { "Content-Type": "application/json", ...(cors ?? {}) },
  });
}

function unauthorized(cors?: HeadersInit): Response {
  return new Response(
    JSON.stringify({ error: "Unauthorized", message: "Missing or invalid bearer token." }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer realm="mcp", error="invalid_token"',
        ...(cors ?? {}),
      },
    },
  );
}

function serverMisconfigured(cors?: HeadersInit): Response {
  return new Response(
    JSON.stringify({ error: "Server Misconfigured", message: "MCP_API_KEY is not set." }),
    {
      status: 500,
      headers: { "Content-Type": "application/json", ...(cors ?? {}) },
    },
  );
}


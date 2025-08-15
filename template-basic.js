// index.js — Minimal MCP JSON-RPC template (Cloudflare Worker, JS)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Minimal CORS for local testing
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const serverInfo = {
      name: env.MCP_SERVER_NAME || "MinimalMCP",
      version: env.MCP_SERVER_VERSION || "0.1.0",
    };

    // Tiny "about" page for GET /
    if (request.method === "GET" && url.pathname === "/") {
      return json({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo }, cors);
    }

    // Treat ANY POST path as MCP JSON-RPC
    if (request.method !== "POST") return new Response("Not Found", { status: 404 });

    let rpc;
    try { rpc = await request.json(); } catch { return jsonRpcError(null, -32700, "Parse error", cors); }

    const id = rpc?.id ?? null;
    const method = rpc?.method;

    // ========== MCP methods ==========
    if (method === "initialize") {
      return json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: false } }, // add other caps as needed
          serverInfo
        }
      }, cors);
    }

    if (method === "initialized") {
      // Notification: no body required
      return new Response(null, { status: 204, headers: cors });
    }

    if (method === "tools/list") {
      // --- Placeholder tool descriptor ---
      const tools = [
        {
          name: "your_tool_name",
          title: "Your Tool Title",
          description: "What this tool does in one sentence.",
          // Describe expected inputs for the tool call
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              // e.g., "query": { "type": "string" }
            }
            // required: ["query"]
          },
          // Describe the shape of what you return in structuredContent
          outputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              // e.g., "data": { "type": "string" }
            }
            // required: ["data"]
          }
        }
      ];

      return json({ jsonrpc: "2.0", id, result: { tools } }, cors);
    }

    if (method === "tools/call") {
      const { name, arguments: args = {} } = rpc?.params || {};

      // --- Implement your tool(s) here ---
      if (name === "your_tool_name") {
        // Do work here (fetch, compute, etc.)
        // Example: echo the args back as a stub
        const line = `your_tool_name called with: ${JSON.stringify(args)}`;

        return json({
          jsonrpc: "2.0",
          id,
          result: {
            // Human-readable output for the chat surface
            content: [{ type: "text", text: line }],
            // Machine-usable payload matching outputSchema
            structuredContent: {
              // e.g., data: "result"
            }
          }
        }, cors);
      }

      // Unknown tool
      return jsonRpcError(id, -32601, `Unknown tool: ${name}`, cors);
    }

    // Unknown method
    return jsonRpcError(id, -32601, `Method not found: ${method}`, cors);
  }
};

// ===== Helpers =====
function json(body, cors) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...(cors || {}) }
  });
}
function jsonRpcError(id, code, message, cors) {
  return json({ jsonrpc: "2.0", id, error: { code, message } }, cors);
}


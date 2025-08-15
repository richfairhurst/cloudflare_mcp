// index.js — MCP JSON-RPC template (Cloudflare Worker, JS) with KV "get" tool (text-only, fixed binding)
//
// Wrangler binding example (wrangler.toml):
// [[kv_namespaces]]
// binding = "KV"            // default binding name used below
// id = "<prod-id>"
// preview_id = "<preview-id>"

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
      version: env.MCP_SERVER_VERSION || "0.2.0",
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
          capabilities: { tools: { listChanged: false } },
          serverInfo
        }
      }, cors);
    }

    if (method === "initialized") {
      // Notification: no body required
      return new Response(null, { status: 204, headers: cors });
    }

    if (method === "tools/list") {
      const tools = [
        {
          name: "kv_get",
          title: "KV: Get a key",
          description: "Read a text value for a key from the bound Cloudflare KV namespace 'KV'. Always returns strings (or null).",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              key: { type: "string", description: "KV key to read" }
            },
            required: ["key"]
          },
          outputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              key: { type: "string" },
              found: { type: "boolean" },
              value: { type: ["string", "null"], description: "Text value if found, else null." }
            },
            required: ["key", "found"]
          }
        }
      ];

      return json({ jsonrpc: "2.0", id, result: { tools } }, cors);
    }

    if (method === "tools/call") {
      const { name, arguments: args = {} } = rpc?.params || {};

      if (name === "kv_get") {
        const key = args.key;
        if (typeof key !== "string" || !key.length) {
          return jsonRpcError(id, -32602, "Invalid params: 'key' must be a non-empty string.", cors);
        }

        const ns = env?.KV;
        if (!ns || typeof ns.get !== "function") {
          return jsonRpcError(id, -32602, "KV binding 'KV' not found on env.", cors);
        }

        try {
          let value = null, found = false;

          const v = await ns.get(key); // text mode
          if (v !== null && typeof v !== "undefined") {
            found = true;
            value = String(v);
          }

          const human = found
            ? `KV[KV] get '${key}' → text`
            : `KV[KV] key '${key}' not found`;

          return json({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: human }],
              structuredContent: { key, found, value: found ? value : null }
            }
          }, cors);
        } catch (err) {
          return jsonRpcError(id, -32002, `KV read failed: ${err?.message || String(err)}`, cors);
        }
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


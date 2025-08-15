// src/index.ts
// MCP JSON-RPC with tool-per-section; KV hidden behind generic “data” wording

import type { KVNamespace } from "@cloudflare/workers-types";

type JSONValue = string | number | boolean | null | JSONValue[] | { [k: string]: JSONValue };

interface MCPRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: { name?: string; arguments?: Record<string, JSONValue> } | Record<string, JSONValue>;
}

interface MCPResult {
  content?: Array<{ type: "text"; text: string }>;
  structuredContent?: { key: string; found: boolean; value: string | null };
}

interface Env {
  KV: KVNamespace; // typed KV binding
  MCP_SERVER_NAME?: string;
  MCP_SERVER_VERSION?: string;
}

const toolKeyMap = {
  about_me: "about_me",
  professional_certifications : "professional_certifications",
  how_i_work : "how_i_work",
  countries: "countries",
  socials : "socials",
  uses : "uses",
  currently : "currently"
} as const;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const serverInfo = {
      name: env.MCP_SERVER_NAME ?? "MinimalMCP",
      version: env.MCP_SERVER_VERSION ?? "0.2.0",
    };

    if (request.method === "GET" && url.pathname === "/") {
      return json({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo }, cors);
    }

    if (request.method !== "POST") return new Response("Not Found", { status: 404 });

    let rpc: MCPRequest;
    try {
      rpc = (await request.json()) as MCPRequest;
    } catch {
      return jsonRpcError(null, -32700, "Invalid request format", cors);
    }

    const id = rpc.id ?? null;
    const method = rpc.method;

    if (method === "initialize") {
      return json({ jsonrpc: "2.0", id, result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo
      }}, cors);
    }

    if (method === "initialized") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (method === "tools/list") {
      const tools = Object.keys(toolKeyMap).map((toolName) => ({
        name: toolName,
        title: `Get: ${(toolKeyMap as any)[toolName]}`,
        description: `Retrieve the '${(toolKeyMap as any)[toolName]}' section as plain text.`,
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        outputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { key: { type: "string" }, found: { type: "boolean" }, value: { type: ["string", "null"] } },
          required: ["key", "found"],
        },
      }));
      return json({ jsonrpc: "2.0", id, result: { tools } }, cors);
    }

    if (method === "tools/call") {
      const name = (rpc.params as any)?.name as keyof typeof toolKeyMap | undefined;
      if (name && toolKeyMap[name]) {
        const key = toolKeyMap[name];
        if (!env.KV || typeof env.KV.get !== "function") {
          return jsonRpcError(id, -32001, "Data not available.", cors);
        }
        try {
          const raw = await env.KV.get(key);
          const found = raw !== null && raw !== undefined;
          const value = found ? String(raw) : null;

          const result: MCPResult = {
            content: [{ type: "text", text: found ? value! : `No data for '${key}'.` }],
            structuredContent: { key, found, value },
          };
          return json({ jsonrpc: "2.0", id, result }, cors);
        } catch (err: unknown) {
          return jsonRpcError(id, -32002, "Unable to retrieve data.", cors);
        }
      }
      return jsonRpcError(id, -32601, `Unknown tool: ${(rpc.params as any)?.name ?? ""}`, cors);
    }

    return jsonRpcError(id, -32601, `Method not found: ${method}`, cors);
  },
};

function json(body: unknown, cors?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...(cors ?? {}) },
  });
}

function jsonRpcError(id: string | number | null, code: number, message: string, cors?: Record<string, string>) {
  return json({ jsonrpc: "2.0", id, error: { code, message } }, cors);
}


// mcp_vuln_intel.ts — Minimal MCP JSON-RPC Worker (Cloudflare Workers, TS)

type JSONValue = string | number | boolean | null | JSONValue[] | { [k: string]: JSONValue };

interface MCPRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: { name?: string; arguments?: Record<string, JSONValue> } | Record<string, JSONValue>;
}

interface MCPResult {
  content?: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, JSONValue>;
}

interface Env {
  MCP_SERVER_NAME?: string;
  MCP_SERVER_VERSION?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS (keep minimal)
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const serverInfo = {
      name: env.MCP_SERVER_NAME || "VULN_INTEL_MCP",
      version: env.MCP_SERVER_VERSION || "1.5.0",
    };

    // Tiny "about" page for GET /
    if (request.method === "GET" && url.pathname === "/") {
      return json(
        {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo,
        },
        cors
      );
    }

    // Only POST handles JSON-RPC
    if (request.method !== "POST") return new Response("Not Found", { status: 404, headers: cors });

    let rpc: MCPRequest | null = null;
    try {
      rpc = (await request.json()) as MCPRequest;
    } catch {
      return jsonRpcError(null, -32700, "Parse error", cors);
    }

    const id = rpc?.id ?? null;
    const method = rpc?.method;

    // ===== MCP standard methods =====

    // initialize -> provide protocol + capabilities + serverInfo
    if (method === "initialize") {
      return json(
        {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo,
          },
        },
        cors
      );
    }

    // initialized (notification)
    if (method === "initialized") {
      return new Response(null, { status: 204, headers: cors });
    }

    // tools/list -> describe available tools
    if (method === "tools/list") {
      const toolOutputSchema = {
        type: "object",
        patternProperties: {
          "^CVE-\\d{4}-\\d{4,7}$": {
            type: "object",
            properties: {
              summary: { type: "string" },
              cvss: { type: "string" },
              severity: { type: "string" },
              cwe: { type: "string" },
              published: { type: "string" },
              references: { type: "array", items: { type: "string", format: "uri" } },
            },
            required: ["summary"],
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      };

      const tools = [
        {
          name: "get_latest_vuln_intel",
          title: "Get Latest Vulnerability Intelligence",
          description:
            "Fetch recent CVE IDs from Vulmon (?q=*&sortby=bydate), then enrich each with CIRCL (CVE JSON 5.x). Returns summary, CVSS, severity, CWE, published, references.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
            },
          },
          outputSchema: toolOutputSchema,
        },
      ];

      return json({ jsonrpc: "2.0", id, result: { tools } }, cors);
    }

    // tools/call -> route to our tool(s)
    if (method === "tools/call") {
      const name = (rpc?.params as any)?.name as string | undefined;
      const args = ((rpc?.params as any)?.arguments || {}) as Record<string, JSONValue>;

      if (name === "get_latest_vuln_intel") {
        const limitArg = Number.isFinite(args?.limit as number) ? (args?.limit as number) : 10;
        const limit = Math.min(Math.max(1, limitArg), 50);

        const result = await getLatestVulnIntel(limit);
        return json({ jsonrpc: "2.0", id, result }, cors);
      }

      return jsonRpcError(id, -32601, `Unknown tool: ${name}`, cors);
    }

    // Unknown method
    return jsonRpcError(id, -32601, `Method not found: ${method}`, cors);
  },
};

// ===== Tool implementation =====

async function getLatestVulnIntel(limit: number): Promise<MCPResult> {
  const vulnmonURL = "https://vulmon.com/searchpage?q=*&sortby=bydate";

  const res = await fetch(vulnmonURL);
  if (!res.ok) {
    return {
      content: [{ type: "text", text: "Failed to retrieve Vulmon page." }],
    };
  }

  const html = await res.text();

  // Confine to the left-hand column to ignore side recommendations
  const leftStart = html.indexOf('class="thirteen wide column"');
  const rightStart = html.indexOf('class="three wide column"');
  const leftColumn =
    leftStart >= 0
      ? html.slice(leftStart, rightStart > leftStart ? rightStart : html.length)
      : html;

  // Extract CVE IDs in order (unique)
  const cveRegex = /CVE-\d{4}-\d{4,7}/g;
  const found = leftColumn.match(cveRegex) || [];
  const seen = new Set<string>();
  const cveIds: string[] = [];
  for (const id of found) {
    if (!seen.has(id)) {
      seen.add(id);
      cveIds.push(id);
    }
    if (cveIds.length >= limit) break;
  }

  const out: Record<string, JSONValue> = {};
  for (const cve of cveIds) {
    const detail = await fetchCirclCve5(cve);
    if (detail) out[cve] = detail;
  }

  return {
    content: [{ type: "text", text: `Fetched ${Object.keys(out).length} recent CVEs with structured details.` }],
    structuredContent: out,
  };
}

async function fetchCirclCve5(cveId: string): Promise<JSONValue | null> {
  const url = `https://cve.circl.lu/api/cve/${cveId}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;

    const data: any = await r.json();

    // Extract summary (CVE 5.x)
    const cna = data?.containers?.cna;
    const summary: string =
      cna?.descriptions?.find((d: any) => d?.lang === "en")?.value ?? "";

    // Prefer CVSS v4, then v3.1, then v3.0
    const metrics = Array.isArray(cna?.metrics) ? cna.metrics : [];
    const m4 = metrics.find((m: any) => m?.cvssV4_0)?.cvssV4_0;
    const m31 = metrics.find((m: any) => m?.cvssV3_1)?.cvssV3_1;
    const m30 = metrics.find((m: any) => m?.cvssV3_0)?.cvssV3_0;

    const score = m4?.baseScore ?? m31?.baseScore ?? m30?.baseScore ?? null;
    const severity: string | null =
      m4?.baseSeverity ?? m31?.baseSeverity ?? m30?.baseSeverity ?? null;

    // CWE
    const cwe =
      data?.containers?.cna?.problemTypes?.[0]?.descriptions?.[0]?.cweId ?? "";

    // Published
    const published: string = data?.cveMetadata?.datePublished ?? "";

    // References
    const references: string[] = (cna?.references || [])
      .map((r: any) => r?.url)
      .filter((u: any) => typeof u === "string");

    return {
      summary,
      cvss: score != null ? String(score) : "",
      severity: severity ?? "",
      cwe,
      published,
      references,
    };
  } catch {
    return null;
  }
}

// ===== helpers =====
function json(body: unknown, cors?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...(cors || {}) },
  });
}
function jsonRpcError(id: number | string | null, code: number, message: string, cors?: Record<string, string>) {
  return json({ jsonrpc: "2.0", id, error: { code, message } }, cors);
}


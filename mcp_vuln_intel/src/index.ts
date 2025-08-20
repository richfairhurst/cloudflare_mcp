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
        properties: {
          high_critical: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                score: { type: "number" },
                sev: { type: "string" },
                published: { type: "string" },
                ref: { type: "string" },
                description: { type: "string" },
              },
            },
          },
          others: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                score: { type: "number" },
                sev: { type: "string" },
                published: { type: "string" },
                ref: { type: "string" },
                description: { type: "string" },
              },
            },
          },
        },
        additionalProperties: false,
      };

      const tools = [
        {
          name: "get_latest_vuln_intel",
          title: "Get Latest Vulnerability Intelligence",
          description:
            "Fetches all vulnerabilities published in the last 24 hours from the CIRCL CVE API and categorizes them into two buckets: 'high_critical' (CRITICAL and HIGH severity based on CVSS score) and 'others' (MEDIUM, LOW, or unrated). Each vulnerability includes ID, title, CVSS score, severity, publish date, reference URL, and description. Use this tool to get the latest published vulnerabilities with severity-based prioritization.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
          },
          outputSchema: toolOutputSchema,
        },
      ];

      return json({ jsonrpc: "2.0", id, result: { tools } }, cors);
    }

    // tools/call -> route to our tool(s)
    if (method === "tools/call") {
      const name = (rpc?.params as any)?.name as string | undefined;

      if (name === "get_latest_vuln_intel") {
        const result = await getLatestVulnIntel();
        return json({ jsonrpc: "2.0", id, result }, cors);
      }

      return jsonRpcError(id, -32601, `Unknown tool: ${name}`, cors);
    }

    // Unknown method
    return jsonRpcError(id, -32601, `Method not found: ${method}`, cors);
  },
};

// ===== Tool implementation =====

async function getLatestVulnIntel(): Promise<MCPResult> {
  const circlRecentURL = "https://cve.circl.lu/api/vulnerability/recent";

  const res = await fetch(circlRecentURL);
  if (!res.ok) {
    return {
      content: [{ type: "text", text: "Failed to retrieve recent vulnerabilities from CIRCL." }],
    };
  }

  const vulnerabilities: any[] = await res.json();

  // Generate since date (24 hours ago in UTC ISO format)
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Normalize and filter vulnerabilities
  const normalized = vulnerabilities
    .map(normalizeVuln)
    .filter((v) => v.published && v.published >= since);

  // Categorize into buckets
  const highCritical = normalized
    .filter((v) => v.sev_norm === "CRITICAL" || v.sev_norm === "HIGH")
    .sort((a, b) => (b.score - a.score) || (new Date(b.published).getTime() - new Date(a.published).getTime()))
    .map((v) => ({
      id: v.cve_id || v.vuln_id,
      title: v.title,
      score: v.score,
      sev: v.sev_norm,
      published: v.published,
      ref: v.references?.[0] || null,
      description: v.description,
    }));

  const others = normalized
    .filter((v) => v.sev_norm !== "CRITICAL" && v.sev_norm !== "HIGH")
    .sort((a, b) => new Date(b.published).getTime() - new Date(a.published).getTime())
    .map((v) => ({
      id: v.cve_id || v.vuln_id,
      title: v.title,
      score: v.score,
      sev: v.sev_norm,
      published: v.published,
      ref: v.references?.[0] || null,
      description: v.description,
    }));

  const result = {
    high_critical: highCritical,
    others: others,
  };

  return {
    content: [{ type: "text", text: `Fetched ${normalized.length} recent CVEs (last 24h) categorized by severity.` }],
    structuredContent: result,
  };
}

// Helper function to normalize vulnerability data
function normalizeVuln(vuln: any): any {
  let vuln_id: string;
  let cve_id: string | null = null;
  let title: string | null = null;
  let cvss: any = null;
  let description: string | null = null;
  let references: string[] = [];
  let published: string | null = null;
  let updated: string | null = null;
  let source: string = "CVE_RECORD";

  if (vuln.vulnerabilities) {
    // Handle vulnerabilities array (e.g., from some sources)
    const v = vuln.vulnerabilities[0];
    vuln_id = v.cve || `${vuln.document?.tracking?.id || "unknown"}:${v.ids?.[0] || v.title || "unknown"}`;
    cve_id = v.cve || null;
    title = v.title || null;
    cvss = v.scores?.[0]?.cvss_v4 || v.scores?.[0]?.cvss_v3 || null;
    description = v.notes?.find((n: any) => n.category === "description")?.text || null;
    references = [...(v.references?.map((r: any) => r.url) || []), ...(vuln.document?.references?.map((r: any) => r.url) || [])].filter(Boolean);
    published = vuln.document?.tracking?.initial_release_date || null;
    updated = vuln.document?.tracking?.current_release_date || null;
    source = vuln.document?.publisher?.name || "unknown";
  } else if (vuln.schema_version && vuln.id?.startsWith("GHSA-")) {
    // Handle GHSA format
    vuln_id = vuln.id;
    cve_id = vuln.aliases?.find((a: string) => a.startsWith("CVE-")) || null;
    title = vuln.summary || null;
    cvss = { baseScore: parseFloat(vuln.severity?.[0]?.score) || 0, baseSeverity: null };
    description = vuln.details || null;
    references = vuln.references?.map((r: any) => r.url) || [];
    published = vuln.published || null;
    updated = vuln.modified || null;
    source = "GHSA";
  } else {
    // Standard CVE format
    vuln_id = vuln.cveMetadata?.cveId || vuln.id || "unknown";
    cve_id = vuln.cveMetadata?.cveId || null;
    title = vuln.containers?.cna?.title || vuln.summary || null;
    cvss = chooseCvss(vuln);
    description = firstEn(vuln.containers?.cna?.descriptions) || firstEn(vuln.descriptions) || vuln.details || null;
    references = [...(vuln.containers?.cna?.references?.map((r: any) => r.url) || []), ...(vuln.references?.map((r: any) => r.url) || [])].filter(Boolean);
    published = vuln.cveMetadata?.datePublished || vuln.published || vuln.publishedAt || null;
    updated = vuln.cveMetadata?.dateUpdated || vuln.lastModified || vuln.modified || null;
    source = vuln.containers?.cna?.providerMetadata?.shortName || vuln.sourceIdentifier || "CVE_RECORD";
  }

  // Calculate score and severity
  const score = cvss?.baseScore || 0;
  const sev_norm = cvss?.baseSeverity ||
    (score >= 9 ? "CRITICAL" :
     score >= 8 ? "HIGH" :
     score >= 4 ? "MEDIUM" :
     score > 0 ? "LOW" : null);

  return {
    vuln_id,
    cve_id,
    title,
    cvss,
    description,
    references,
    published,
    updated,
    source,
    score,
    sev_norm,
  };
}

// Helper to choose CVSS data
function chooseCvss(vuln: any): any {
  const cvss4 = vuln.containers?.cna?.metrics?.find((m: any) => m.cvssV4_0)?.cvssV4_0;
  const cvss40 = vuln.metrics?.cvssMetricV40?.[0]?.cvssData;
  const cvss31 = vuln.metrics?.cvssMetricV31?.[0]?.cvssData;

  // Prioritize CVSS v4, then v4.0, then v3.1
  const selectedCvss = cvss4 || cvss40 || cvss31;
  if (selectedCvss) {
    return {
      baseScore: selectedCvss.baseScore || 0,
      baseSeverity: selectedCvss.baseSeverity || null,
      vectorString: selectedCvss.vectorString || null,
    };
  }
  return null;
}

// Helper to get first English description
function firstEn(descriptions: any[]): string | null {
  const enDesc = descriptions?.find((d: any) => d?.lang === "en");
  return enDesc?.value || null;
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


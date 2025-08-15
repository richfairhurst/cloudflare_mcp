// index.js — ORKL MCP Worker (token-safe, pagination-ready, with search + title resolution)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // simple CORS for local/dev
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const serverInfo = {
      name: env.MCP_SERVER_NAME || "ORKL_API_MCP",
      version: env.MCP_SERVER_VERSION || "1.5.0",
    };

    // GET / — tiny “about”
    if (request.method === "GET" && url.pathname === "/") {
      return json({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo
      }, cors);
    }

    // all POST paths are JSON-RPC
    if (request.method !== "POST") return new Response("Not Found", { status: 404 });

    let rpc;
    try { rpc = await request.json(); } catch { return jsonRpcError(null, -32700, "Parse error", cors); }

    const id = rpc?.id ?? null;
    const method = rpc?.method;

    // ---------- token-safety helpers ----------
    const MAX_JSON_BYTES = 100 * 1024;   // ~100 KB cap for structuredContent
    const MAX_TEXT_CHARS = 5000;         // clipped text max when requested

    function summarizePlainText(txt, maxLen = 400) {
      if (typeof txt !== "string" || !txt.trim()) return "No summary available.";
      const para = txt.split(/\n{2,}/)[0] || txt;
      const clean = para.replace(/\s+/g, " ").trim();
      return clean.length <= maxLen ? clean : clean.slice(0, maxLen - 1) + "…";
    }
    function clip(s, n) {
      if (typeof s !== "string" || !n || n <= 0) return undefined;
      return s.length <= n ? s : s.slice(0, n) + "… [truncated]";
    }
    function enforceSizeBudget(obj, maxBytes = MAX_JSON_BYTES) {
      const bytes = new TextEncoder().encode(JSON.stringify(obj)).byteLength;
      if (bytes > maxBytes && obj && obj.data) {
        const arr = Array.isArray(obj.data) ? obj.data : [obj.data];
        for (const item of arr) {
          if (item && typeof item.summary === "string" && item.summary.length > 200) {
            item.summary = item.summary.slice(0, 200) + "…";
          }
        }
      }
      return obj;
    }

    const isUuid = (s) =>
      typeof s === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);

    const isSha1 = (s) =>
      typeof s === "string" && /^[0-9a-f]{40}$/i.test(s);

    // ---------- minimal schemas ----------
    const latestItemSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        created_at: { type: "string" },
        pdf: { type: ["string", "null"] },
        summary: { type: "string" }
      },
      required: ["id", "title", "summary"]
    };

    const minimalEntrySchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        created_at: { type: "string" },
        pdf: { type: ["string", "null"] }
      },
      required: ["id", "title"]
    };

    const outputSchemaLatest = {
      type: "object",
      additionalProperties: false,
      properties: {
        status: { type: ["string", "null"] },
        message: { type: ["string", "null"] },
        data: { type: "array", items: latestItemSchema }
      },
      required: ["data"]
    };

    const outputSchemaById = {
      type: "object",
      additionalProperties: false,
      properties: {
        status: { type: ["string", "null"] },
        message: { type: ["string", "null"] },
        data: minimalEntrySchema
      },
      required: ["data"]
    };

    const outputSchemaPagedText = {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        page: { type: "integer" },
        nextPage: { type: ["integer", "null"] },
        text: { type: "string" }
      },
      required: ["id", "page", "text"]
    };

    const outputSchemaSearch = {
      type: "object",
      additionalProperties: false,
      properties: {
        status: { type: ["string", "null"] },
        message: { type: ["string", "null"] },
        data: { type: "array", items: latestItemSchema }
      },
      required: ["data"]
    };

    // ---------- MCP methods ----------
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
      return new Response(null, { status: 204, headers: cors });
    }

    if (method === "tools/list") {
      const tools = [
        {
          name: "fetch_latest_threat_reports",
          title: "Fetch Latest ORKL Reports",
          description: "Returns summary + PDF link for recent entries (supports offset).",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              limit:  { type: "integer", minimum: 1, maximum: 50, default: 5 },
              offset: { type: "integer", minimum: 0, default: 0 }
            }
          },
          outputSchema: outputSchemaLatest
        },
        {
          name: "fetch_threat_report_by_id",
          title: "Fetch Report by ID or SHA-1",
          description: "Get one ORKL entry by UUID or 40-char SHA-1 (lightweight).",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", description: "UUID or SHA-1" },
              include_text: { type: "boolean", default: false },
              max_text_chars: { type: "integer", default: 0 }
            },
            required: ["id"]
          },
          outputSchema: outputSchemaById
        },
        {
          name: "get_report_text_page",
          title: "Get report text (paged)",
          description: "Returns a small page of the ORKL .txt for a given UUID/SHA1 or resolves by title.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", description: "UUID or SHA-1 (preferred)" },
              title: { type: "string", description: "Optional: report title to resolve to an ID" },
              page: { type: "integer", default: 1, minimum: 1 },
              page_size: { type: "integer", default: 8000, minimum: 1000, maximum: 12000 }
            }
            // either id or title required (validated in handler)
          },
          outputSchema: outputSchemaPagedText
        },
        {
          name: "search_library",
          title: "Search ORKL Library",
          description: "Keyword search of ORKL reports; returns summary + PDF links.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              search_term: { type: "string", description: "Use quotes for exact matches" },
              limit: { type: "integer", minimum: 1, maximum: 100, default: 25 }
            },
            required: ["search_term"]
          },
          outputSchema: outputSchemaSearch
        }
      ];

      return json({ jsonrpc: "2.0", id, result: { tools } }, cors);
    }

    if (method === "tools/call") {
      const { name, arguments: args = {} } = rpc?.params || {};

      try {
        // ---- Latest with pagination + tiny payloads
        if (name === "fetch_latest_threat_reports") {
          const lim = Math.max(1, Math.min(50, args.limit ?? 5));
          const off = Math.max(0, args.offset ?? 0);

          const resp = await fetch(
            `https://orkl.eu/api/v1/library/entries?limit=${encodeURIComponent(lim)}&offset=${encodeURIComponent(off)}&order_by=created_at&order=desc`,
            { headers: { accept: "application/json" }, cf: { fetchTtl: 60 } }
          );
          if (!resp.ok) throw new Error(`ORKL HTTP ${resp.status}`);
          const payload = await resp.json();

          const data = (payload?.data || []).map((e) => ({
            id: e.id,
            title: e.title,
            created_at: e.created_at,
            pdf: e?.files?.pdf ?? null,
            summary: summarizePlainText(e?.plain_text || e?.title || "")
          }));

          const slim = enforceSizeBudget({
            status: payload?.status ?? null,
            message: payload?.message ?? null,
            data
          });

          // chat preview: show count + first few titles **with IDs**
          const preview = data.slice(0, 3).map((e, i) =>
            `${off + i + 1}. ${e.title} (${e.created_at}) — id: ${e.id}`
          ).join("\n");

          const line = data.length
            ? `Fetched ${data.length} report(s) (offset ${off}).\n${preview}\nTip: second-most-recent ⇒ offset 1 limit 1`
            : `No entries for offset ${off}.`;

          return json({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: line }],
              structuredContent: slim
            }
          }, cors);
        }

        // ---- By ID (UUID/SHA-1) minimal; optional clipped text in content
        if (name === "fetch_threat_report_by_id") {
          const idArg = args.id;
          if (!idArg || typeof idArg !== "string") {
            return jsonRpcError(id, -32602, "Invalid params: id string required", cors);
          }

          const path = isSha1(idArg)
            ? `https://orkl.eu/api/v1/library/entry/sha1/${encodeURIComponent(idArg)}`
            : isUuid(idArg)
              ? `https://orkl.eu/api/v1/library/entry/${encodeURIComponent(idArg)}`
              : null;

          if (!path) return jsonRpcError(id, -32602, "Invalid id format: use UUID or 40-char SHA-1", cors);

          const resp = await fetch(path, { headers: { accept: "application/json" }, cf: { fetchTtl: 60 } });
          if (resp.status === 404) {
            return json({
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: "Not found." }],
                structuredContent: { status: "error", message: "not found", data: null }
              }
            }, cors);
          }
          if (!resp.ok) throw new Error(`ORKL HTTP ${resp.status}`);

          const full = await resp.json();
          const e = full?.data || {};

          const slim = enforceSizeBudget({
            status: full?.status ?? null,
            message: full?.message ?? null,
            data: {
              id: e.id,
              title: e.title,
              created_at: e.created_at,
              pdf: e?.files?.pdf ?? null
            }
          });

          const includeText = !!args.include_text;
          const maxChars = Number.isInteger(args.max_text_chars) ? Math.max(0, args.max_text_chars) : 0;
          const clipped = includeText ? clip(e.plain_text, maxChars || MAX_TEXT_CHARS) : undefined;

          const lines = [
            `Title: ${e.title} (${e.created_at})`,
            e.files?.pdf ? `PDF: ${e.files.pdf}` : null,
            clipped ? `Text (clipped):\n${clipped}` : null
          ].filter(Boolean).join("\n");

          return json({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: lines || "No data." }],
              structuredContent: slim
            }
          }, cors);
        }

        // ---- Paged .txt fetch (safe chunk), accepts id OR title
        if (name === "get_report_text_page") {
          let idArg = args.id;
          const titleArg = args.title;
          const page = Math.max(1, args.page ?? 1);
          const size = Math.min(12000, Math.max(1000, args.page_size ?? 8000));

          if ((!idArg || typeof idArg !== "string") && (!titleArg || typeof titleArg !== "string")) {
            return jsonRpcError(id, -32602, "Invalid params: provide id (UUID/SHA-1) or title", cors);
          }

          // Resolve title → id when needed
          if ((!idArg || (!isUuid(idArg) && !isSha1(idArg))) && titleArg) {
            const s = await fetch(
              `https://orkl.eu/api/v1/library/search?query=${encodeURIComponent(titleArg)}&full=false&limit=1`,
              { headers: { accept: "application/json" }, cf: { fetchTtl: 60 } }
            );
            if (!s.ok) throw new Error(`ORKL HTTP ${s.status}`);
            const searchPayload = await s.json();
            const hit = searchPayload?.data?.[0];
            if (!hit?.id) {
              return jsonRpcError(id, -32002, `No report found for title "${titleArg}"`, cors);
            }
            idArg = hit.id; // resolved id from title
          }

          // validate final id
          if (!isUuid(idArg) && !isSha1(idArg)) {
            return jsonRpcError(id, -32602, "Invalid id format: use UUID or 40-char SHA-1", cors);
          }

          const infoPath = isSha1(idArg)
            ? `https://orkl.eu/api/v1/library/entry/sha1/${encodeURIComponent(idArg)}`
            : `https://orkl.eu/api/v1/library/entry/${encodeURIComponent(idArg)}`;

          const infoResp = await fetch(infoPath, { headers: { accept: "application/json" }, cf: { fetchTtl: 60 } });
          if (!infoResp.ok) throw new Error(`ORKL HTTP ${infoResp.status}`);
          const info = await infoResp.json();

          const txtUrl = info?.data?.files?.text;
          if (!txtUrl) return jsonRpcError(id, -32001, "No .txt available for this entry", cors);

          const txtResp = await fetch(txtUrl, { headers: { accept: "text/plain" }, cf: { fetchTtl: 120 } });
          if (!txtResp.ok) throw new Error(`TXT HTTP ${txtResp.status}`);
          const raw = await txtResp.text();

          const start = (page - 1) * size;
          const slice = raw.slice(start, start + size);
          const next = start + size < raw.length ? page + 1 : null;

          return json({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: slice.length ? slice : "[empty page]" }],
              structuredContent: { id: idArg, page, nextPage: next, text: slice }
            }
          }, cors);
        }

        // ---- Search library (tiny summaries + PDF links)
        if (name === "search_library") {
          const term = args.search_term;
          if (!term || typeof term !== "string") {
            return jsonRpcError(id, -32602, "Invalid params: search_term string required", cors);
          }
          const lim = Math.max(1, Math.min(100, args.limit ?? 25));

          const resp = await fetch(
            `https://orkl.eu/api/v1/library/search?query=${encodeURIComponent(term)}&full=false&limit=${encodeURIComponent(lim)}`,
            { headers: { accept: "application/json" }, cf: { fetchTtl: 60 } }
          );
          if (!resp.ok) throw new Error(`ORKL HTTP ${resp.status}`);
          const payload = await resp.json();

          const data = (payload?.data || []).map((e) => ({
            id: e.id,
            title: e.title,
            created_at: e.created_at,
            pdf: e?.files?.pdf ?? null,
            summary: summarizePlainText(e?.plain_text || e?.title || "")
          }));

          const slim = enforceSizeBudget({
            status: payload?.status ?? null,
            message: payload?.message ?? null,
            data
          });

          const preview = data.slice(0, 5).map((e, i) =>
            `${i + 1}. ${e.title} (${e.created_at}) — id: ${e.id}`
          ).join("\n");

          const line = data.length
            ? `Search "${term}" → ${data.length} result(s) (showing up to ${lim}).\n${preview}`
            : `No results for "${term}".`;

          return json({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: line }],
              structuredContent: slim
            }
          }, cors);
        }

        return jsonRpcError(id, -32601, `Unknown tool: ${name}`, cors);
      } catch (e) {
        return jsonRpcError(id, -32000, `Error: ${e?.message || "unknown"}`, cors);
      }
    }

    return jsonRpcError(id, -32601, `Method not found: ${method}`, cors);
  }
};

// ---------- helpers ----------
function json(body, cors) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...(cors || {}) }
  });
}
function jsonRpcError(id, code, message, cors) {
  return json({ jsonrpc: "2.0", id, error: { code, message } }, cors);
}


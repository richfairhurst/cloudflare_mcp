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
      name: env.MCP_SERVER_NAME || "ROSTI_MCP",
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
          name: "get_latest_rosti_reports",
          title: "Get Latest ROSTI Reports",
          description: "Retrieves the latest threat reports from ROSTI API for the past 48 hours.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              source: { 
                type: "string",
                description: "Optional source filter (e.g., 'asec')"
              }
            }
          },
          outputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              data: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    date: { type: "string" },
                    title: { type: "string" },
                    url: { type: "string" },
                    tags: { 
                      type: "array",
                      items: { type: "string" }
                    },
                    source: { type: "object" }
                  }
                }
              },
              meta: { type: "object" }
            },
            required: ["data", "meta"]
          }
        },
        {
          name: "get_rosti_report_by_id",
          title: "Get ROSTI Report by ID",
          description: "Retrieves a specific threat report from ROSTI API by its ID.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              reportId: { 
                type: "string",
                description: "ID of the report to retrieve"
              }
            },
            required: ["reportId"]
          },
          outputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              date: { type: "string" },
              title: { type: "string" },
              url: { type: "string" },
              tags: { 
                type: "array",
                items: { type: "string" }
              },
              source: { type: "object" }
            }
          }
        },
        {
          name: "get_yara_rules_by_rosti_report_id",
          title: "Get YARA Rules by ROSTI Report ID",
          description: "Retrieves YARA rules associated with a specific ROSTI report.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              reportId: { 
                type: "string",
                description: "ID of the report to retrieve YARA rules for"
              }
            },
            required: ["reportId"]
          },
          outputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              data: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    hash: { type: "string" },
                    name: { type: "string" },
                    filename: { type: "string" },
                    rule: { type: "string" }
                  }
                }
              },
              meta: { type: "object" }
            },
            required: ["data", "meta"]
          }
        },
        {
          name: "list_ioc_by_rosti_report_id",
          title: "List IOCs by ROSTI Report ID",
          description: "Retrieves Indicators of Compromise (IOCs) associated with a specific ROSTI report.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              reportId: { 
                type: "string",
                description: "ID of the report to retrieve IOCs for"
              }
            },
            required: ["reportId"]
          },
          outputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              data: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    category: { type: "string" },
                    value: { type: "string" },
                    date: { type: "string" },
                    type: { type: "string" },
                    ids: { type: "boolean" },
                    report: { type: "string" },
                    id: { type: "string" }
                  }
                }
              },
              meta: { type: "object" }
            },
            required: ["data", "meta"]
          }
        }
      ];

      return json({ jsonrpc: "2.0", id, result: { tools } }, cors);
    }

    if (method === "tools/call") {
      const { name, arguments: args = {} } = rpc?.params || {};

      // Helper to make API requests to ROSTI
      async function fetchFromRosti(endpoint) {
        // Check if API key is available
        if (!env.ROSTI_API_KEY) {
          throw new Error("ROSTI API key not set in environment variables");
        }

        const headers = {
          "X-API-Key": env.ROSTI_API_KEY,
          "Content-Type": "application/json"
        };

        const response = await fetch(endpoint, {
          method: "GET",
          headers
        });

        if (!response.ok) {
          throw new Error(`ROSTI API error: ${response.status} ${response.statusText}`);
        }

        return await response.json();
      }

      // Get latest reports from last 48 hours
      if (name === "get_latest_rosti_reports") {
        try {
          // Calculate date for 48 hours ago in YYYY-MM-DD format
          const date = new Date();
          date.setHours(date.getHours() - 48);
          const formattedDate = date.toISOString().split('T')[0]; // YYYY-MM-DD format

          const source = args.source ? `&source=${args.source}` : "";
          const apiUrl = `https://api.rosti.bin.re/v2/reports?after=${formattedDate}${source}`;
          
          const data = await fetchFromRosti(apiUrl);
          
          // Format the response for display
          let contentText = `## Latest ROSTI Reports (after ${formattedDate})\n\n`;
          
          if (data.data && data.data.length > 0) {
            data.data.forEach(report => {
              contentText += `- **${report.title}** (${report.date})\n`;
              contentText += `  - Source: ${report.source.name}\n`;
              contentText += `  - Tags: ${report.tags.join(', ')}\n`;
              contentText += `  - [View Report](${report.url})\n\n`;
            });
          } else {
            contentText += "No reports found for the specified criteria.\n";
          }

          return json({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: contentText }],
              structuredContent: data
            }
          }, cors);
        } catch (error) {
          return jsonRpcError(id, -32000, `Error fetching latest reports: ${error.message}`, cors);
        }
      }

      // Get report by ID
      if (name === "get_rosti_report_by_id") {
        try {
          if (!args.reportId) {
            return jsonRpcError(id, -32602, "Missing required parameter: reportId", cors);
          }
          
          // Get the proper report ID
          let reportId = await getReportIdFromInput(args.reportId, env);

          const apiUrl = `https://api.rosti.bin.re/v2/reports/${reportId}`;
          const data = await fetchFromRosti(apiUrl);
          
          // Format the response for display
          let contentText = `## ROSTI Report: ${data.title}\n\n`;
          contentText += `- **Date**: ${data.date}\n`;
          contentText += `- **Source**: ${data.source.name}\n`;
          contentText += `- **Tags**: ${data.tags.join(', ')}\n`;
          contentText += `- **URL**: ${data.url}\n`;
          
          if (data.count) {
            contentText += `- **IOCs**: ${data.count.iocs}\n`;
            contentText += `- **YARA Rules**: ${data.count.yara_rules}\n`;
            contentText += `- **MITRE ATT&CK**: ${data.count.mitre_ids}\n`;
          }

          return json({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: contentText }],
              structuredContent: data
            }
          }, cors);
        } catch (error) {
          return jsonRpcError(id, -32000, `Error fetching report: ${error.message}`, cors);
        }
      }

      // Get YARA rules by report ID
      if (name === "get_yara_rules_by_rosti_report_id") {
        try {
          if (!args.reportId) {
            return jsonRpcError(id, -32602, "Missing required parameter: reportId", cors);
          }
          
          // Get the proper report ID
          let reportId = await getReportIdFromInput(args.reportId, env);

          const apiUrl = `https://api.rosti.bin.re/v2/reports/${reportId}/yara-rules`;
          const data = await fetchFromRosti(apiUrl);
          
          // Format the response for display
          let contentText = `## YARA Rules for ROSTI Report ID: ${args.reportId}\n\n`;
          
          if (data.data && data.data.length > 0) {
            data.data.forEach((rule, index) => {
              contentText += `### Rule ${index + 1}: ${rule.name}\n`;
              contentText += "```\n";
              contentText += rule.rule;
              contentText += "\n```\n\n";
            });
          } else {
            contentText += "No YARA rules found for this report.\n";
          }

          return json({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: contentText }],
              structuredContent: data
            }
          }, cors);
        } catch (error) {
          return jsonRpcError(id, -32000, `Error fetching YARA rules: ${error.message}`, cors);
        }
      }

      // List IOCs by report ID
      if (name === "list_ioc_by_rosti_report_id") {
        try {
          if (!args.reportId) {
            return jsonRpcError(id, -32602, "Missing required parameter: reportId", cors);
          }
          
          // Get the proper report ID
          let reportId = await getReportIdFromInput(args.reportId, env);

          const apiUrl = `https://api.rosti.bin.re/v2/reports/${reportId}/iocs`;
          const data = await fetchFromRosti(apiUrl);
          
          // Format the response for display
          let contentText = `## IOCs for ROSTI Report ID: ${args.reportId}\n\n`;
          
          if (data.data && data.data.length > 0) {
            // Group IOCs by type
            const iocsByType = {};
            data.data.forEach(ioc => {
              if (!iocsByType[ioc.type]) {
                iocsByType[ioc.type] = [];
              }
              iocsByType[ioc.type].push(ioc);
            });
            
            // Display IOCs grouped by type
            for (const [type, iocs] of Object.entries(iocsByType)) {
              contentText += `### ${type.toUpperCase()} (${iocs.length})\n\n`;
              iocs.forEach(ioc => {
                contentText += `- **${ioc.value}**\n`;
                contentText += `  - Category: ${ioc.category}\n`;
                contentText += `  - Date: ${ioc.date}\n`;
                contentText += `  - ID: ${ioc.id}\n\n`;
              });
            }
          } else {
            contentText += "No IOCs found for this report.\n";
          }

          return json({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: contentText }],
              structuredContent: data
            }
          }, cors);
        } catch (error) {
          return jsonRpcError(id, -32000, `Error fetching IOCs: ${error.message}`, cors);
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

// Helper function to get report ID from URL or direct ID
async function getReportIdFromInput(input, env) {
  // If it's not a URL, assume it's already an ID and return as is
  if (!input || !input.startsWith('http')) {
    return input;
  }
  
  try {
    // Try to lookup the URL in recent reports to get the correct ID
    // Calculate date for recent reports (7 days)
    const date = new Date();
    date.setDate(date.getDate() - 7);
    const formattedDate = date.toISOString().split('T')[0]; // YYYY-MM-DD format
    
    // Fetch recent reports to try to find a match
    const apiUrl = `https://api.rosti.bin.re/v2/reports?after=${formattedDate}`;
    
    // Check if API key is available
    if (!env.ROSTI_API_KEY) {
      throw new Error("ROSTI API key not set in environment variables");
    }

    const headers = {
      "X-API-Key": env.ROSTI_API_KEY,
      "Content-Type": "application/json"
    };

    const response = await fetch(apiUrl, {
      method: "GET",
      headers
    });

    if (!response.ok) {
      throw new Error(`ROSTI API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    // Look for matching URL in recent reports
    if (data.data && data.data.length > 0) {
      const matchingReport = data.data.find(report => report.url === input);
      if (matchingReport && matchingReport.id) {
        console.log(`Found matching report ID: ${matchingReport.id} for URL: ${input}`);
        return matchingReport.id;
      }
    }
    
    // If no match found, fall back to assuming input is already an ID
    console.warn(`Could not find matching report for URL: ${input}, treating as direct ID`);
    return input;
  } catch (error) {
    // If any errors occur, fall back to using the input directly
    console.error("Error looking up report ID:", error);
    return input;
  }
}


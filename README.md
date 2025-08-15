# MCP Servers on Cloudflare


The MCP Specification is based on JSON-RPC, Cloudflare workers support JS/TS, it’s fairly easy to deploy a Cloudflare worker that speaks JSON-RPC.

These examples are pretty bare-bones, your not getting the full MCP spec or functionality, however if all your looking to do is query KV stores or expose an API to your LLM, these work pretty well and you can leverage all the cloudflare infrastructure rather than hosting your own (and if you keep below their daily threshold, for free as well)

Note: these don’t include authentication (which you can add either as a request header or leveraging an OAuth provider).  You may want to add to provide usage limits

At the moment repo contains 3 examples:

1. Personal Daemon / website version - leveraging a KV store to store and retrive information
2. API gateway for ORKL
3. API gateway ROSTI

and some help utils:
1. A basic js template 
2. A template pulling from KV store
3. a python script that converts markdown to json bulk format for upload to KV Store 


To use:

```bash
cd mcp_orkl
bun init -y 
bun add wrangler
// if your using ts version instead of js your'll need to also: 
bun add -d typescript @cloudflare/workers-types
```

Edit src/index.ts (or src.index.js) to your desires and then to test locally:

```bash
bun tsc --noEmit // to type-check your index.ts
bun wrangler dev 
```


 Deploy to cloudflare:
edit wrangler.toml and.or package.json (for ts)
```
wrangler login
wrangler deploy
```

Add to your MCP configuration

```
{
  "mcp": {
    "orkl_api_mcp": {
      "url": "https://orkl_api_mcp.YOUR-SUBDOMAIN.workers.dev",
      "description": "Threat Report Lookup using ORKL API"
    }
  }
}
```
 

### for the KV example:

```
bun wrangler kv namespace create "KV"
```


Paste wrangler’s output into wrangler.toml:
```
name = "mcp-kv-worker"
main = "src/index.ts"
compatibility_date = "2024-11-21"

[[kv_namespaces]]
binding   = "KV"
id        = "<prod-id>"
preview_id = "<preview-id>"

```


convert contents.md to Wrangler bulk JSON array
```
#Top-level sections (default H2):
python3 md_to_kv_bulk.py contents.md kv_bulk.json


#Choose top-level as H1 instead:
python3 md_to_kv_bulk.py contents.md kv_bulk.json --level 1


#Emit subsections as their own KV keys (e.g., how_i_work/leadership_philosophy):
python3 md_to_kv_bulk.py contents.md kv_bulk.json --flatten


#Keep titles verbatim (no slugging):
python3 md_to_kv_bulk.py contents.md kv_bulk.json --no-slug


#Add a prefix to all keys (e.g., profile/...):
python3 md_to_kv_bulk.py contents.md kv_bulk.json --prefix profile


#NDJSON instead of a JSON array:
python3 md_to_kv_bulk.py contents.md kv_bulk.ndjson --ndjson

```

push to KV store:
```
bun wrangler kv bulk put ./kv_bulk.json --binding=KV --remote
# or, if you used NDJSON:
bun wrangler kv bulk put ./kv_bulk.ndjson --binding=KV --remote

```



Verify data landed correctly:
```
   bun wrangler kv key get about_me --binding=KV --remote
```


Deploy the worker:
```
bun wrangler deploy

```

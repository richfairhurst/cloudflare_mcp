# MCP Servers on Cloudflare

The MCP Specification is based on JSON-RPC. Since Cloudflare Workers support JavaScript/TypeScript, it's straightforward to deploy a Cloudflare Worker that speaks JSON-RPC.

These examples are minimalist implementations. While they don't provide the full MCP specification or functionality, they work effectively if you're looking to query KV stores or expose an API to your LLM. You can leverage Cloudflare's infrastructure rather than hosting your own (and potentially stay within their free tier if you remain below their daily threshold).

Note: These examples don't include authentication (which you can add either as a request header or by leveraging an OAuth provider). You may want to add authentication to enforce usage limits.

## Repository Contents

This repository contains 3 example implementations:

1. Personal Daemon / website version - leveraging a KV store to store and retrieve information
2. API gateway for ORKL
3. API gateway for ROSTI

And helpful utilities:

1. A basic JavaScript template 
2. A basic Javascript template with KV store pull
3. A Python script that converts markdown to JSON bulk format for upload to KV Store (which just makes writting source for KV store easier)

## Usage Instructions


Pre-reqs

Bun -  JavaScript runtime, bundler, package manager, and test runner built to replace Node.js and npm with better performance (but any JS runtime will work - for example you could replace the below bun commands with npm). On OSX with homebrew you can just:

```
> brew install bun
```

###  ORKL

#### Setup and Installation

```bash
> cd mcp_orkl
> bun init -y 
> bun add wrangler # Wrangler is Cloudflare’s CLI tool for building and managing serverless apps on their edge network.
```

Edit src/index.js if/as needed, then to test locally:

```bash
> bun wrangler dev 
```

#### Deployment to Cloudflare

Edit wrangler.toml 
```bash
> wrangler login
> wrangler deploy
```

#### Add to your MCP configuration

When you deploy with wrangler deploy it  prints out the URL - it wil be based on your Cloudflare account and what you named the MCP in the wranger.toml. If you didn’t change the name in wrangler.toml the URL will be https://orkl_api_mcp.YOUR-SUBDOMAIN.workers.dev which you can then add to Opecode or ClaudeCode. If you renamed in wrangler.toml then the URL will reflect the name you provided. Below is the config for OpenCode  (opencode.json), but ClaudeCode follows a simular approach, just change “mcp” to be ‘mcpServers”

```json
{
  "mcp": {
    "orkl_api_mcp": {
      "url": "https://orkl_api_mcp.YOUR-SUBDOMAIN.workers.dev",
      "description": "Threat Report Lookup using ORKL API"
    }
  }
}
```




### ROSTI

#### Setup and Installation
Much the same as ORKL the only difference is that RSOTI requires an API key that you can obtain (for free) from https://rosti.bin.re/. We then pass the API key via environmental variable via wrangler.toml. 

```bash
> cd mcp_rosti
> bun init -y 
> bun add wrangler
```

Edit src/index.js to your requirements, then add your ROSTI api key to wrangler.toml

```
name = "rosi_api_mcp"
main = "src/index.js"
compatibility_date = "2024-01-01"

[vars]
MCP_SERVER_NAME = "rosi_api_mcp"
MCP_SERVER_VERSION = "1.0.0"
ROSTI_API_KEY = "your_api_key_here"
```

 then test locally:

```bash
> bun wrangler dev 
```

#### Deployment to Cloudflare

```bash
> wrangler login
> wrangler deploy
```

#### Add to your MCP configuration

```json
{
  "mcp": {
    "orkl_api_mcp": {
      "url": "https://rosti_api_mcp.YOUR-SUBDOMAIN.workers.dev",
      "description": "Threat Report Lookup using ROSTI API"
    }
  }
}
```


### Daemon

#### Setup and Installation
A little more setup involved for this one, since we’re using typescript and setting up and pulling custom content from a LV store

```bash
> cd daemon
> bun init -y 
> bun add wrangler
> bun add -d typescript @cloudflare/workers-types
```

First lets create the content we want to make available, convert it to bulk json, and upload to a KV store. I prefer to write in Markdown and then cover to JSON.

Create a contents.md file and struture the H2 (##) headings as the keys you want for your KV store, then anything underneath that as the data to be returned. For example 

```
## About Me

Hey, I’m Rich Fairhurst
```

then in src/index.ts update the toolKeyMap with those H2 headings:

```ts 
const toolKeyMap = {
  about_me: "about_me",
  professional_certifications : "professional_certifications",
  how_i_work : "how_i_work",
  countries: "countries",
  socials : "socials",
  uses : "uses",
  currently : "currently"
} as const;

```

then run to convert Contents.md to Wrangler Bulk JSON Array

```bash
# Top-level sections (default H2):
> python3 md_to_kv_bulk.py contents.md kv_bulk.json

# Choose top-level as H1 instead:
> python3 md_to_kv_bulk.py contents.md kv_bulk.json --level 1

# Emit subsections as their own KV keys (e.g., how_i_work/leadership_philosophy):
> python3 md_to_kv_bulk.py contents.md kv_bulk.json --flatten

# Keep titles verbatim (no slugging):
> python3 md_to_kv_bulk.py contents.md kv_bulk.json --no-slug

# Add a prefix to all keys (e.g., profile/...):
> python3 md_to_kv_bulk.py contents.md kv_bulk.json --prefix profile

# NDJSON instead of a JSON array:
> python3 md_to_kv_bulk.py contents.md kv_bulk.ndjson --ndjson
```

create your KV instance

```bash 
> bun wrangler kv namespace create "KV"
```

and upload your converted json to the KV store

```bash
> bun wrangler kv bulk put ./kv_bulk.json --binding=KV --remote
```

You’ll be able to see the created store in teh Cloudflare console and validate the key value pairs but you can also confirm via the cli:

```bash 
> bun wrangler kv key get about_me --binding=KV --remote
```

You then need to go back to the wrangler file and update the KV binding id that was provided as output when you created the KV store.

```toml
name = "richfairhurst_mcp"
main = "src/index.ts"
compatibility_date = "2024-11-21"

[[kv_namespaces]]
binding = "KV"
id = "YOUR KV ID"

```

#### Testing
There’s a few more options for testing as the deployment relies on a KV store

```bash
> bun tsc --noEmit # to type-check your index.ts
> bun wrangler dev 
```

Technically when we created and uploaded content to the KV store we went directly to the live online version (via the ‘—remote’ command line flag). If you wanted to keep it all local while testing you can omit the flag and update the wrangler.toml file alone the lines of:

```toml
[env.dev]
kv_namespaces = [
  { binding = "MY_KV", id = "localdev1234567890" }
]
```

and then

``` bash 
> wrangler dev --env dev
```

or to push KV to Cloudflare and use the live instance with you local dev MCP use:

```bash 
> bun wrangler dev --x-remote-bindings
```


#### Deployment to Cloudflare

```bash
> wrangler deploy --env production
```

#### Add to your MCP configuration

```json
{
  "mcp": {
    "orkl_api_mcp": {
      "url": "https://mcp_daemon.YOUR-SUBDOMAIN.workers.dev",
      "description": "Personal Daemon for Jane Done"
    }
  }
}
```

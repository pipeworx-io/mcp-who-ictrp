# @pipeworx/who-ictrp

WHO International Clinical Trials Registry Platform (trialsearch.who.int): one
search across ClinicalTrials.gov and the WHO primary registries (ChiCTR, jRCT,
CTRI, IRCT, DRKS, ANZCTR, ISRCTN, EU CTR/CTIS and more), plus the WHO Trial
Registration Data Set for any one trial. It is the practical way to find
Chinese, Japanese, Indian and Iranian trials next to the rest.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1857+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `ictrp_search({query?, condition?, intervention?, sponsor?, registry?, recruiting_only?, limit?})`
  — trials matching a free-text query (titles, conditions, interventions, with
  WHO synonym expansion) and/or condition / intervention / sponsor fields. Each
  row carries the trial id, the source registry (code and name), recruitment
  status, registration date, whether results are posted and the ICTRP record
  URL. `registry` keeps only one source registry (`ChiCTR`, `CTRI`, `IRCT`,
  `DRKS`, `jRCT`, `CT.gov`, …). A search with no matches returns
  `total_trials: 0` with the query used.
- `ictrp_trial({trial_id})` — the full record for one trial by its registry
  id: source registry and its record URL, titles, primary sponsor, status,
  study type and design, phase, countries of recruitment, conditions,
  interventions, outcomes, eligibility, sample size, dates, funding sources,
  secondary ids, ethics review status. An id ICTRP does not know returns
  `found: false`.

Every response carries `data_as_of` (the time the portal was read). ICTRP
itself refreshes from the registries weekly; `ictrp_trial` returns
`last_refreshed_on` for the record.

Use alongside `clinicaltrials` (the US registry's own API, richer for NCT
trials), `isrctn` and `anzctr`.

## Auth

Keyless.

## Data sources

- <https://trialsearch.who.int/Default.aspx> — free-text search (ASP.NET postback).
- <https://trialsearch.who.int/AdvSearch.aspx> — field search: title, condition, intervention, primary sponsor, recruiting status.
- <https://trialsearch.who.int/Trial2.aspx?TrialID=ChiCTR2400080001> — the public record page for one trial.

The portal has no JSON API. Things the next person would otherwise rediscover:

- **Search is a WebForms postback.** GET the page for its `__VIEWSTATE`,
  `__EVENTVALIDATION` and the `ApplicationGatewayAffinity` cookies, then POST
  the whole form back with `TextBox1` + `Button1=Search` (basic) or the
  `ctl00$ContentPlaceHolder1$txt…` fields + `btnSearch` (advanced). Posting a
  control the page did not render (e.g. a page size on the first POST) fails
  event validation and 302s to `/NoAccess.aspx`.
- **Page size is a second postback.** `__EVENTTARGET=DropDownList1`,
  `DropDownList1=100` (basic) or `ctl00$ContentPlaceHolder1$ddlPageSize`
  (advanced). 100 is the maximum.
- **The advanced search renders no pager**, so a field search returns at most
  the newest 100 trials; the response says so in `note` when there are more.
  The basic search pages with `__EVENTTARGET=GridView1`,
  `__EVENTARGUMENT=Page$N`; with a `registry` filter the tool scans up to 5
  pages (500 trials).
- **The result count wording changes**: "407 records for 385 trials found" vs
  "1 trial found". A record is one registry entry; a trial groups the entries
  that cite each other as secondary ids.
- **Country is not filterable.** The advanced search's country filter is a
  two-step listbox postback and its free-text box did not change the result
  count when tested (stroke: 18,749 records with and without "China"). Use
  `registry` for China/Japan/India/Iran, or `ictrp_trial`'s `countries`.
- **The XML/CSV export is not used.** It sits behind an "I agree" to terms
  that restrict commercial use of the downloaded data; this pack only reads
  the public result and record pages.
- An unknown trial id answers HTTP 200 with the empty record template.
- Records include contact persons (names, addresses, phone numbers, emails),
  including the ethics committee's contact. The tool does not return them.
- Edge-probed 2026-10-09 from a throwaway `wrangler dev --remote` Worker:
  GET 200, search POST 200 ("407 records for 385 trials found for:
  psilocybin"), record page 200. No bot challenge on any of the three.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "who-ictrp": {
      "url": "https://gateway.pipeworx.io/who-ictrp/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/who-ictrp/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1857+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ictrp_search \
  -H 'Content-Type: application/json' \
  -d '{"condition":"stroke","registry":"ChiCTR","limit":10}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ictrp_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-who-ictrp` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/who-ictrp/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "who-ictrp": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-who-ictrp"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Who Ictrp data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities$shared(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities$shared(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * WHO ICTRP — the International Clinical Trials Registry Platform search
 * portal (trialsearch.who.int). One search across the WHO primary registries
 * and ClinicalTrials.gov: ChiCTR (China), jRCT/JPRN (Japan), CTRI (India),
 * IRCT (Iran), DRKS (Germany), ANZCTR, ISRCTN, EU CTR/CTIS, CRIS (Korea),
 * ReBec (Brazil), PACTR (Africa), TCTR (Thailand) and more. For most Chinese,
 * Japanese, Indian and Iranian trials it is the only place they can be found
 * in English alongside the rest.
 *
 * The portal has no JSON API. Its search is an ASP.NET postback on
 * Default.aspx (free text) and AdvSearch.aspx (condition / intervention /
 * sponsor / recruiting), and each trial has a public page at
 * Trial2.aspx?TrialID=<id>. Both are parsed here. The portal also offers an
 * XML/CSV export of a result set, but only after the caller clicks "I agree"
 * to terms that restrict commercial use, so it is deliberately NOT used.
 *
 * Contact persons (names, phone numbers, email addresses) are on the trial
 * page but deliberately not returned, including the ethics committee's
 * contact; sponsors and funders are organisations and are.
 *
 * Tools:
 * - ictrp_search: trials matching a free-text query and/or condition,
 *                 intervention, sponsor, recruiting status, source registry
 * - ictrp_trial:  the WHO Trial Registration Data Set for one trial id
 */


const UA = 'pipeworx-mcp-who-ictrp/1.0 (+https://pipeworx.io)';
const UPSTREAM = 'WHO ICTRP';
const ORIGIN = 'https://trialsearch.who.int';
const SOURCE = 'WHO International Clinical Trials Registry Platform (trialsearch.who.int)';

/* ── Registries, keyed by trial-id prefix ─────────────────────────────── */

const REGISTRIES: { prefix: RegExp; code: string; name: string }[] = [
  { prefix: /^NCT\d/i, code: 'CT.gov', name: 'ClinicalTrials.gov (United States)' },
  { prefix: /^ACTRN/i, code: 'ANZCTR', name: 'Australian New Zealand Clinical Trials Registry' },
  { prefix: /^ChiCTR/i, code: 'ChiCTR', name: 'Chinese Clinical Trial Registry' },
  { prefix: /^ITMCTR/i, code: 'ITMCTR', name: 'International Traditional Medicine Clinical Trial Registry (China)' },
  { prefix: /^CTRI/i, code: 'CTRI', name: 'Clinical Trials Registry - India' },
  { prefix: /^IRCT/i, code: 'IRCT', name: 'Iranian Registry of Clinical Trials' },
  { prefix: /^DRKS/i, code: 'DRKS', name: 'German Clinical Trials Register' },
  { prefix: /^jRCT/i, code: 'jRCT', name: 'Japan Registry of Clinical Trials' },
  { prefix: /^JPRN/i, code: 'JPRN', name: 'Japan Primary Registries Network' },
  { prefix: /^ISRCTN/i, code: 'ISRCTN', name: 'ISRCTN registry (United Kingdom)' },
  { prefix: /^EUCTR/i, code: 'EU-CTR', name: 'EU Clinical Trials Register' },
  { prefix: /^CTIS/i, code: 'CTIS', name: 'EU Clinical Trials Information System' },
  { prefix: /^KCT/i, code: 'CRIS', name: 'Clinical Research Information Service (Republic of Korea)' },
  { prefix: /^TCTR/i, code: 'TCTR', name: 'Thai Clinical Trials Registry' },
  { prefix: /^PACTR/i, code: 'PACTR', name: 'Pan African Clinical Trial Registry' },
  { prefix: /^RBR-/i, code: 'ReBec', name: 'Brazilian Clinical Trials Registry' },
  { prefix: /^LBCTR/i, code: 'LBCTR', name: 'Lebanese Clinical Trials Registry' },
  { prefix: /^(NL|NTR)\d/i, code: 'NL-OMON', name: 'Netherlands Trial Register / Overview of Medical Research in the Netherlands' },
  { prefix: /^PER-/i, code: 'REPEC', name: 'Peruvian Clinical Trial Registry' },
  { prefix: /^SLCTR/i, code: 'SLCTR', name: 'Sri Lanka Clinical Trials Registry' },
  { prefix: /^RPCEC/i, code: 'RPCEC', name: 'Cuban Public Registry of Clinical Trials' },
];

function registryFor(trialId: string): { code: string; name: string } {
  const r = REGISTRIES.find((x) => x.prefix.test(trialId));
  return r ? { code: r.code, name: r.name } : { code: 'other', name: 'Other WHO primary registry' };
}

/** "chictr", "ChiCTR", "clinicaltrials.gov", "CT.gov", "nct" → the registry code, or undefined. */
function normalizeRegistry(v: string): string | undefined {
  const k = v.trim().toLowerCase().replace(/[\s_]/g, '');
  if (!k) return undefined;
  const aliases: Record<string, string> = {
    'ct.gov': 'CT.gov', ctgov: 'CT.gov', nct: 'CT.gov', clinicaltrials: 'CT.gov', 'clinicaltrials.gov': 'CT.gov',
    'eu-ctr': 'EU-CTR', euctr: 'EU-CTR', kct: 'CRIS', rbr: 'ReBec', nl: 'NL-OMON', ntr: 'NL-OMON', 'nl-omon': 'NL-OMON',
    actrn: 'ANZCTR', per: 'REPEC',
  };
  if (aliases[k]) return aliases[k];
  return REGISTRIES.find((r) => r.code.toLowerCase() === k)?.code;
}

/* ── HTTP with a cookie jar (the postback needs the session cookie) ───── */

class Session {
  private jar = new Map<string, string>();

  async get(path: string): Promise<{ status: number; location: string | null; text: string }> {
    return this.send(path, { method: 'GET' });
  }

  async post(path: string, form: Record<string, string>): Promise<{ status: number; location: string | null; text: string }> {
    return this.send(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
  }

  private async send(path: string, init: RequestInit): Promise<{ status: number; location: string | null; text: string }> {
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const headers: Record<string, string> = {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      ...((init.headers as Record<string, string>) ?? {}),
    };
    if (cookie) headers.Cookie = cookie;
    const res = await fetchWithTimeout(new URL(path, `${ORIGIN}/`).toString(), { ...init, redirect: 'manual', headers }, UPSTREAM, 30_000);
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    const setCookies = typeof h.getSetCookie === 'function' ? h.getSetCookie() : (res.headers.get('set-cookie') ?? '').split(/,(?=\s*[A-Za-z0-9_.-]+=)/);
    for (const c of setCookies) {
      const kv = c.split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) this.jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  }
}

/* ── HTML helpers ─────────────────────────────────────────────────────── */

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function toText(fragment: string): string {
  return decodeEntities(fragment.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function clean(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/** Every successful control in the form, as the browser would submit it (submit buttons excluded). */
function serializeForm(page: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of page.matchAll(/<input\b([^>]*)>/g)) {
    const attrs = m[1];
    const name = /name="([^"]+)"/.exec(attrs)?.[1];
    if (!name) continue;
    const type = (/type="([^"]+)"/.exec(attrs)?.[1] ?? 'text').toLowerCase();
    const value = decodeEntities(/value="([^"]*)"/.exec(attrs)?.[1] ?? '');
    if (type === 'hidden' || type === 'text') out[decodeEntities(name)] = value;
    else if ((type === 'checkbox' || type === 'radio') && /\bchecked\b/.test(attrs)) out[decodeEntities(name)] = value || 'on';
  }
  for (const m of page.matchAll(/<select\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const selected = /<option[^>]*selected="selected"[^>]*value="([^"]*)"/.exec(m[2]);
    if (selected) out[decodeEntities(m[1])] = decodeEntities(selected[1]);
  }
  return out;
}

/* ── Search ───────────────────────────────────────────────────────────── */

interface SearchRow {
  trial_id: string;
  registry: string;
  registry_name: string;
  public_title?: string;
  recruitment_status?: string;
  date_registered?: string;
  retrospective_registration?: boolean;
  results_available?: boolean;
  ictrp_url: string;
}

/** Result grid rows: Recruitment status | Retrospective | Main ID | (panel) | Public title | Date of registration | Results. */
function parseGrid(page: string): SearchRow[] {
  const rows: SearchRow[] = [];
  const seen = new Set<string>();
  for (const tr of page.matchAll(/<tr valign="top"[^>]*>([\s\S]*?)<\/tr>/g)) {
    const link = /href="Trial2\.aspx\?TrialID=([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(tr[1]);
    if (!link) continue;
    const trialId = decodeEntities(link[1]).trim();
    if (seen.has(trialId)) continue;
    seen.add(trialId);
    const cells = [...tr[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
    const status = clean(toText(cells[0] ?? ''));
    const retro = clean(toText(cells[1] ?? ''));
    const date = clean(toText(cells[cells.length - 2] ?? ''));
    const results = clean(toText(cells[cells.length - 1] ?? ''));
    const reg = registryFor(trialId);
    rows.push({
      trial_id: trialId,
      registry: reg.code,
      registry_name: reg.name,
      public_title: clean(toText(link[2]))?.replace(/\n/g, ' '),
      recruitment_status: status,
      date_registered: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : date,
      retrospective_registration: retro ? /retro/i.test(retro) : undefined,
      results_available: results ? /yes/i.test(results) : undefined,
      ictrp_url: `${ORIGIN}/Trial2.aspx?TrialID=${encodeURIComponent(trialId)}`,
    });
  }
  return rows;
}

function totalCount(page: string): { records?: number; trials?: number } {
  // "407 records for 385 trials found", or "1 trial found" when every trial has one record.
  const m = /(?:([\d,]+) records? for )?([\d,]+) trials? found/.exec(page);
  if (!m) return {};
  const trials = Number(m[2].replace(/,/g, ''));
  return { records: m[1] ? Number(m[1].replace(/,/g, '')) : trials, trials };
}

function isNoResults(page: string): boolean {
  return /No results? (were )?found|0 records for 0 trials|There are no records/i.test(page);
}

function assertResults(where: string, r: { status: number; location: string | null; text: string }): void {
  if (r.status !== 200) {
    throw new Error(`${UPSTREAM} ${where} returned HTTP ${r.status}${r.location ? ` → ${r.location}` : ''}`);
  }
}

/** Free-text search on Default.aspx: 100 rows per page, paged with the grid's own postback. */
async function basicSearch(query: string, wantRows: number, maxPages: number, keep: (r: SearchRow) => boolean) {
  const s = new Session();
  const home = await s.get('/Default.aspx');
  assertResults('search page', home);
  const form = serializeForm(home.text);
  if (!('__VIEWSTATE' in form)) throw new Error(`upstream_parse: ${UPSTREAM} search page has no ASP.NET form state — a bot challenge or a layout change.`);
  form.TextBox1 = query;
  form.Button1 = 'Search';
  let page = await s.post('/Default.aspx', form);
  assertResults('search', page);
  const counts = totalCount(page.text);
  if (counts.records === undefined) {
    if (isNoResults(page.text) || !/GridView1/.test(page.text)) return { counts: { records: 0, trials: 0 }, rows: [], scanned: 0 };
    throw new Error(`upstream_parse: ${UPSTREAM} search for "${query}" returned a page with no result count — a layout change.`);
  }
  // Switch the grid to 100 rows per page (the portal's maximum).
  const f2 = serializeForm(page.text);
  f2.__EVENTTARGET = 'DropDownList1';
  f2.__EVENTARGUMENT = '';
  f2.DropDownList1 = '100';
  page = await s.post('/Default.aspx', f2);
  assertResults('search (page size)', page);
  const out: SearchRow[] = [];
  let scanned = 0;
  for (let p = 1; p <= maxPages; p++) {
    if (p > 1) {
      const fp = serializeForm(page.text);
      fp.__EVENTTARGET = 'GridView1';
      fp.__EVENTARGUMENT = `Page$${p}`;
      page = await s.post('/Default.aspx', fp);
      assertResults(`search (page ${p})`, page);
    }
    const rows = parseGrid(page.text);
    scanned += rows.length;
    for (const r of rows) if (keep(r) && !out.some((o) => o.trial_id === r.trial_id)) out.push(r);
    if (out.length >= wantRows || rows.length < 90 || scanned >= (counts.trials ?? 0)) break;
  }
  return { counts, rows: out, scanned };
}

const ADV = 'ctl00$ContentPlaceHolder1$';

/** Field search on AdvSearch.aspx. The portal shows at most 100 rows here (newest first) and renders no pager. */
async function advancedSearch(fields: { title?: string; condition?: string; intervention?: string; sponsor?: string; recruitingOnly?: boolean }) {
  const s = new Session();
  const blank = await s.get('/AdvSearch.aspx');
  assertResults('advanced search page', blank);
  const form = serializeForm(blank.text);
  if (!('__VIEWSTATE' in form)) throw new Error(`upstream_parse: ${UPSTREAM} advanced search page has no ASP.NET form state — a bot challenge or a layout change.`);
  form[`${ADV}txtTitle`] = fields.title ?? '';
  form[`${ADV}txtCondition`] = fields.condition ?? '';
  form[`${ADV}txtIntervention`] = fields.intervention ?? '';
  form[`${ADV}txtPrimarySponsor`] = fields.sponsor ?? '';
  form[`${ADV}ddlRecruitingStatus`] = fields.recruitingOnly ? '1' : 'ALL';
  form[`${ADV}btnSearch`] = 'Search';
  let page = await s.post('/AdvSearch.aspx', form);
  assertResults('advanced search', page);
  const counts = totalCount(page.text);
  if (counts.records === undefined) {
    if (isNoResults(page.text) || !/GridViewSearch/.test(page.text)) return { counts: { records: 0, trials: 0 }, rows: [] as SearchRow[] };
    throw new Error(`upstream_parse: ${UPSTREAM} advanced search returned a page with no result count — a layout change.`);
  }
  const f2 = serializeForm(page.text);
  f2.__EVENTTARGET = `${ADV}ddlPageSize`;
  f2.__EVENTARGUMENT = '';
  f2[`${ADV}ddlPageSize`] = '100';
  page = await s.post('/AdvSearch.aspx', f2);
  assertResults('advanced search (page size)', page);
  return { counts, rows: parseGrid(page.text) };
}

/* ── Single trial ─────────────────────────────────────────────────────── */

function spanText(page: string, id: string): string | undefined {
  const m = new RegExp(`<span id="${id}"[^>]*>([\\s\\S]*?)</span>`).exec(page);
  return m ? clean(toText(m[1])) : undefined;
}

/** All values of a DataList item label, across its rows (DataListN_ctlNN_<label>). */
function listValues(page: string, list: string, label: string): string[] {
  const out: string[] = [];
  for (const m of page.matchAll(new RegExp(`<span id="${list}_ctl\\d+_${label}"[^>]*>([\\s\\S]*?)</span>`, 'g'))) {
    const v = clean(toText(m[1]));
    if (v) out.push(v);
  }
  return out;
}

/** "Strabismus;Amblyopia" or line-separated → array. */
function splitList(values: string[]): string[] {
  return values
    .flatMap((v) => v.split(/\n|;/))
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseTrial(page: string, trialId: string) {
  const f = (label: string) => spanText(page, `DataList3_ctl01_${label}`);
  const reg = registryFor(trialId);
  const sourceUrl = /<a id="DataList3_ctl01_HyperLink12" href="([^"]+)"/.exec(page)?.[1];
  const ethics = [...page.matchAll(/<span id="DataList5_ctl(\d+)_Label2001"[^>]*>([\s\S]*?)<\/span>/g)].map((m) => {
    const n = m[1];
    const v = (l: string) => spanText(page, `DataList5_ctl${n}_${l}`);
    // Label2003..2006 are the ethics committee's contact person, address, phone and email — not returned.
    return { status: clean(toText(m[2])), approval_date: v('Label2002') };
  }).filter((e) => e.status || e.approval_date);
  const minAge = spanText(page, 'DataList6_ctl01_Label8');
  const maxAge = spanText(page, 'DataList6_ctl01_Label11');
  return {
    trial_id: trialId,
    registry: reg.code,
    registry_name: reg.name,
    source_register: f('DescriptionLabel'),
    source_url: sourceUrl ? decodeEntities(sourceUrl) : undefined,
    ictrp_url: `${ORIGIN}/Trial2.aspx?TrialID=${encodeURIComponent(trialId)}`,
    last_refreshed_on: f('Last_updatedLabel'),
    date_registered: f('Date_registrationLabel'),
    prospective_registration: f('Label1'),
    public_title: f('Public_titleLabel')?.replace(/\n/g, ' '),
    scientific_title: f('Scientific_titleLabel')?.replace(/\n/g, ' '),
    acronym: f('AcronymLabel'),
    primary_sponsor: f('Primary_sponsorLabel'),
    date_first_enrolment: f('Date_enrollementLabel'),
    target_sample_size: f('Target_sizeLabel'),
    recruitment_status: f('Recruitment_statusLabel'),
    study_type: f('Study_typeLabel'),
    study_design: f('Study_designLabel'),
    allocation: f('AllocationLabel'),
    assignment: f('AssignementLabel'),
    phase: f('PhaseLabel'),
    countries: splitList(listValues(page, 'DataList2', 'Country_Label')),
    conditions: splitList(listValues(page, 'DataList8', 'Condition_FreeTextLabel')),
    interventions: splitList(listValues(page, 'DataList10', 'Intervention_FreeTextLabel')),
    primary_outcomes: splitList(listValues(page, 'DataList12', 'Outcome_NameLabel')),
    secondary_outcomes: splitList(listValues(page, 'DataList14', 'Outcome_NameLabel')),
    eligibility: {
      inclusion_criteria: spanText(page, 'DataList6_ctl01_Inclusion_criteriaLabel'),
      exclusion_criteria: spanText(page, 'DataList6_ctl01_Exclusion_criteriaLabel'),
      min_age: minAge,
      max_age: maxAge,
      sex: spanText(page, 'DataList6_ctl01_Label12'),
    },
    secondary_ids: splitList(listValues(page, 'DataList16', 'SecondaryIDLabel')),
    funding_sources: splitList(listValues(page, 'DataList18', 'Source_NameLabel')),
    ethics_review: ethics,
  };
}

/* ── Tools ────────────────────────────────────────────────────────────── */

const REGISTRY_CODES = REGISTRIES.map((r) => r.code).join(', ');

const tools: McpToolExport['tools'] = [
  {
    name: 'ictrp_search',
    description:
      'Search the WHO International Clinical Trials Registry Platform — one search across ClinicalTrials.gov and the WHO primary registries (ChiCTR China, jRCT/JPRN Japan, CTRI India, IRCT Iran, DRKS Germany, ANZCTR, ISRCTN, EU CTR/CTIS, CRIS Korea, ReBec Brazil, PACTR, TCTR and more). The way to find Chinese, Japanese, Indian and Iranian trials that ClinicalTrials.gov does not carry. Give a free-text query (searches titles, conditions and interventions, with WHO synonym expansion) and/or condition / intervention / sponsor fields; filter by source registry or recruiting status. Each row carries the trial id, its source registry, recruitment status, registration date and the ICTRP record URL — call ictrp_trial for the full record.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Free text, e.g. "psilocybin" or "psilocybin depression". With condition/intervention/sponsor it is matched against the trial TITLE only.' },
        condition: { type: 'string', description: 'Health condition, e.g. "stroke", "type 2 diabetes".' },
        intervention: { type: 'string', description: 'Intervention or drug, e.g. "metformin", "acupuncture".' },
        sponsor: { type: 'string', description: 'Primary sponsor name, e.g. "Fudan University".' },
        registry: { type: 'string', description: `Keep only trials from one source registry: ${REGISTRY_CODES}. Matched on the trial-id prefix.` },
        recruiting_only: { type: 'boolean', description: 'Only trials whose status is Recruiting.' },
        limit: { type: 'number', description: 'Rows to return, 1-100 (default 25).' },
      },
    },
  },
  {
    name: 'ictrp_trial',
    description:
      'The WHO Trial Registration Data Set for one trial from any registry the WHO ICTRP covers, by its registry id (e.g. "ChiCTR2400080001", "CTRI/2024/01/061234", "IRCT20230101056789N1", "DRKS00031234", "jRCT2031230001", "NCT06123456", "ACTRN12626001215314"): source registry and its record URL, titles, primary sponsor, recruitment status, study type and design, phase, countries of recruitment, conditions, interventions, primary and secondary outcomes, eligibility (criteria, age range, sex), target sample size, dates, funding sources, secondary ids, ethics review status. Contact-person details are not returned.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        trial_id: { type: 'string', description: 'Registry trial id as the source registry writes it, e.g. "ChiCTR2400080001".' },
      },
      required: ['trial_id'],
    },
  },
];

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const dataAsOf = new Date().toISOString();
  switch (name) {
    case 'ictrp_search': {
      const query = str(args.query);
      const condition = str(args.condition);
      const intervention = str(args.intervention);
      const sponsor = str(args.sponsor);
      const recruitingOnly = args.recruiting_only === true;
      const registryArg = str(args.registry);
      const limit = Math.min(100, Math.max(1, Math.floor(Number(args.limit ?? 25)) || 25));
      if (!query && !condition && !intervention && !sponsor) {
        throw new Error('ictrp_search: give at least one of query, condition, intervention or sponsor.');
      }
      const registry = registryArg ? normalizeRegistry(registryArg) : undefined;
      if (registryArg && !registry) {
        throw new Error(`ictrp_search: "${registryArg}" is not a registry this tool knows. Use one of: ${REGISTRY_CODES}.`);
      }
      const keep = (r: SearchRow) => (!registry || r.registry === registry);
      const usedQuery: Record<string, unknown> = { query, condition, intervention, sponsor, registry, recruiting_only: recruitingOnly || undefined };

      let counts: { records?: number; trials?: number };
      let rows: SearchRow[];
      let scanned: number;
      let note: string | undefined;
      if (!condition && !intervention && !sponsor && !recruitingOnly) {
        const r = await basicSearch(query!, limit, registry ? 5 : Math.ceil(limit / 100), keep);
        counts = r.counts;
        rows = r.rows;
        scanned = r.scanned;
        if (registry && rows.length < limit && scanned < (counts.trials ?? 0)) {
          note = `The registry filter is applied to the newest ${scanned} of ${counts.trials} matching trials; narrow the query to reach older ${registry} trials.`;
        }
      } else {
        const r = await advancedSearch({ title: query, condition, intervention, sponsor, recruitingOnly });
        counts = r.counts;
        rows = r.rows.filter(keep);
        scanned = r.rows.length;
        if ((counts.trials ?? 0) > scanned) {
          note = `The portal returns at most the newest ${scanned} of ${counts.trials} matching trials for a field search${registry ? `; the ${registry} filter is applied to those` : ''}.`;
        }
        if (query) usedQuery.query_matched_against = 'title';
      }
      const out = rows.slice(0, limit);
      const registriesInResults = [...new Set(out.map((r) => r.registry))];
      return {
        query: usedQuery,
        total_records: counts.records ?? 0,
        total_trials: counts.trials ?? 0,
        returned: out.length,
        registries_in_results: registriesInResults,
        ...(out.length === 0
          ? { message: registry && (counts.trials ?? 0) > 0
              ? scanned >= (counts.trials ?? 0)
                ? `ICTRP found ${counts.trials} trials, none from ${registry}.`
                : `ICTRP found ${counts.trials} trials, none from ${registry} among the ${scanned} newest.`
              : 'ICTRP found no trials for this search.' }
          : {}),
        ...(note ? { note } : {}),
        trials: out,
        source: SOURCE,
        data_as_of: dataAsOf,
      };
    }

    case 'ictrp_trial': {
      const id = str(args.trial_id);
      if (!id || id.length > 60 || !/^[A-Za-z][\w./-]*$/.test(id)) {
        throw new Error(`ictrp_trial: "${String(args.trial_id ?? '')}" is not a trial id — pass the registry's id, e.g. "ChiCTR2400080001" or "NCT06123456".`);
      }
      const s = new Session();
      const res = await s.get(`/Trial2.aspx?TrialID=${encodeURIComponent(id)}`);
      assertResults(`trial page for ${id}`, res);
      const shown = spanText(res.text, 'DataList3_ctl01_TrialIDLabel');
      if (!shown) {
        // An unknown id renders the empty record template (section headings, no data rows).
        if (/Countries of recruitment/.test(res.text) && /ICTRP Search Portal/.test(res.text)) {
          return { found: false, trial_id: id, message: `WHO ICTRP has no record for "${id}".`, source: SOURCE, data_as_of: dataAsOf };
        }
        throw new Error(`upstream_parse: ${UPSTREAM} trial page for ${id} (HTTP 200, ${res.text.length} chars) has no trial-id field — a bot challenge or a layout change.`);
      }
      return { found: true, ...parseTrial(res.text, shown), source: SOURCE, data_as_of: dataAsOf };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;

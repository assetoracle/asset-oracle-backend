import dns from "node:dns/promises";
import tls from "node:tls";

const host = "api.gdeltproject.org";
const startIso = "2026-11-06T12:23:11.813Z";
const endIso = "2026-11-07T12:23:11.813Z";
const start = Date.parse(startIso);
const end = Date.parse(endIso);

function errorDetails(error) {
  const details = [];
  let current = error;
  for (let depth = 0; current && depth < 4; depth++, current = current.cause) {
    details.push({
      name: current.name,
      message: current.message,
      code: current.code,
      syscall: current.syscall,
      hostname: current.hostname,
      address: current.address,
      port: current.port,
    });
  }
  return details;
}

async function probeTls() {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port: 443, servername: host, timeout: 10000 });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.once("secureConnect", () => finish({
      ok: true,
      authorized: socket.authorized,
      authorizationError: socket.authorizationError ?? null,
      protocol: socket.getProtocol(),
      cipher: socket.getCipher()?.name ?? null,
    }));
    socket.once("timeout", () => finish({ ok: false, error: "TLS handshake timed out after 10 seconds" }));
    socket.once("error", (error) => finish({ ok: false, errors: errorDetails(error) }));
  });
}

function formatGdeltTime(value) {
  return new Date(value).toISOString().slice(0, 19).replace(/[-:T]/g, "");
}

async function main() {
  console.log("READ-ONLY GDELT CONNECTIVITY DIAGNOSTIC");
  console.log(JSON.stringify({ host, startIso, endIso, databaseWrites: false }, null, 2));

  try {
    const addresses = await dns.lookup(host, { all: true, verbatim: true });
    console.log("DNS_RESULT " + JSON.stringify({ ok: true, addresses }));
  } catch (error) {
    console.log("DNS_RESULT " + JSON.stringify({ ok: false, errors: errorDetails(error) }));
  }

  console.log("TLS_RESULT " + JSON.stringify(await probeTls()));

  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  url.searchParams.set("query", '"Nigeria" flood');
  url.searchParams.set("mode", "ArtList");
  url.searchParams.set("format", "json");
  url.searchParams.set("maxrecords", "25");
  url.searchParams.set("sort", "DateDesc");
  url.searchParams.set("startdatetime", formatGdeltTime(start));
  url.searchParams.set("enddatetime", formatGdeltTime(end));

  const beganAt = new Date().toISOString();
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "AssetOracle-readonly-diagnostic/1.0" },
      signal: AbortSignal.timeout(20000),
    });
    const body = await response.text();
    const result = {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get("content-type"),
      retryAfter: response.headers.get("retry-after"),
      elapsedMs: Date.now() - Date.parse(beganAt),
      bodyPreview: body.slice(0, 400).replace(/[\r\n\t]+/g, " "),
    };
    if (response.ok) {
      try {
        const parsed = JSON.parse(body);
        const articles = Array.isArray(parsed.articles) ? parsed.articles : [];
        const inWindow = articles.filter((article) => {
          const stamp = article?.seendate;
          if (typeof stamp !== "string" || !/^\d{8}T\d{6}Z$/.test(stamp)) return false;
          const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
          const timestamp = Date.parse(iso);
          return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end;
        });
        result.articleCount = articles.length;
        result.inWindowCount = inWindow.length;
        result.samples = inWindow.slice(0, 5).map((article) => ({
          seendate: article.seendate ?? null,
          title: article.title ?? null,
          domain: article.domain ?? null,
          sourcecountry: article.sourcecountry ?? null,
          url: article.url ?? null,
        }));
      } catch (error) {
        result.jsonParseError = error.message;
      }
    }
    console.log("HTTP_RESULT " + JSON.stringify(result));
  } catch (error) {
    console.log("HTTP_RESULT " + JSON.stringify({
      ok: false,
      elapsedMs: Date.now() - Date.parse(beganAt),
      errors: errorDetails(error),
    }));
  }
}

await main();

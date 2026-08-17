// TEMPORARY read-only diagnostic endpoint. Delete after use.
//
// Purpose: confirm the authenticated Barsy mechanism and read back the two ids
// the pickup checkout needs — the "наложен платеж" paymethod_id and the barsy_id
// of MOTAMO SHOP (Каравелов 101). It calls ONLY list/read actions; it can never
// create an order.
//
// Auth mechanism (from the Lukanet PHP client, src/BarsyApiClient.php):
//   POST {host}/endpoints/json?bid={barsy_id}
//   ClientAuthorization: Basic base64(user:pass)     <- default auth_type
//   Authorization:       Basic base64(user:pass)     <- auth_type "user"
//   body: {"<Action_name>": { ...params }}
// Both header names are tried here because the client picks between them by
// option and we don't know which one this tenant expects.

const READ_ONLY_ACTIONS = [
  { name: "ping", params: {} },
  { name: "Paymentmethods_getlist", params: {} },
  { name: "Barsys_getlist", params: {} },
  { name: "Depots_getlist", params: { filters: {} } }
];

const AUTH_HEADERS = ["ClientAuthorization", "Authorization"];

function endpoint(host, barsyId) {
  const base = String(host).replace(/\/+$/, "");
  return `${base}/endpoints/json?bid=${encodeURIComponent(barsyId)}`;
}

async function callBarsy(url, headerName, credentials, action) {
  const headers = {
    "Content-Type": "application/json; charset=UTF-8",
    Accept: "application/json, text/plain, */*"
  };
  headers[headerName] = `Basic ${credentials}`;

  const res = await fetch(url, {
    method: "POST",
    headers: headers,
    body: JSON.stringify({ [action.name]: action.params })
  });

  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    parsed = null;
  }

  return {
    status: res.status,
    ok: res.ok,
    // Raw text is capped so an HTML error page can be recognised without
    // dumping a whole document into the response.
    body: parsed !== null ? parsed : text.slice(0, 600)
  };
}

module.exports = async function handler(req, res) {
  const host = process.env.BARSY_HOST;
  const user = process.env.BARSY_USER;
  const pass = process.env.BARSY_PASS;
  const barsyId = process.env.BARSY_ID;

  const missing = [];
  if (!host) missing.push("BARSY_HOST");
  if (!user) missing.push("BARSY_USER");
  if (!pass) missing.push("BARSY_PASS");
  if (!barsyId) missing.push("BARSY_ID");

  if (missing.length) {
    res.status(500).json({ error: "Missing environment variables", missing: missing });
    return;
  }

  const url = endpoint(host, barsyId);
  const credentials = Buffer.from(`${user}:${pass}`).toString("base64");

  const report = { endpoint: url, barsy_id: barsyId, attempts: {} };

  for (const headerName of AUTH_HEADERS) {
    const results = {};
    for (const action of READ_ONLY_ACTIONS) {
      try {
        results[action.name] = await callBarsy(url, headerName, credentials, action);
      } catch (err) {
        results[action.name] = { error: err.message };
      }
    }
    report.attempts[headerName] = results;

    // If this header name authenticated, the other one adds nothing.
    const authed = Object.values(results).some(function (r) {
      return r.ok === true;
    });
    if (authed) {
      report.working_auth_header = headerName;
      break;
    }
  }

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(report);
};

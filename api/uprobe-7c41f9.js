// TEMPORARY. Delete immediately after use.
//
// Settles one question: do the stored BARSY_USER / BARSY_PASS work as a *user*
// login against the real tenant host, using the documented authenticated shape
// (action in the URL path, bare params as the body)?
//
// Established without credentials beforehand:
//   motamoshop.barsy.online/endpoints/json/<Action>  -> "Missing User Authorization"
//   motamoshop.barsyonline.menu/...                  -> "Missing Client Authorization"
// So the two hosts authenticate different identities; the staff login belongs to
// the .barsy.online one. Everything before this probe was aimed at the wrong host.
//
// Safety, since this sits on a public URL while it exists:
//   * read-only lookup actions only, hard-coded — no way to ask it for anything else
//   * self-expires, and refuses after a handful of calls
//   * returns Barsy's status and message only; never the credentials

const HOST = "https://motamoshop.barsy.online";
const BARSY_ID = 1;

// Config lookups with no business side effects. Deliberately not a list the
// caller can influence.
const SAFE_ACTIONS = ["Languages_getlistdata", "Currencies_getcurrent"];

const EXPIRES_AT = Date.UTC(2026, 7, 17, 23, 0, 0); // 2026-08-17 23:00 UTC
const MAX_CALLS = 6;

let calls = 0;

async function call(action, user, pass) {
  const url = `${HOST}/endpoints/json/${action}?bid=${BARSY_ID}`;
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json; charset=UTF-8"
      },
      body: JSON.stringify({}),
      signal: controller.signal
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      parsed = null;
    }
    return {
      action: action,
      status: res.status,
      ok: res.ok,
      // Enough to tell success from failure without dumping the tenant's data.
      body: parsed !== null ? JSON.stringify(parsed).slice(0, 300) : text.slice(0, 300)
    };
  } catch (err) {
    return { action: action, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (Date.now() > EXPIRES_AT) {
    res.status(410).json({ error: "probe expired" });
    return;
  }
  if (++calls > MAX_CALLS) {
    res.status(429).json({ error: "probe call limit reached" });
    return;
  }

  const user = process.env.BARSY_USER;
  const pass = process.env.BARSY_PASS;
  if (!user || !pass) {
    res.status(500).json({ error: "BARSY_USER / BARSY_PASS not set" });
    return;
  }

  const results = [];
  for (const action of SAFE_ACTIONS) {
    results.push(await call(action, user, pass));
  }

  res.status(200).json({ host: HOST, results: results });
};

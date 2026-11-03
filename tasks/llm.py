# Тънка обвивка към Anthropic Messages API (ключът е GitHub secret ANTHROPIC_API_KEY). python llm.py ping
import json, sys, urllib.request, urllib.error
from lib import env

MODEL_SMART = "claude-sonnet-5-5"
MODEL_CHEAP = "claude-haiku-5-5"


def ask(user, system="", model=MODEL_SMART, max_tokens=2000, images=None, timeout=120):
    """images: списък от (media_type, base64). Връща текста на отговора; при грешка вдига RuntimeError с кратка причина."""
    key = env("ANTHROPIC_API_KEY")
    if not key:
        raise RuntimeError("липсва ANTHROPIC_API_KEY")
    content = [{"type": "image", "source": {"type": "base64", "media_type": m, "data": d}} for m, d in (images or [])]
    content.append({"type": "text", "text": user})
    body = {"model": model, "max_tokens": max_tokens, "messages": [{"role": "user", "content": content}]}
    if system:
        body["system"] = system
    rq = urllib.request.Request("https://api.anthropic.com/v1/messages", json.dumps(body).encode(),
                                {"content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01"})
    try:
        d = json.load(urllib.request.urlopen(rq, timeout=timeout))
    except urllib.error.HTTPError as e:
        try:
            msg = json.load(e).get("error", {}).get("message", "")
        except Exception:
            msg = ""
        raise RuntimeError("Anthropic %s: %s" % (e.code, msg[:160]))
    u = d.get("usage") or {}
    print("(токени: вход %s, изход %s)" % (u.get("input_tokens"), u.get("output_tokens")), file=sys.stderr)
    return "".join(b.get("text", "") for b in d.get("content", []) if b.get("type") == "text").strip()


if __name__ == "__main__" and "ping" in sys.argv:
    print(ask("Отговори само с думата: готово", model=MODEL_CHEAP, max_tokens=20))

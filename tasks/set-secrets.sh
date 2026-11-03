#!/bin/bash
# Качва 3-те ключа от компютъра в GitHub secrets (еднократно). Стойностите не се печатат.
cd "$(dirname "$0")/.." || exit 1
for k in PEEK_TOKEN TELEGRAM_BOT_TOKEN TELEGRAM_OWNER_CHAT_ID; do
  v=$(grep "^$k=" "$HOME/.claude/motamo-tokens.env" | head -1 | cut -d= -f2- | tr -d '\r')
  if [ -n "$v" ] && printf %s "$v" | gh secret set "$k" >/dev/null 2>&1; then echo "$k — качен"; else echo "$k — ГРЕШКА"; fi
done

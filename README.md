# Itachi OTP Forwarder

This script calls the CR API endpoint and forwards OTP-only data to your Telegram bot every 30 seconds.

## Required environment variables

- `CRAPI_TOKEN` - API token used in `http://147.135.212.197/crapi/had/viewstats`
- `TELEGRAM_BOT_TOKEN` - Telegram bot token
- `TELEGRAM_CHAT_IDS` - comma-separated Telegram chat/user/channel IDs where OTP should be sent (for example: `-10012345,987654321`)

## Optional environment variables

- `CRAPI_URL` (default: `http://147.135.212.197/crapi/had/viewstats`)
- `CRAPI_DT1`
- `CRAPI_DT2`
- `CRAPI_RECORDS`
- `CRAPI_FILTERNUM`
- `CRAPI_FILTERCLI`
- `TELEGRAM_CHAT_ID` (legacy single chat ID fallback when `TELEGRAM_CHAT_IDS` is not provided)

## Run

```bash
npm start
```

The script:
1. Calls the CR API with your token and optional filters
2. Extracts OTP-related values from the response when available
3. Sends only OTP values to one or more Telegram chat IDs
4. Repeats automatically every 30 seconds

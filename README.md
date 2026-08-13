# Itachi OTP Forwarder

This script calls the CR API endpoint and forwards OTP-related response data to your Telegram bot.

## Required environment variables

- `CRAPI_TOKEN` - API token used in `http://147.135.212.197/crapi/had/viewstats`
- `TELEGRAM_BOT_TOKEN` - Telegram bot token
- `TELEGRAM_CHAT_ID` - Telegram chat/user/channel ID where message should be sent

## Optional environment variables

- `CRAPI_URL` (default: `http://147.135.212.197/crapi/had/viewstats`)
- `CRAPI_DT1`
- `CRAPI_DT2`
- `CRAPI_RECORDS`
- `CRAPI_FILTERNUM`
- `CRAPI_FILTERCLI`

## Run

```bash
npm start
```

The script:
1. Calls the CR API with your token and optional filters
2. Extracts OTP-related values from the response when available
3. Sends the OTP summary + response snippet to Telegram

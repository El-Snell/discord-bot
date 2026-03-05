# Discord Mirror Bot (GitHub Actions)

This repo runs a Discord mirror bot via GitHub Actions.

## IMPORTANT SECURITY
- Do NOT commit your Discord bot token.
- Store it in GitHub Secrets.

## Setup
1) Add secrets in your repo:
- BOT_TOKEN = Discord bot token
- CLIENT_ID = Discord Application ID

2) Enable **Message Content Intent** in the Discord Developer Portal for your bot.

3) Run once:
- Actions tab -> `discord-mirror-bot` -> Run workflow

## Commands (in Discord)
- /config set source:#channel-a target:#channel-b
- /config show
- /pause
- /resume

## Limits
GitHub-hosted runners have a hard job runtime limit (commonly 6 hours), so the workflow restarts periodically.

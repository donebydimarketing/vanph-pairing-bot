# VANPH Pairing Bot

Discord bot that:
1. DMs new server members asking for their portal email, then links their Discord account to their Supabase `members` or `clients` record.
2. Exposes a `/create-channel` webhook endpoint that Supabase can call to automatically create a private Discord channel for a confirmed pairing.

## Deploy to Railway

1. Go to https://railway.app and sign in (GitHub login is easiest)
2. Click **New Project** → **Deploy from GitHub repo** (push this folder to a new GitHub repo first), or **Empty Project** → then drag/upload these files
3. Once deployed, go to your project's **Variables** tab and add:

| Variable | Value |
|---|---|
| `DISCORD_BOT_TOKEN` | Your bot token (same one saved in Supabase) |
| `DISCORD_GUILD_ID` | `1518044112492957716` |
| `SUPABASE_URL` | Your main VA Newbies Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (Settings → API in Supabase — NOT the anon key, the bot needs write access) |
| `WEBHOOK_SECRET` | Make up any long random string — this protects your `/create-channel` endpoint from random requests |

4. Railway will auto-detect `npm start` from `package.json` and deploy
5. Once live, copy your Railway app's public URL (looks like `https://your-app.up.railway.app`)

## Add two columns in Supabase

Run this in the SQL Editor (main VA Newbies project):

```sql
ALTER TABLE members ADD COLUMN IF NOT EXISTS discord_user_id text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS discord_user_id text;
ALTER TABLE pairings ADD COLUMN IF NOT EXISTS discord_channel_id text;
```

## Set up the Supabase Database Webhook

This is what tells the bot "a pairing was just agreed, go make a channel."

1. In Supabase, go to **Database** → **Webhooks** → **Create a new webhook**
2. Name: `pairing-agreed-discord`
3. Table: `pairings`
4. Events: `Update`
5. Conditions (if available): only fire when `status` changes to `agreed` — otherwise we filter this inside the bot's endpoint instead
6. HTTP Request: `POST` to `https://your-app.up.railway.app/create-channel`
7. HTTP Headers: add `x-webhook-secret` = the same value you set as `WEBHOOK_SECRET` in Railway
8. Payload: Supabase sends the full row by default — you'll want to add a small SQL function or Edge Function in between to shape the payload into:

```json
{
  "pairingId": "...",
  "clientDiscordId": "...",
  "vaDiscordId": "...",
  "clientName": "...",
  "vaName": "..."
}
```

The simplest way to do this shaping is a lightweight Supabase Edge Function that receives the webhook, looks up the client's and VA's `discord_user_id` and names from their respective tables, and forwards a clean payload to the bot's `/create-channel` endpoint. Ask Claude to write this Edge Function next — it's a short one.

## Testing the email-linking flow

1. Have a test Discord account join your server
2. Bot should DM automatically asking for an email
3. Reply with an email that exists in `members` or `clients`
4. Check Supabase — that row should now have `discord_user_id` filled in

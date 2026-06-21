// Small HTTP server alongside the bot.
// Supabase calls this endpoint (via a Database Webhook) whenever a pairing's
// status changes to 'agreed', so the bot can create the private channel.

const express = require('express');
const { createPairingChannel, login } = require('./index.js');

login();

const app = express();
app.use(express.json());

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET; // shared secret so random people can't hit this endpoint

app.post('/create-channel', async (req, res) => {
  // Basic auth check
  const providedSecret = req.headers['x-webhook-secret'];
  if (!WEBHOOK_SECRET || providedSecret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { pairingId, clientDiscordId, vaDiscordId, clientName, vaName } = req.body;

  if (!pairingId) {
    return res.status(400).json({ error: 'pairingId is required' });
  }

  if (!clientDiscordId && !vaDiscordId) {
    return res.status(200).json({ skipped: true, reason: 'Neither client nor VA has linked Discord yet.' });
  }

  try {
    const channelId = await createPairingChannel({ pairingId, clientDiscordId, vaDiscordId, clientName, vaName });
    res.json({ success: true, channelId });
  } catch (err) {
    console.error('Failed to create pairing channel:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook server listening on port ${PORT}`));

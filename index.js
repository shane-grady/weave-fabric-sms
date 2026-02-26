import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Linq API helpers ──────────────────────────────────────────────
const LINQ_API_KEY = process.env.LINQ_API_KEY;
const LINQ_BASE = "https://api.linq.ai/v3";
const LINQ_SIGNING_SECRET = process.env.LINQ_SIGNING_SECRET;

async function linqFetch(path, opts = {}) {
  const res = await fetch(`${LINQ_BASE}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINQ_API_KEY}`,
      ...opts.headers,
    },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) {
    console.error(`[Linq] ${opts.method || "GET"} ${path} → ${res.status}`, data);
  }
  return { status: res.status, data };
}

// ── Send SMS via Linq ─────────────────────────────────────────────
async function sendSMS(chatId, text) {
  console.log(`[SMS] Sending to chat ${chatId}: ${text.substring(0, 100)}...`);
  const { status, data } = await linqFetch(`/chats/${chatId}/messages`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
  if (status >= 200 && status < 300) {
    console.log(`[SMS] Sent successfully`);
  } else {
    console.error(`[SMS] Failed to send:`, data);
  }
  return { status, data };
}

// ── Claude conversation ───────────────────────────────────────────
const SYSTEM_PROMPT = `You are Weave — a warm, wise AI companion created by Inner Explorer.
You help people with mindfulness, emotional wellness, and personal growth through SMS.
Keep responses concise (under 320 chars when possible) since this is SMS.
Be warm, supportive, and practical. Use simple language.
If someone seems distressed, be empathetic and suggest professional resources when appropriate.`;

// Simple in-memory conversation store (keyed by chat ID)
const conversations = new Map();
const MAX_HISTORY = 20;

async function getClaudeResponse(chatId, userMessage) {
  // Get or create conversation history
  if (!conversations.has(chatId)) {
    conversations.set(chatId, []);
  }
  const history = conversations.get(chatId);
  history.push({ role: "user", content: userMessage });

  // Keep history manageable
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: history,
    });

    const assistantMessage =
      response.content[0]?.text || "I'm here for you. How can I help?";
    history.push({ role: "assistant", content: assistantMessage });

    return assistantMessage;
  } catch (err) {
    console.error("[Claude] Error:", err.message);
    return "I'm having a moment — please try again shortly 🙏";
  }
}

// ── Webhook signature verification ────────────────────────────────
function verifyLinqSignature(req) {
  if (!LINQ_SIGNING_SECRET) return true; // skip if not configured

  const signature = req.headers["x-linq-signature"] || req.headers["x-signature"];
  if (!signature) {
    console.warn("[Webhook] No signature header found");
    return true; // allow through for now while we figure out header name
  }

  const payload = JSON.stringify(req.body);
  const expected = crypto
    .createHmac("sha256", LINQ_SIGNING_SECRET)
    .update(payload)
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}

// ── Parse Linq v3 webhook payload ─────────────────────────────────
function parseLinqWebhook(body) {
  // Linq v3 webhook format:
  // {
  //   "event_type": "message.received",
  //   "data": {
  //     "chat": { "id": "...", "owner_handle": { "handle": "+16504417752" } },
  //     "message": { "text": "...", "sender_handle": { "handle": "+13107023224" } }
  //   }
  // }

  const eventType = body.event_type;
  const data = body.data || {};
  const chat = data.chat || {};
  const message = data.message || {};

  // Extract chat ID
  const chatId = chat.id || data.chat_id;

  // Extract sender phone - try multiple paths
  const senderHandle = message.sender_handle || message.sender || {};
  const senderPhone = senderHandle.handle || senderHandle.phone || null;

  // Extract message text - try multiple paths
  const messageText = message.text || message.body || message.content || null;

  // Check if the sender is "me" (our number) - skip those
  const isFromMe = senderHandle.is_me === true;

  // Also check owner_handle
  const ownerHandle = chat.owner_handle || {};
  const ownerPhone = ownerHandle.handle || null;

  return {
    eventType,
    chatId,
    senderPhone,
    messageText,
    isFromMe,
    ownerPhone,
    isGroup: chat.is_group || false,
    raw: data,
  };
}

// ── Webhook endpoint ──────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  // Log full payload for debugging (increased limit)
  const fullPayload = JSON.stringify(req.body);
  console.log(`[Webhook] Received (${fullPayload.length} chars):`);
  // Log in chunks to avoid truncation
  for (let i = 0; i < fullPayload.length; i += 1000) {
    console.log(`[Webhook] payload[${i}]: ${fullPayload.substring(i, i + 1000)}`);
  }

  // Signature check
  if (!verifyLinqSignature(req)) {
    console.warn("[Webhook] Invalid signature");
    return res.status(401).json({ error: "Invalid signature" });
  }

  // Parse the v3 webhook
  const parsed = parseLinqWebhook(req.body);
  console.log(`[Webhook] Parsed: event=${parsed.eventType}, chat=${parsed.chatId}, sender=${parsed.senderPhone}, isFromMe=${parsed.isFromMe}, text=${parsed.messageText?.substring(0, 50)}`);

  // Only process message.received events
  if (parsed.eventType !== "message.received") {
    console.log(`[Webhook] Ignoring event type: ${parsed.eventType}`);
    return res.json({ status: "ignored", reason: "not a message event" });
  }

  // Skip messages from ourselves
  if (parsed.isFromMe) {
    console.log(`[Webhook] Ignoring message from self`);
    return res.json({ status: "ignored", reason: "message from self" });
  }

  // Need chat ID and message text at minimum
  if (!parsed.chatId || !parsed.messageText) {
    console.warn(`[Webhook] Missing chatId or messageText. chatId=${parsed.chatId}, text=${parsed.messageText}`);
    return res.json({ status: "skipped", reason: "missing chat ID or message text" });
  }

  console.log(`[SMS] From ${parsed.senderPhone || "unknown"}: ${parsed.messageText}`);

  // Get Claude response and send it back
  try {
    const reply = await getClaudeResponse(parsed.chatId, parsed.messageText);
    await sendSMS(parsed.chatId, reply);
    console.log(`[SMS] Reply sent to chat ${parsed.chatId}`);
  } catch (err) {
    console.error("[Webhook] Error processing message:", err);
  }

  res.json({ status: "ok" });
});

// ── Health check ──────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "weave-fabric-sms",
    version: "0.2.0",
    timestamp: new Date().toISOString(),
  });
});

// ── Start server ──────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`[Server] Weave Fabric SMS running on port ${PORT}`));

import express from "express";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// ── Config ──────────────────────────────────────────────────────────
const {
  PORT = 3000,
  LINQ_API_TOKEN,
  LINQ_FROM_NUMBER,
  LINQ_SIGNING_SECRET,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  ANTHROPIC_API_KEY,
} = process.env;

const LINQ_BASE = "https://api.linqapp.com/api/partner";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── In-memory caches ────────────────────────────────────────────────
const mcpClients = new Map();   // phone → MCP Client
const chatIdCache = new Map();  // phone → LINQ chatId

async function getMcpClient(phoneNumber, mcpUrl) {
  if (mcpClients.has(phoneNumber)) return mcpClients.get(phoneNumber);

  const client = new Client({ name: "sms-memory-bot", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  await client.connect(transport);
  mcpClients.set(phoneNumber, client);
  return client;
}

async function disconnectMcpClient(phoneNumber) {
  const client = mcpClients.get(phoneNumber);
  if (client) {
    try { await client.close(); } catch {}
    mcpClients.delete(phoneNumber);
  }
}

// ── Startup config validation ────────────────────────────────────────
console.log("[Config] LINQ_API_TOKEN set:", !!LINQ_API_TOKEN, "length:", LINQ_API_TOKEN?.length);
console.log("[Config] LINQ_FROM_NUMBER set:", !!LINQ_FROM_NUMBER, "value:", LINQ_FROM_NUMBER);
console.log("[Config] SUPABASE_URL set:", !!SUPABASE_URL);
console.log("[Config] ANTHROPIC_API_KEY set:", !!ANTHROPIC_API_KEY);

// ── LINQ helpers ────────────────────────────────────────────────────
// LINQ v3 API uses two steps:
//   1. Create a chat:  POST /v3/chats  → returns { data: { id: chatId } }
//   2. Send a message:  POST /v3/chats/{chatId}/messages

function linqHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${LINQ_API_TOKEN?.trim()}`,
  };
}

async function getOrCreateChat(to) {
  // Return cached chatId if we have one
  if (chatIdCache.has(to)) {
    console.log(`[LINQ] Using cached chatId for ${to}: ${chatIdCache.get(to)}`);
    return chatIdCache.get(to);
  }

  // Create a new chat
  const url = `${LINQ_BASE}/v3/chats`;
  const body = {
    handles: [LINQ_FROM_NUMBER, to],
    service: "sms",
  };

  console.log(`[LINQ] Creating chat: POST ${url}`);
  console.log(`[LINQ] Body:`, JSON.stringify(body));

  const res = await fetch(url, {
    method: "POST",
    headers: linqHeaders(),
    body: JSON.stringify(body),
  });

  const responseText = await res.text();
  if (!res.ok) {
    console.error("[LINQ create chat error]", res.status, responseText);
    throw new Error(`Failed to create chat: ${res.status} ${responseText}`);
  }

  const parsed = JSON.parse(responseText);
  const chatId = parsed?.data?.id || parsed?.id;
  if (!chatId) {
    console.error("[LINQ] No chatId in response:", responseText);
    throw new Error("No chatId returned from LINQ");
  }

  console.log(`[LINQ] Created chat ${chatId} for ${to}`);
  chatIdCache.set(to, chatId);
  return chatId;
}

async function sendSms(to, text, chatId) {
  try {
    // Use provided chatId, or get/create one
    const resolvedChatId = chatId || await getOrCreateChat(to);

    // Cache it for future use
    if (!chatIdCache.has(to)) {
      chatIdCache.set(to, resolvedChatId);
    }

    const url = `${LINQ_BASE}/v3/chats/${resolvedChatId}/messages`;
    const body = {
      parts: [{ type: "text", value: text }],
      sender_handle: LINQ_FROM_NUMBER,
    };

    console.log(`[sendSms] POST ${url}`);
    console.log(`[sendSms] Body:`, JSON.stringify(body).substring(0, 200));

    const res = await fetch(url, {
      method: "POST",
      headers: linqHeaders(),
      body: JSON.stringify(body),
    });

    const responseText = await res.text();
    if (!res.ok) {
      console.error("[LINQ send error]", res.status, responseText);

      // If chat not found, clear cache and retry once
      if (res.status === 404 && chatIdCache.has(to)) {
        console.log("[sendSms] Chat not found, clearing cache and retrying...");
        chatIdCache.delete(to);
        return sendSms(to, text); // retry without chatId
      }
    } else {
      console.log("[LINQ send success]", res.status, responseText.substring(0, 200));
    }
    return res;
  } catch (err) {
    console.error("[sendSms] Error:", err.message);
    throw err;
  }
}

function verifyWebhook(signature, timestamp, rawBody) {
  if (!LINQ_SIGNING_SECRET) return true; // skip if not configured yet
  const expected = crypto
    .createHmac("sha256", LINQ_SIGNING_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(signature || ""),
    Buffer.from(expected)
  );
}

// ── Supabase helpers ────────────────────────────────────────────────
async function getUser(phone) {
  const { data } = await supabase
    .from("sms_users")
    .select("*")
    .eq("phone_number", phone)
    .single();
  return data;
}

async function createUser(phone) {
  const { data, error } = await supabase
    .from("sms_users")
    .insert({ phone_number: phone, status: "awaiting_mcp_url" })
    .select()
    .single();
  if (error) console.error("[createUser]", error);
  return data;
}

async function activateUser(phone, mcpUrl) {
  await supabase
    .from("sms_users")
    .update({ status: "active", mcp_url: mcpUrl, last_active_at: new Date().toISOString() })
    .eq("phone_number", phone);
}

async function touchUser(phone) {
  await supabase
    .from("sms_users")
    .update({ last_active_at: new Date().toISOString() })
    .eq("phone_number", phone);
}

async function getConversationHistory(phone, limit = 20) {
  const { data } = await supabase
    .from("sms_conversations")
    .select("role, content")
    .eq("phone_number", phone)
    .order("created_at", { ascending: true })
    .limit(limit);
  return data || [];
}

async function saveMessage(phone, role, content) {
  await supabase
    .from("sms_conversations")
    .insert({ phone_number: phone, role, content });
}

// ── Claude + MCP tool execution ─────────────────────────────────────
const SYSTEM_PROMPT = `You are a helpful memory assistant available via SMS. You help users save, search, and manage their personal memories using the Weave memory system.

Keep responses concise and SMS-friendly (under 300 chars when possible). Be warm and conversational.

When a user wants to save something, use the weave_create_memory tool. When they want to find something, use weave_list_memories with a query. When they want to delete something, use weave_forget_memory. When they want to chat with their memories or ask questions about what they've saved, use weave_chat.

If a tool call fails, let the user know briefly and suggest they try again.`;

async function handleActiveUser(phone, mcpUrl, userMessage, chatId) {
  // Connect to user's MCP and discover tools
  let mcpClient;
  try {
    mcpClient = await getMcpClient(phone, mcpUrl);
  } catch (err) {
    console.error("[MCP connect error]", err.message);
    await sendSms(phone, "Having trouble connecting to your memory service. Please check your MCP URL and try again. Text 'reset' to update your URL.", chatId);
    return;
  }

  // Discover available MCP tools
  let mcpTools;
  try {
    const toolsResult = await mcpClient.listTools();
    mcpTools = toolsResult.tools || [];
  } catch (err) {
    console.error("[MCP listTools error]", err.message);
    await disconnectMcpClient(phone);
    await sendSms(phone, "Couldn't reach your memory service. Try again in a moment.", chatId);
    return;
  }

  // Convert MCP tools to Claude tool format
  const claudeTools = mcpTools.map((t) => ({
    name: t.name,
    description: t.description || "",
    input_schema: t.inputSchema || { type: "object", properties: {} },
  }));

  // Load conversation history
  const history = await getConversationHistory(phone);
  await saveMessage(phone, "user", userMessage);

  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userMessage },
  ];

  // Call Claude with tool use loop
  let response;
  try {
    response = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: claudeTools,
      messages,
    });
  } catch (err) {
    console.error("[Claude API error]", err.message);
    await sendSms(phone, "Something went wrong processing your message. Try again!", chatId);
    return;
  }

  // Tool use loop - keep going until we get a final text response
  while (response.stop_reason === "tool_use") {
    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
    const toolResults = [];

    for (const toolUse of toolUseBlocks) {
      console.log(`[Tool call] ${toolUse.name}`, JSON.stringify(toolUse.input));
      try {
        const result = await mcpClient.callTool({
          name: toolUse.name,
          arguments: toolUse.input,
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(result.content),
        });
      } catch (err) {
        console.error(`[Tool error] ${toolUse.name}:`, err.message);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Error: ${err.message}`,
          is_error: true,
        });
      }
    }

    // Continue the conversation with tool results
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });

    try {
      response = await anthropic.messages.create({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: claudeTools,
        messages,
      });
    } catch (err) {
      console.error("[Claude API error in tool loop]", err.message);
      await sendSms(phone, "Something went wrong. Try again!", chatId);
      return;
    }
  }

  // Extract final text response
  const textBlocks = response.content.filter((b) => b.type === "text");
  const reply = textBlocks.map((b) => b.text).join("\n") || "Done!";

  await saveMessage(phone, "assistant", reply);
  await touchUser(phone);

  // Split long messages for SMS (160 char segments, but LINQ handles this)
  await sendSms(phone, reply, chatId);
}

// ── Express server ──────────────────────────────────────────────────
const app = express();

// We need raw body for webhook verification
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);

// Health check
app.get("/", (_req, res) => res.json({ status: "ok", service: "sms-memory-bot" }));

// Diagnostic endpoint — checks LINQ API connectivity
app.get("/diag", async (_req, res) => {
  const token = LINQ_API_TOKEN?.trim();
  const results = {
    env: {
      LINQ_API_TOKEN: token ? `${token.substring(0, 8)}...${token.substring(token.length - 4)} (len=${token.length})` : "NOT SET",
      LINQ_FROM_NUMBER: LINQ_FROM_NUMBER || "NOT SET",
      SUPABASE_URL: SUPABASE_URL ? "SET" : "NOT SET",
      ANTHROPIC_API_KEY: ANTHROPIC_API_KEY ? "SET" : "NOT SET",
    },
    linq_test: null,
  };

  // Test LINQ v3 two-step: create chat then show chatId
  try {
    const chatBody = { handles: [LINQ_FROM_NUMBER, LINQ_FROM_NUMBER], service: "sms" };
    const chatRes = await fetch(`${LINQ_BASE}/v3/chats`, {
      method: "POST",
      headers: linqHeaders(),
      body: JSON.stringify(chatBody),
    });
    const chatText = await chatRes.text();
    const chatParsed = chatRes.ok ? JSON.parse(chatText) : null;
    const chatId = chatParsed?.data?.id || chatParsed?.id || null;
    results.linq_test = {
      create_chat_status: chatRes.status,
      chat_id: chatId,
      auth_ok: chatRes.status !== 401,
      body_preview: chatText.substring(0, 300),
    };
  } catch (err) {
    results.linq_test = { error: err.message };
  }

  res.json(results);
});

// LINQ webhook endpoint
app.post("/webhook", async (req, res) => {
  try {
    // Log full payload for debugging (chunked to avoid truncation)
    const fullPayload = JSON.stringify(req.body);
    console.log(`[Webhook] Received (${fullPayload.length} chars):`);
    for (let i = 0; i < fullPayload.length; i += 1000) {
      console.log(`[Webhook] payload[${i}]: ${fullPayload.substring(i, i + 1000)}`);
    }

    const signature = req.headers["x-webhook-signature"] || req.headers["x-linq-signature"];
    const timestamp = req.headers["x-webhook-timestamp"];

    // Verify signature
    if (LINQ_SIGNING_SECRET && !verifyWebhook(signature, timestamp, req.rawBody)) {
      console.warn("[Webhook] Invalid signature");
      return res.status(401).json({ error: "Invalid signature" });
    }

    const { event_type, data } = req.body;

    // Only handle inbound messages
    if (event_type !== "message.received") {
      console.log(`[Webhook] Ignoring event: ${event_type}`);
      return res.json({ ok: true });
    }

    // ── Parse Linq v3 payload ──
    // v3 nests data under data.chat and data.message
    const chat = data?.chat || {};
    const message = data?.message || data || {};
    const chatId = chat.id || data?.chat_id;

    // Extract sender phone — try v3 nested paths then legacy
    const senderHandle = message.sender_handle || message.sender || {};
    const fromPhone = senderHandle.handle || data?.from?.handle;

    // Skip messages from ourselves
    if (senderHandle.is_me === true) {
      console.log(`[Webhook] Ignoring message from self`);
      return res.json({ ok: true });
    }

    // Extract message text — try v3 paths then legacy parts array
    let userMessage;
    if (message.text) {
      userMessage = message.text.trim();
    } else if (message.body) {
      userMessage = message.body.trim();
    } else {
      // Legacy: parts array format
      const parts = data?.parts || message?.parts || [];
      const textPart = parts.find((p) => p.type === "text");
      userMessage = textPart?.value?.trim();
    }

    // Cache the chatId from this webhook so replies go to the right chat
    if (chatId && fromPhone) {
      chatIdCache.set(fromPhone, chatId);
      console.log(`[Webhook] Cached chatId ${chatId} for ${fromPhone}`);
    }

    console.log(`[Webhook] Parsed: chat=${chatId}, from=${fromPhone}, text=${userMessage?.substring(0, 80)}`);

    if (!userMessage || !fromPhone) {
      console.warn("[Webhook] Missing message or sender phone");
      return res.json({ ok: true });
    }

    console.log(`[Message] From ${fromPhone}: ${userMessage}`);

    // Respond to webhook immediately, process async
    res.json({ ok: true });

    // Handle the message
    let user = await getUser(fromPhone);

    // ── New user ──
    if (!user) {
      user = await createUser(fromPhone);
      await sendSms(
        fromPhone,
        "Welcome to Weave Memory Bot! \ud83e\udde0\n\nTo get started, please send me your Weave MCP URL. You can find it in your Weave settings.\n\nIt looks like: https://mcp.weave.cloud/sse?key=...",
        chatId
      );
      return;
    }

    // ── Awaiting MCP URL ──
    if (user.status === "awaiting_mcp_url") {
      const url = userMessage.trim();

      // Basic URL validation
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        await sendSms(
          fromPhone,
          "That doesn't look like a URL. Please send your Weave MCP URL (starts with https://)",
          chatId
        );
        return;
      }

      // Try connecting to validate
      try {
        const testClient = new Client({ name: "sms-memory-bot-test", version: "1.0.0" });
        const testTransport = new StreamableHTTPClientTransport(new URL(url));
        await testClient.connect(testTransport);
        const { tools } = await testClient.listTools();
        await testClient.close();

        await activateUser(fromPhone, url);
        await sendSms(
          fromPhone,
          `Connected! Found ${tools.length} memory tools. \ud83c\udf89\n\nYou can now:\n\u2022 Save memories: "Remember that my wifi password is abc123"\n\u2022 Search: "What's my wifi password?"\n\u2022 Chat: "What do I know about recipes?"\n\nText 'reset' anytime to update your MCP URL.`,
          chatId
        );
      } catch (err) {
        console.error("[MCP validation error]", err.message);
        await sendSms(
          fromPhone,
          "Couldn't connect to that MCP URL. Please double-check it and try again.\n\nMake sure it's your full Weave MCP URL.",
          chatId
        );
      }
      return;
    }

    // ── Active user ──
    if (user.status === "active") {
      // Handle reset command
      if (userMessage.toLowerCase() === "reset") {
        await disconnectMcpClient(fromPhone);
        await supabase
          .from("sms_users")
          .update({ status: "awaiting_mcp_url", mcp_url: null })
          .eq("phone_number", fromPhone);
        await sendSms(fromPhone, "MCP connection reset. Please send your new Weave MCP URL.", chatId);
        return;
      }

      await handleActiveUser(fromPhone, user.mcp_url, userMessage, chatId);
    }
  } catch (err) {
    console.error("[Webhook handler error]", err);
    if (!res.headersSent) res.status(500).json({ error: "Internal error" });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`SMS Memory Bot running on port ${PORT}`);
});

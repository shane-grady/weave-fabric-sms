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

async function getOrCreateChat(to, initialText) {
  // Return cached chatId if we have one
  if (chatIdCache.has(to)) {
    console.log(`[LINQ] Using cached chatId for ${to}: ${chatIdCache.get(to)}`);
    return chatIdCache.get(to);
  }

  // Create a new chat (LINQ v3 uses "message" not "initial_message")
  const url = `${LINQ_BASE}/v3/chats`;
  const body = {
    from: LINQ_FROM_NUMBER,
    to: [to],
    message: {
      parts: [{ type: "text", value: initialText || "Hello" }],
    },
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
  const chatId = parsed?.chat?.id || parsed?.data?.id || parsed?.id;
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
      message: { parts: [{ type: "text", value: text }] },
      service: "sms",
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
  if (!LINQ_SIGNING_SECRET) return true;
  const expected = crypto
    .createHmac("sha256", LINQ_SIGNING_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  const sig = signature || "";
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// ── URL extraction helper ───────────────────────────────────────────
// Extracts the first http/https URL from a message that may contain
// surrounding text (e.g. "This is my MCP URL: https://example.com")
function extractUrl(text) {
  const match = text.match(/https?:\/\/[^\s]+/i);
  return match ? match[0] : null;
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

async function getConversationHistory(phone, limit = 30) {
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
const SYSTEM_PROMPT = `You're a chill memory sidekick over text. You help people save, find, and manage their stuff using Weave.

Keep it short — this is SMS, not email. Be friendly and natural, like texting a friend.

Tool strategy:
- Saving something new → weave_create_memory
- Any question about their memories ("what do I know about...", "do I have...", "find my...") → ALWAYS use weave_chat first. It does deep semantic search and is the best way to find relevant stuff even if the wording doesn't match exactly.
- Browsing or listing all memories → weave_list_memories with pageSize: 100. If the response shows more pages exist (hasMore: true), keep calling with page: 2, 3, etc. until you have everything.
- Deleting something → weave_forget_memory

CRITICAL: NEVER tell someone you couldn't find anything or that there are no related memories without trying BOTH weave_chat AND weave_list_memories. Always exhaust both tools before saying nothing was found. False negatives are the worst experience — when in doubt, dig deeper.

If a tool errors out, just let them know and suggest trying again.`;

async function handleActiveUser(phone, mcpUrl, userMessage, chatId) {
  // Connect to user's MCP and discover tools
  let mcpClient;
  try {
    mcpClient = await getMcpClient(phone, mcpUrl);
  } catch (err) {
    console.error("[MCP connect error]", err.message);
    await sendSms(phone, "Having trouble reaching your memories right now. Try again in a moment, or text /reset to reconnect with a new MCP URL.", chatId);
    return;
  }

  // Discover available MCP tools (with cursor pagination)
  let mcpTools = [];
  try {
    const params = {};
    do {
      const { tools = [], nextCursor } = await mcpClient.listTools(params);
      mcpTools.push(...tools);
      params.cursor = nextCursor;
    } while (params.cursor);
  } catch (err) {
    // Connection may be stale — reconnect once
    console.error("[MCP listTools error]", err.message, "— reconnecting");
    await disconnectMcpClient(phone);
    try {
      mcpClient = await getMcpClient(phone, mcpUrl);
      const { tools = [] } = await mcpClient.listTools();
      mcpTools = tools;
    } catch (retryErr) {
      console.error("[MCP reconnect failed]", retryErr.message);
      await sendSms(phone, "Couldn't reach your memories right now. Try again in a sec!", chatId);
      return;
    }
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
    await sendSms(phone, "Oops, something hiccuped on my end. Try sending that again!", chatId);
    return;
  }

  // Tool use loop — keep going until we get a final text response
  const MAX_TOOL_ROUNDS = 10;
  let toolRound = 0;
  while (response.stop_reason === "tool_use" && toolRound++ < MAX_TOOL_ROUNDS) {
    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");

    const toolResults = await Promise.all(
      toolUseBlocks.map(async (toolUse) => {
        console.log(`[Tool call] ${toolUse.name}`, JSON.stringify(toolUse.input));
        try {
          const result = await mcpClient.callTool({
            name: toolUse.name,
            arguments: toolUse.input,
          });
          return {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify(result.content),
          };
        } catch (err) {
          console.error(`[Tool error] ${toolUse.name}:`, err.message);
          return {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `Error: ${err.message}`,
            is_error: true,
          };
        }
      })
    );

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
      await sendSms(phone, "Oops, something hiccuped. Try sending that again!", chatId);
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
app.get("/", (_req, res) => res.json({ status: "ok", service: "sms-memory-bot", version: "v6-from-to" }));

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
    const chatBody = {
      from: LINQ_FROM_NUMBER,
      to: [LINQ_FROM_NUMBER],
      service: "sms",
      message: { parts: [{ type: "text", value: "diag test" }] },
    };
    const chatRes = await fetch(`${LINQ_BASE}/v3/chats`, {
      method: "POST",
      headers: linqHeaders(),
      body: JSON.stringify(chatBody),
    });
    const chatText = await chatRes.text();
    const chatParsed = chatRes.ok ? JSON.parse(chatText) : null;
    const chatId = chatParsed?.chat?.id || chatParsed?.data?.id || chatParsed?.id || null;
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

    // ── Secret debug commands (work in any state) ──
    const cmd = userMessage.toLowerCase().trim();

    if (cmd === "/newuser") {
      // Full factory reset — nuke user record, conversation history, MCP client
      console.log(`[Debug] /newuser from ${fromPhone}`);
      await disconnectMcpClient(fromPhone);
      chatIdCache.delete(fromPhone);
      if (user) {
        await supabase.from("sms_conversations").delete().eq("phone_number", fromPhone);
        await supabase.from("sms_users").delete().eq("phone_number", fromPhone);
      }
      await sendSms(fromPhone, "[DEBUG] User wiped. Text anything to start fresh as a new user.", chatId);
      return;
    }

    if (cmd === "/reset") {
      console.log(`[Debug] /reset from ${fromPhone}`);
      await disconnectMcpClient(fromPhone);
      if (user) {
        await supabase
          .from("sms_users")
          .update({ status: "awaiting_mcp_url", mcp_url: null })
          .eq("phone_number", fromPhone);
      }
      await sendSms(fromPhone, "[DEBUG] MCP connection reset. Send your MCP URL to reconnect.", chatId);
      return;
    }

    if (cmd === "/status") {
      console.log(`[Debug] /status from ${fromPhone}`);
      const historyCount = user ? (await getConversationHistory(fromPhone, 9999)).length : 0;
      const mcpConnected = mcpClients.has(fromPhone);
      let toolCount = "N/A";
      if (mcpConnected) {
        try {
          const { tools = [] } = await mcpClients.get(fromPhone).listTools();
          toolCount = tools.length;
        } catch { toolCount = "error"; }
      }
      const lines = [
        "[DEBUG] Status",
        `Phone: ${fromPhone}`,
        `User exists: ${!!user}`,
        `State: ${user?.status || "none"}`,
        `MCP URL: ${user?.mcp_url ? user.mcp_url.substring(0, 40) + "..." : "not set"}`,
        `MCP client cached: ${mcpConnected}`,
        `Tools discovered: ${toolCount}`,
        `Chat ID cached: ${chatIdCache.has(fromPhone) ? chatIdCache.get(fromPhone) : "no"}`,
        `Conversation messages: ${historyCount}`,
        `Last active: ${user?.last_active_at || "never"}`,
      ];
      await sendSms(fromPhone, lines.join("\n"), chatId);
      return;
    }

    if (cmd === "/tools") {
      console.log(`[Debug] /tools from ${fromPhone}`);
      if (!user?.mcp_url) {
        await sendSms(fromPhone, "[DEBUG] No MCP URL configured. Connect first.", chatId);
        return;
      }
      try {
        const client = await getMcpClient(fromPhone, user.mcp_url);
        let allTools = [];
        const params = {};
        do {
          const { tools = [], nextCursor } = await client.listTools(params);
          allTools.push(...tools);
          params.cursor = nextCursor;
        } while (params.cursor);
        const lines = [`[DEBUG] ${allTools.length} MCP tools:`];
        for (const t of allTools) {
          const params = t.inputSchema?.properties ? Object.keys(t.inputSchema.properties).join(", ") : "none";
          lines.push(`\n• ${t.name}\n  ${t.description || "(no description)"}\n  Params: ${params}`);
        }
        await sendSms(fromPhone, lines.join("\n"), chatId);
      } catch (err) {
        await sendSms(fromPhone, `[DEBUG] Tool discovery failed: ${err.message}`, chatId);
      }
      return;
    }

    if (cmd === "/clearhistory") {
      console.log(`[Debug] /clearhistory from ${fromPhone}`);
      const { count } = await supabase
        .from("sms_conversations")
        .delete({ count: "exact" })
        .eq("phone_number", fromPhone);
      await sendSms(fromPhone, `[DEBUG] Cleared ${count || 0} conversation messages. MCP connection preserved.`, chatId);
      return;
    }

    if (cmd === "/ping") {
      console.log(`[Debug] /ping from ${fromPhone}`);
      if (!user?.mcp_url) {
        await sendSms(fromPhone, "[DEBUG] No MCP URL configured.", chatId);
        return;
      }
      const start = Date.now();
      try {
        // Force a fresh connection to truly test reachability
        await disconnectMcpClient(fromPhone);
        const client = await getMcpClient(fromPhone, user.mcp_url);
        const { tools = [] } = await client.listTools();
        const elapsed = Date.now() - start;
        await sendSms(fromPhone, `[DEBUG] Pong! MCP connected in ${elapsed}ms. ${tools.length} tools available.`, chatId);
      } catch (err) {
        const elapsed = Date.now() - start;
        await sendSms(fromPhone, `[DEBUG] Ping failed after ${elapsed}ms: ${err.message}`, chatId);
      }
      return;
    }

    if (cmd === "/whoami") {
      console.log(`[Debug] /whoami from ${fromPhone}`);
      if (!user) {
        await sendSms(fromPhone, "[DEBUG] No user record found for this phone number.", chatId);
        return;
      }
      const dump = JSON.stringify(user, null, 2);
      await sendSms(fromPhone, `[DEBUG] User record:\n${dump}`, chatId);
      return;
    }

    if (cmd === "/help") {
      console.log(`[Debug] /help from ${fromPhone}`);
      const lines = [
        "[DEBUG] Secret commands:",
        "/newuser — full wipe, restart as brand new user",
        "/reset — clear MCP URL, re-enter setup",
        "/status — show user state & connection info",
        "/tools — list all MCP tools & params",
        "/ping — test MCP connection latency",
        "/clearhistory — wipe conversation, keep MCP",
        "/whoami — dump raw user record",
        "/help — this message",
      ];
      await sendSms(fromPhone, lines.join("\n"), chatId);
      return;
    }

    // ── New user ──
    if (!user) {
      user = await createUser(fromPhone);

      // Check if the first message already contains an MCP URL (e.g. deep-link from the app)
      const embeddedUrl = extractUrl(userMessage);
      if (embeddedUrl) {
        console.log(`[New user] First message contains URL, skipping welcome: ${embeddedUrl}`);
        try {
          const testClient = new Client({ name: "sms-memory-bot-test", version: "1.0.0" });
          const testTransport = new StreamableHTTPClientTransport(new URL(embeddedUrl));
          await testClient.connect(testTransport);
          const { tools } = await testClient.listTools();
          await testClient.close();

          await activateUser(fromPhone, embeddedUrl);
          await sendSms(
            fromPhone,
            `Hey there! 👋 Welcome to Weave — your personal memory, just a text away.\n\nYou're all set! 🎉\n\nHere's what you can do — just text me like you normally would:\n\n💾 Create a memory: "Remember that my anniversary is March 5th"\n🔍 Find a memory: "When is my anniversary?"\n🗑️ Forget something: "Forget my old wifi password"\n\nThat's it — I'm your second brain. Text me anytime!`,
            chatId
          );
        } catch (err) {
          console.error("[New user MCP validation error]", err.message);
          await sendSms(
            fromPhone,
            `Hey there! 👋 Welcome to Weave — your personal memory, just a text away.\n\nI tried connecting with the URL you sent, but it didn't work. Could you double-check it?\n\nYou can find your MCP URL in your Weave Fabric account under Settings. Paste it here and I'll try again!`,
            chatId
          );
        }
        return;
      }

      await sendSms(
        fromPhone,
        `Hey there! 👋 Welcome to Weave — your personal memory, just a text away.\n\nI can remember things for you, help you find them later, and forget anything you want gone. All by texting me.\n\nTo get connected, paste your MCP URL from Weave Fabric. You can find it in your Weave Fabric account under Settings.`,
        chatId
      );
      return;
    }

    // ── Awaiting MCP URL ──
    if (user.status === "awaiting_mcp_url") {
      // Extract URL from message — supports bare URLs and messages with surrounding text
      const url = extractUrl(userMessage);

      if (!url) {
        await sendSms(
          fromPhone,
          `Hmm, that doesn't look like an MCP URL. It should be a link that starts with https://\n\nYou can find your MCP URL in your Weave Fabric account under Settings. Just paste it here when you're ready!`,
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
          `You're all set! 🎉\n\nHere's what you can do — just text me like you normally would:\n\n💾 Create a memory: "Remember that my anniversary is March 5th"\n🔍 Find a memory: "When is my anniversary?"\n🗑️ Forget something: "Forget my old wifi password"\n\nThat's it — I'm your second brain. Text me anytime!`,
          chatId
        );
      } catch (err) {
        console.error("[MCP validation error]", err.message);
        await sendSms(
          fromPhone,
          `Hmm, I wasn't able to connect with that URL. Could you double-check it?\n\nYou can find your MCP URL in your Weave Fabric account under Settings. Paste it here and I'll try again!`,
          chatId
        );
      }
      return;
    }

    // ── Active user ──
    if (user.status === "active") {
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

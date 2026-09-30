// Local synthetic visual fixture. Never connects to a mail provider or sends mail.
import http from "node:http";
const accounts = [
  {
    id: "cloudflare:hello@example.com",
    provider: "cloudflare",
    email: "hello@example.com",
    name: "Studio",
    status: "connected",
  },
  {
    id: "gmail:personal-fixture",
    provider: "gmail",
    email: "alex@example.com",
    name: "Personal",
    status: "connected",
  },
  {
    id: "cloudflare:work@example.org",
    provider: "cloudflare",
    email: "work@example.org",
    name: "Fabric",
    status: "connected",
  },
];
const rows = [
  [
    "Maya Chen",
    "A few thoughts on the new direction",
    "The quieter layout is working. I left a few notes on the account switcher.",
    0,
  ],
  [
    "Linear",
    "Your team’s weekly update",
    "Here’s what moved forward this week. Three projects, one shared view.",
    2,
  ],
  [
    "Jordan Lee",
    "Thursday works for me",
    "Let’s keep the morning free and catch up after lunch.",
    1,
  ],
  [
    "Figma",
    "A comment on Inbox / Workbench",
    "Maya mentioned you in a comment: the sender identity should stay visible.",
    0,
  ],
  [
    "Sam Rivera",
    "Invoice for September",
    "The invoice is attached. Thanks again for the thoughtful collaboration.",
    2,
  ],
  [
    "Newsletter <news@example.net>",
    "Small tools, thoughtful work",
    "A few things worth reading over the weekend.",
    1,
  ],
  [
    "GitHub <noreply@github.com>",
    "[passioncode-ai/fabric-inbox] Run failed: CI - main",
    "The workflow run failed on main at the test step.",
    2,
  ],
  [
    "Stripe <noreply@stripe.com>",
    "Payment failed for Fabric Pro",
    "We could not charge the card ending 4242. Update your payment method.",
    0,
  ],
  [
    "App Store Connect <no-reply@email.apple.com>",
    "App Store Connect: Your submission was rejected",
    "Guideline 2.1 — information needed. Reply in App Store Connect.",
    2,
  ],
  [
    "Google <no-reply@accounts.google.com>",
    "Security alert: new sign-in on Mac",
    "A new sign-in to your account was detected.",
    1,
  ],
  [
    "Product Hunt <noreply@producthunt.com>",
    "Top products this week",
    "Seven launches the community loved.",
    1,
  ],
  [
    "Stripe <no-reply@stripe.com>",
    "Your receipt from Cloudflare",
    "Receipt #2291 for your Workers Paid plan.",
    0,
  ],
];
let messages = rows.map(([sender, subject, snippet, a], i) => ({
  id: JSON.stringify([accounts[a].id, "message-" + i]),
  accountId: accounts[a].id,
  provider: accounts[a].provider,
  providerMessageId: "message-" + i,
  subject,
  sender: sender.includes("<") ? sender : sender + " <sender" + i + "@example.com>",
  recipient: accounts[a].email,
  date: new Date(Date.now() - i * 3600000).toISOString(),
  read: i > 1 && i < 6,
  starred: i === 0,
  snippet,
  folder: "inbox",
  threadId: "thread-" + i,
}));
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (!url.pathname.startsWith("/api/")) {
    const proxy = http.request(
      {
        hostname: "127.0.0.1",
        port: Number(process.env.PREVIEW_TARGET_PORT || 5174),
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: "127.0.0.1:" + (process.env.PREVIEW_TARGET_PORT || 5174),
        },
      },
      (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      },
    );
    proxy.on("error", () => {
      res.writeHead(502);
      res.end("Start npm run dev -- --port 5174 first");
    });
    req.pipe(proxy);
    return;
  }
  res.setHeader("Content-Type", "application/json");
  const json = (v) => res.end(JSON.stringify(v));
  // Opt-in state changes stay in this process and never call a real provider.
  if (process.env.PREVIEW_ACTIONS === "1" && req.method !== "GET") {
    const parts = url.pathname.split("/").map(decodeURIComponent);
    const gmail = parts[2] === "accounts";
    const accountId = gmail ? "gmail:" + parts[3] : "cloudflare:" + parts[4];
    const messageId = gmail ? parts[5] : parts[6];
    const action = gmail ? parts[6] : parts[7];
    const message = messages.find(m => m.accountId === accountId && m.providerMessageId === messageId);
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body;
    try { body = JSON.parse(raw); } catch { body = null; }
    if (message && body && ((gmail && ["starred", "trashed", "read", "archive"].includes(action)) || (!gmail && (!action || action === "move")))) {
      if (typeof body.starred === "boolean") message.starred = body.starred;
      if (typeof body.read === "boolean") message.read = body.read;
      if (typeof body.trashed === "boolean") message.folder = body.trashed ? "trash" : "inbox";
      if (action === "archive") message.folder = "archive";
      if (action === "move" && ["inbox", "archive", "trash"].includes(body.folderId)) message.folder = body.folderId;
      json({ ...message, labels: [...(message.starred ? ["STARRED"] : []), ...(message.folder === "inbox" ? ["INBOX"] : [])], fixture: true });
      return;
    }
  }
  if (req.method !== "GET") {
    res.statusCode = 400;
    json({
      error:
        "Synthetic preview only. No mail was sent. Connect your own server for actions.",
      fixture: true,
    });
    return;
  }
  if (url.pathname === "/api/inbox") {
    let filtered = messages.filter(
      (m) =>
        (!url.searchParams.get("account") ||
          m.accountId === url.searchParams.get("account")) &&
        (url.searchParams.get("folder") === "starred"
          ? m.starred
          : m.folder === (url.searchParams.get("folder") || "inbox")) &&
        (url.searchParams.get("unread") !== "1" || !m.read) &&
        (m.subject + " " + m.snippet + " " + m.sender)
          .toLowerCase()
          .includes((url.searchParams.get("query") || "").toLowerCase()),
    );
    json({ accounts, messages: filtered, issues: [], hasMore: false });
    return;
  }
  const id = url.pathname.split("/").at(-1);
  const m = messages.find((m) => m.providerMessageId === id);
  if (m) {
    const text = `Hi Alex,\n\n${m.snippet}\n\nThe three-column view makes it much easier to see what needs attention. I can scan all my accounts, then narrow the same list without losing my place.\n\nA few details to keep in mind:\n• Keep the account visible on every message.\n• Let the content have room to breathe.\n• Make the next action easy to find.\n\nLet me know what you think.\n\n${m.sender.split(" <")[0]}\n\nSynthetic preview message — not real mail.`;
    json(
      m.provider === "gmail"
        ? {
            ...m,
            from: m.sender,
            to: m.recipient,
            text,
            ...(process.env.PREVIEW_HTML === "1" ? {
              text: "",
              html: '<p>Synthetic HTML message for privacy checks. <a href="https://example.com/phish" target="_top">A link that asks for the top window</a></p><img src="https://example.com/fabric-inbox-synthetic-image.png" alt="Synthetic external image">',
            } : {}),
            labels: ["INBOX"],
            attachments: [],
          }
        : {
            ...m,
            body: "<p>" + text.replaceAll("\n", "</p><p>") + "</p>",
            attachments: [],
          },
    );
    return;
  }
  res.writeHead(404);
  json({ error: "fixture_route_not_found" });
});
server.listen(Number(process.env.FIXTURE_PORT || 5175), "127.0.0.1", () =>
  console.log(
    "Synthetic UI fixture on port " +
      (process.env.FIXTURE_PORT || 5175) +
      " (no real mail)",
  ),
);

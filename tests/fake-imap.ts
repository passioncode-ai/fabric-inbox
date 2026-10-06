/**
 * An in-process IMAP server over node `net`, enough for imapflow and for what this server asks of
 * an IMAP account: login (LOGIN, AUTHENTICATE PLAIN), LIST with SPECIAL-USE, SELECT/EXAMINE with
 * UIDVALIDITY, UIDNEXT and HIGHESTMODSEQ, FETCH and UID FETCH (flags, dates, sizes, the whole
 * message or its header, CHANGEDSINCE), UID SEARCH (ALL, HEADER), UID STORE, UID MOVE (or COPY when
 * MOVE is off) with COPYUID, APPEND with APPENDUID, UID EXPUNGE. Plain text over the loopback:
 * the client is given `secure: false` here and nothing else changes.
 *
 * The mailbox can be changed from the test while a client is away (deliver, flag, expunge, a new
 * UIDVALIDITY), as a person's other mail app would.
 */
import net from "node:net";

export interface FakeMessage { uid: number; flags: Set<string>; date: Date; raw: Buffer; modseq: number }
export interface FakeFolder { path: string; specialUse?: string; uidValidity: number; uidNext: number; modseq: number; messages: FakeMessage[] }
export interface FakeImapOptions {
  users?: Record<string, string>;
  condstore?: boolean;
  move?: boolean;
  uidplus?: boolean;
  specialUse?: boolean;
  /** The text of a refused login (the tagged NO line after the tag). */
  loginFailure?: string;
  /** Folders besides INBOX, with their special use. */
  folders?: { path: string; specialUse?: string }[];
  /** CREATE is refused (a server that does not let clients make folders). */
  createRefused?: boolean;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const imapDate = (d: Date) => `${String(d.getUTCDate()).padStart(2, " ")}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${d.toISOString().slice(11, 19)} +0000`;
const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

type Token = string | Buffer | Token[];

export class FakeImap {
  server: net.Server;
  port = 0;
  folders = new Map<string, FakeFolder>();
  /** Every command, with login arguments replaced. */
  commands: string[] = [];
  logins = 0;
  /** Folders a client made (CREATE). */
  created: string[] = [];
  private sockets = new Set<net.Socket>();
  private validity = 1_700_000_000;
  constructor(public options: FakeImapOptions = {}) {
    this.server = net.createServer((s) => this.session(s));
    const folders = options.folders ?? [
      { path: "Sent", specialUse: "\\Sent" }, { path: "Drafts", specialUse: "\\Drafts" }, { path: "Trash", specialUse: "\\Trash" },
      { path: "Junk", specialUse: "\\Junk" }, { path: "Archive", specialUse: "\\Archive" },
    ];
    for (const f of [{ path: "INBOX" }, ...folders]) this.folders.set(f.path, { path: f.path, specialUse: (f as { specialUse?: string }).specialUse, uidValidity: this.validity++, uidNext: 1, modseq: 1, messages: [] });
  }
  async start() {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as net.AddressInfo).port;
    return this;
  }
  async stop() {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
  get openConnections() { return [...this.sockets].filter((s) => !s.destroyed).length; }

  folder(path: string) { const f = this.folders.get(path); if (!f) throw new Error("no folder " + path); return f; }
  /** A new message in a folder, as mail arriving there. Returns its UID. */
  deliver(path: string, raw: string, options: { flags?: string[]; date?: Date } = {}) {
    const f = this.folder(path);
    const uid = f.uidNext++;
    f.modseq++;
    f.messages.push({ uid, flags: new Set(options.flags ?? []), date: options.date ?? new Date(), raw: Buffer.from(raw.replace(/\r?\n/g, "\r\n")), modseq: f.modseq });
    return uid;
  }
  setFlags(path: string, uid: number, flags: string[]) {
    const f = this.folder(path);
    const m = f.messages.find((x) => x.uid === uid)!;
    m.flags = new Set(flags);
    m.modseq = ++f.modseq;
  }
  expunge(path: string, uid: number) {
    const f = this.folder(path);
    f.messages = f.messages.filter((m) => m.uid !== uid);
    f.modseq++;
  }
  /** The folder is rebuilt by the server: same messages, new UIDs under a new UIDVALIDITY. */
  renumber(path: string) {
    const f = this.folder(path);
    f.uidValidity = this.validity++;
    f.uidNext = 1;
    for (const m of f.messages) m.uid = f.uidNext++;
  }

  private caps() {
    const o = this.options;
    return ["IMAP4rev1", "AUTH=PLAIN", "ID", ...(o.uidplus !== false ? ["UIDPLUS"] : []), ...(o.move !== false ? ["MOVE"] : []),
      ...(o.specialUse !== false ? ["SPECIAL-USE"] : []), ...(o.condstore ? ["CONDSTORE", "ENABLE"] : [])].join(" ");
  }

  private session(socket: net.Socket) {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffer = Buffer.alloc(0);
    let selected: FakeFolder | null = null;
    let authed = false;
    let pendingAuth: string | null = null;
    const write = (data: string | Buffer) => { if (!socket.destroyed) socket.write(data); };
    write(`* OK [CAPABILITY ${this.caps()}] fake IMAP ready\r\n`);

    /** One complete command (its literals included), or null when more bytes are needed. */
    const take = (): { line: string; tokens: Token[] } | null => {
      let pos = 0;
      let line = "";
      const literals: Buffer[] = [];
      for (;;) {
        const nl = buffer.indexOf("\r\n", pos);
        if (nl < 0) return null;
        const part = buffer.subarray(pos, nl).toString("utf8");
        const lit = /\{(\d+)(\+?)\}$/.exec(part);
        if (!lit) { line += part; buffer = buffer.subarray(nl + 2); return { line, tokens: tokenize(line, literals) }; }
        const size = Number(lit[1]);
        if (buffer.length < nl + 2 + size) {
          // A synchronising literal waits for our go-ahead, once.
          if (!lit[2] && !(take as { asked?: number }).asked) { (take as { asked?: number }).asked = nl; write("+ Ready for literal\r\n"); }
          return null;
        }
        (take as { asked?: number }).asked = 0;
        literals.push(Buffer.from(buffer.subarray(nl + 2, nl + 2 + size)));
        line += part.slice(0, lit.index) + `\u0000${literals.length - 1}\u0000`;
        pos = nl + 2 + size;
      }
    };

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (pendingAuth) {
          const nl = buffer.indexOf("\r\n");
          if (nl < 0) return;
          const answer = buffer.subarray(0, nl).toString();
          buffer = buffer.subarray(nl + 2);
          const tag = pendingAuth; pendingAuth = null;
          this.commands.push("<auth response>");
          const [, user, pass] = Buffer.from(answer, "base64").toString().split("\0");
          authed = this.login(user!, pass!, tag, write);
          continue;
        }
        const cmd = take();
        if (!cmd) return;
        const [tag, rawVerb, ...args] = cmd.tokens as string[];
        let verb = String(rawVerb ?? "").toUpperCase();
        let uidMode = false;
        if (verb === "UID") { uidMode = true; verb = String(args.shift() ?? "").toUpperCase(); }
        this.commands.push(verb === "LOGIN" || verb === "AUTHENTICATE" ? `${verb} <secret>` : `${uidMode ? "UID " : ""}${cmd.line.split(" ").slice(1 + (uidMode ? 1 : 0)).join(" ").replace(/\u0000\d+\u0000/g, "{literal}")}`);
        try {
          this.handle(String(tag), verb, uidMode, args as Token[], { write, socket, get selected() { return selected; }, set selected(f) { selected = f; },
            get authed() { return authed; }, set authed(v) { authed = v; }, setPendingAuth: (t: string) => { pendingAuth = t; } });
        } catch (error) {
          write(`${tag} BAD ${(error as Error).message}\r\n`);
        }
      }
    });
  }

  private login(user: string, pass: string, tag: string, write: (d: string) => void) {
    this.logins++;
    if ((this.options.users ?? {})[user] === pass) { write(`${tag} OK [CAPABILITY ${this.caps()}] Logged in\r\n`); return true; }
    write(`${tag} ${this.options.loginFailure ?? "NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)"}\r\n`);
    return false;
  }

  private handle(tag: string, verb: string, uidMode: boolean, args: Token[], s: {
    write: (d: string | Buffer) => void; socket: net.Socket; selected: FakeFolder | null; authed: boolean; setPendingAuth(tag: string): void;
  }) {
    const ok = (text = "done") => s.write(`${tag} OK ${text}\r\n`);
    const str = (t: Token | undefined) => (Buffer.isBuffer(t) ? t.toString() : String(t ?? ""));
    switch (verb) {
      case "CAPABILITY": s.write(`* CAPABILITY ${this.caps()}\r\n`); return ok();
      case "ID": s.write(`* ID ("name" "fake")\r\n`); return ok();
      case "NOOP": return ok();
      case "LOGOUT": s.write("* BYE fake logging out\r\n"); ok(); s.socket.end(); return;
      case "LOGIN": s.authed = this.login(str(args[0]), str(args[1]), tag, s.write); return;
      case "AUTHENTICATE": {
        if (str(args[0]).toUpperCase() !== "PLAIN") return void s.write(`${tag} NO unsupported mechanism\r\n`);
        if (args[1] !== undefined) {
          const [, user, pass] = Buffer.from(str(args[1]), "base64").toString().split("\0");
          s.authed = this.login(user!, pass!, tag, s.write);
        } else { s.setPendingAuth(tag); s.write("+ \r\n"); }
        return;
      }
    }
    if (!s.authed) return void s.write(`${tag} NO not authenticated\r\n`);
    const sel = () => { if (!s.selected) throw new Error("no folder selected"); return s.selected; };
    switch (verb) {
      case "ENABLE": s.write(`* ENABLED${this.options.condstore ? " CONDSTORE" : ""}\r\n`); return ok();
      case "NAMESPACE": s.write(`* NAMESPACE (("" "/")) NIL NIL\r\n`); return ok();
      case "LIST": case "LSUB": {
        const pattern = str(args[1]);
        if (pattern === "") { s.write(`* ${verb} (\\Noselect) "/" ""\r\n`); return ok(); }
        for (const f of this.folders.values()) {
          const flags = ["\\HasNoChildren", ...(this.options.specialUse !== false && f.specialUse && verb === "LIST" ? [f.specialUse] : [])];
          s.write(`* ${verb} (${flags.join(" ")}) "/" ${quote(f.path)}\r\n`);
        }
        return ok();
      }
      case "CREATE": {
        const path = str(args[0]);
        if (this.options.createRefused) return void s.write(`${tag} NO [CANNOT] Folders cannot be created here\r\n`);
        if (this.folders.has(path)) return void s.write(`${tag} NO [ALREADYEXISTS] Mailbox already exists\r\n`);
        this.folders.set(path, { path, uidValidity: this.validity++, uidNext: 1, modseq: 1, messages: [] });
        this.created.push(path);
        return ok("CREATE completed");
      }
      case "STATUS": {
        const f = this.folder(str(args[0]));
        s.write(`* STATUS ${quote(f.path)} (MESSAGES ${f.messages.length} UIDNEXT ${f.uidNext} UIDVALIDITY ${f.uidValidity})\r\n`);
        return ok();
      }
      case "SELECT": case "EXAMINE": {
        const f = this.folders.get(str(args[0]));
        if (!f) return void s.write(`${tag} NO [NONEXISTENT] Unknown Mailbox\r\n`);
        s.selected = f;
        s.write(`* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] ok\r\n`);
        s.write(`* ${f.messages.length} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY ${f.uidValidity}] UIDs valid\r\n* OK [UIDNEXT ${f.uidNext}] next\r\n`);
        if (this.options.condstore) s.write(`* OK [HIGHESTMODSEQ ${f.modseq}] modseq\r\n`);
        return ok(`[${verb === "SELECT" ? "READ-WRITE" : "READ-ONLY"}] ${verb} completed`);
      }
      case "CLOSE": case "UNSELECT": s.selected = null; return ok();
      case "FETCH": return this.fetch(tag, sel(), uidMode, args, s.write);
      case "SEARCH": {
        const f = sel();
        const words = args.map(str);
        let found = f.messages;
        const at = words.findIndex((w) => w.toUpperCase() === "HEADER");
        if (at >= 0) {
          const name = words[at + 1]!.toLowerCase(), value = words[at + 2]!.toLowerCase();
          found = found.filter((m) => headerValue(m.raw, name).toLowerCase().includes(value));
        } else if (!words.some((w) => w.toUpperCase() === "ALL")) throw new Error("search not supported: " + words.join(" "));
        s.write(`* SEARCH${found.map((m) => " " + (uidMode ? m.uid : f.messages.indexOf(m) + 1)).join("")}\r\n`);
        return ok();
      }
      case "STORE": {
        const f = sel();
        const [set, op, flagList] = [str(args[0]), str(args[1]).toUpperCase(), args[2]];
        const flags = (Array.isArray(flagList) ? flagList : [flagList]).map(str);
        for (const m of this.select(f, set, uidMode)) {
          if (op.startsWith("+")) for (const fl of flags) m.flags.add(fl);
          else if (op.startsWith("-")) for (const fl of flags) m.flags.delete(fl);
          else m.flags = new Set(flags);
          m.modseq = ++f.modseq;
          if (!op.includes("SILENT")) s.write(`* ${f.messages.indexOf(m) + 1} FETCH (UID ${m.uid} FLAGS (${[...m.flags].join(" ")})${this.options.condstore ? ` MODSEQ (${m.modseq})` : ""})\r\n`);
        }
        return ok();
      }
      case "COPY": case "MOVE": {
        if (verb === "MOVE" && this.options.move === false) throw new Error("MOVE not supported");
        const f = sel();
        const dest = this.folders.get(str(args[1]));
        if (!dest) return void s.write(`${tag} NO [TRYCREATE] No such mailbox\r\n`);
        const picked = this.select(f, str(args[0]), uidMode);
        const from: number[] = [], to: number[] = [];
        for (const m of picked) {
          const uid = dest.uidNext++;
          dest.messages.push({ uid, flags: new Set(m.flags), date: m.date, raw: m.raw, modseq: ++dest.modseq });
          from.push(m.uid); to.push(uid);
        }
        const copyuid = this.options.uidplus !== false && from.length ? `[COPYUID ${dest.uidValidity} ${from.join(",")} ${to.join(",")}] ` : "";
        if (verb === "MOVE") {
          s.write(`* OK ${copyuid}moved\r\n`);
          for (const m of picked) { s.write(`* ${f.messages.indexOf(m) + 1} EXPUNGE\r\n`); f.messages = f.messages.filter((x) => x !== m); f.modseq++; }
          return ok("done");
        }
        return ok(copyuid + "copied");
      }
      case "EXPUNGE": {
        const f = sel();
        const only = uidMode ? new Set(this.select(f, str(args[0]), true)) : null;
        for (const m of [...f.messages]) {
          if (!m.flags.has("\\Deleted") || (only && !only.has(m))) continue;
          s.write(`* ${f.messages.indexOf(m) + 1} EXPUNGE\r\n`);
          f.messages = f.messages.filter((x) => x !== m);
          f.modseq++;
        }
        return ok();
      }
      case "APPEND": {
        const dest = this.folders.get(str(args[0]));
        if (!dest) return void s.write(`${tag} NO [TRYCREATE] No such mailbox\r\n`);
        const raw = args.find((a) => Buffer.isBuffer(a)) as Buffer;
        const flagList = args.find((a) => Array.isArray(a)) as Token[] | undefined;
        const dateArg = args.find((a) => typeof a === "string" && /^\s?\d{1,2}-[A-Z][a-z]{2}-\d{4}/.test(a)) as string | undefined;
        const uid = dest.uidNext++;
        dest.messages.push({ uid, flags: new Set((flagList ?? []).map(str)), date: dateArg ? new Date(dateArg.replace(/-/g, " ")) : new Date(), raw, modseq: ++dest.modseq });
        return ok(this.options.uidplus !== false ? `[APPENDUID ${dest.uidValidity} ${uid}] appended` : "appended");
      }
    }
    s.write(`${tag} BAD unknown command ${verb}\r\n`);
  }

  private select(f: FakeFolder, set: string, uidMode: boolean): FakeMessage[] {
    const max = uidMode ? Math.max(0, ...f.messages.map((m) => m.uid)) : f.messages.length;
    const ranges = set.split(",").map((r) => {
      const [a, b] = r.split(":");
      const n = (x: string) => (x === "*" ? max : Number(x));
      const lo = n(a!), hi = b === undefined ? lo : n(b);
      return [Math.min(lo, hi), Math.max(lo, hi)];
    });
    return f.messages.filter((m, i) => ranges.some(([lo, hi]) => { const k = uidMode ? m.uid : i + 1; return k >= lo! && k <= hi!; }));
  }

  private fetch(tag: string, f: FakeFolder, uidMode: boolean, args: Token[], write: (d: string | Buffer) => void) {
    const set = String(args[0]);
    const items = (Array.isArray(args[1]) ? args[1] : [args[1]]).map((t) => String(t).toUpperCase());
    const modifiers = Array.isArray(args[2]) ? (args[2] as Token[]).map(String) : [];
    const changedAt = modifiers.findIndex((m) => m.toUpperCase() === "CHANGEDSINCE");
    const since = changedAt >= 0 ? Number(modifiers[changedAt + 1]) : null;
    for (const m of this.select(f, set, uidMode)) {
      if (since !== null && m.modseq <= since) continue;
      const parts: (string | Buffer)[] = [`* ${f.messages.indexOf(m) + 1} FETCH (UID ${m.uid}`];
      for (const item of items) {
        if (item === "UID") continue;
        if (item === "FLAGS") parts.push(` FLAGS (${[...m.flags].join(" ")})`);
        else if (item === "INTERNALDATE") parts.push(` INTERNALDATE "${imapDate(m.date)}"`);
        else if (item === "RFC822.SIZE") parts.push(` RFC822.SIZE ${m.raw.length}`);
        else if (item === "MODSEQ") parts.push(` MODSEQ (${m.modseq})`);
        else if (item === "BODY.PEEK[]" || item === "BODY[]") { parts.push(` BODY[] {${m.raw.length}}\r\n`, m.raw); }
        else if (item === "BODY.PEEK[HEADER]" || item === "BODY[HEADER]") {
          const end = m.raw.indexOf("\r\n\r\n");
          const head = end < 0 ? m.raw : m.raw.subarray(0, end + 4);
          parts.push(` BODY[HEADER] {${head.length}}\r\n`, head);
        } else throw new Error("fetch item not supported: " + item);
      }
      if (this.options.condstore && since !== null && !items.includes("MODSEQ")) parts.push(` MODSEQ (${m.modseq})`);
      parts.push(")\r\n");
      write(Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p)))));
    }
    write(`${tag} OK FETCH completed\r\n`);
  }
}

function headerValue(raw: Buffer, name: string): string {
  const head = raw.toString("utf8").split(/\r\n\r\n/)[0]!.replace(/\r\n[ \t]+/g, " ");
  for (const line of head.split("\r\n")) {
    const at = line.indexOf(":");
    if (at > 0 && line.slice(0, at).toLowerCase() === name) return line.slice(at + 1).trim();
  }
  return "";
}

/** IMAP arguments: atoms (with [..] sections kept whole), quoted strings, literals and lists. */
function tokenize(line: string, literals: Buffer[]): Token[] {
  let i = 0;
  const list = (close: string | null): Token[] => {
    const out: Token[] = [];
    while (i < line.length) {
      const c = line[i]!;
      if (c === " ") { i++; continue; }
      if (close && c === close) { i++; return out; }
      if (c === "(") { i++; out.push(list(")")); continue; }
      if (c === '"') {
        let s = ""; i++;
        while (i < line.length && line[i] !== '"') { if (line[i] === "\\") i++; s += line[i++]; }
        i++; out.push(s); continue;
      }
      if (c === "\u0000") { const end = line.indexOf("\u0000", i + 1); out.push(literals[Number(line.slice(i + 1, end))]!); i = end + 1; continue; }
      let s = "", depth = 0;
      while (i < line.length) {
        const ch = line[i]!;
        if (ch === "[") depth++;
        if (ch === "]") depth--;
        if (depth === 0 && (ch === " " || ch === "(" || ch === ")")) break;
        s += ch; i++;
      }
      out.push(s);
    }
    return out;
  };
  return list(null);
}

// Web Push to the developer's phone: a content-free "N need you", encrypted for the phone (RFC 8291)
// and signed with this install's VAPID key (RFC 8292). The one outbound call the desk makes.
import { createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, type ECDH, type JsonWebKey, type KeyObject, randomBytes, sign } from "node:crypto";
import { fields, InputError, text } from "../core/check.ts";
import { readJson, withLock, writeJson } from "../store/fsx.ts";

/** The push services a subscription may name: Apple's, which iOS home-screen apps use. */
export const PUSH_HOSTS = /^(?:[a-z0-9-]+\.)*push\.apple\.com$/;

export type Subscription = { endpoint: string; p256dh: string; auth: string };
/** `until`: when the device's PIN unlock ends; a device without the PIN in gets no push. */
type Subscribed = Subscription & { until: number };
type PushFile = { vapid: { publicKey: string; privateKey: string }; subscriptions: Subscribed[] };
/** A device on this machine, which never needs the PIN. */
export const NO_PIN = Number.MAX_SAFE_INTEGER;

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

/** A subscription as the page sends it (PushSubscription.toJSON()), checked. */
export function subscription(body: unknown): Subscription {
  const f = fields(body, "body");
  const endpoint = text(f.endpoint, "endpoint", 2048);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new InputError(`endpoint: not a URL: ${endpoint.slice(0, 100)}`);
  }
  if (url.protocol !== "https:" || !PUSH_HOSTS.test(url.hostname)) throw new InputError(`endpoint: only Apple's push service is allowed, got ${url.host}`);
  const keys = fields(f.keys, "keys");
  const p256dh = text(keys.p256dh, "keys.p256dh", 200);
  const auth = text(keys.auth, "keys.auth", 100);
  if (Buffer.from(p256dh, "base64url").length !== 65 || Buffer.from(auth, "base64url").length !== 16) throw new InputError("keys: expected a P-256 public key and a 16-byte secret");
  return { endpoint, p256dh, auth };
}

/** This install's VAPID key and the devices subscribed, kept in one store file (0600). */
export class Push {
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
  }

  /** This install's VAPID public key, made on first use; the page subscribes with it. */
  publicKey(): string {
    return this.read().vapid.publicKey;
  }

  subscribe(s: Subscription, until: number = NO_PIN): void {
    this.update((p) => ({ ...p, subscriptions: [...p.subscriptions.filter((x) => x.endpoint !== s.endpoint), { ...s, until }] }));
  }

  unsubscribe(endpoint: string): void {
    this.update((p) => ({ ...p, subscriptions: p.subscriptions.filter((x) => x.endpoint !== endpoint) }));
  }

  /** Without creating the key: a desk nobody subscribed to keeps no push file. */
  subscriptions(): Subscribed[] {
    return withLock(this.file, () => {
      const raw = readJson(this.file);
      return raw === undefined ? [] : parsePushFile(raw, this.file).subscriptions;
    });
  }

  /**
   * Sends `payload` to every subscribed device with its PIN in. A subscription the service reports gone (404, 410)
   * is dropped; any other failure is returned, one line each.
   */
  async send(payload: string, post: typeof fetch = fetch): Promise<string[]> {
    return this.deliver(this.read().subscriptions.filter((s) => s.until > Date.now()), payload, post);
  }

  /** Sends `payload` once to each device whose unlock has just ended, which then counts as told. */
  async sendEnded(payload: string, post: typeof fetch = fetch): Promise<string[]> {
    const ended = this.subscriptions().filter((s) => s.until > 0 && s.until <= Date.now());
    if (ended.length === 0) return [];
    this.update((p) => ({ ...p, subscriptions: p.subscriptions.map((s) => (ended.some((e) => e.endpoint === s.endpoint) ? { ...s, until: 0 } : s)) }));
    return this.deliver(ended, payload, post);
  }

  private async deliver(devices: Subscribed[], payload: string, post: typeof fetch): Promise<string[]> {
    const { vapid } = this.read();
    const key = createPrivateKey({ key: JSON.parse(vapid.privateKey) as JsonWebKey, format: "jwk" });
    const problems: string[] = [];
    for (const s of devices) {
      const url = new URL(s.endpoint);
      if (!PUSH_HOSTS.test(url.hostname)) continue; // checked when subscribed; a hand-edited file is not trusted either
      let res: Response;
      try {
        res = await post(s.endpoint, {
          method: "POST",
          headers: {
            Authorization: `vapid t=${vapidToken(url.origin, key)}, k=${vapid.publicKey}`,
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            TTL: "3600",
            Urgency: "high",
          },
          body: encrypt(Buffer.from(payload), Buffer.from(s.p256dh, "base64url"), Buffer.from(s.auth, "base64url")),
        });
      } catch (error) {
        problems.push(`push to ${url.host}: ${(error as Error).message}`);
        continue;
      }
      if (res.status === 404 || res.status === 410) this.unsubscribe(s.endpoint);
      else if (!res.ok) problems.push(`push to ${url.host}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    return problems;
  }

  private read(): PushFile {
    return withLock(this.file, () => this.load());
  }

  private update(fn: (p: PushFile) => PushFile): void {
    withLock(this.file, () => writeJson(this.file, fn(this.load())));
  }

  /** Call under the file's lock. */
  private load(): PushFile {
    const raw = readJson(this.file);
    if (raw !== undefined) return parsePushFile(raw, this.file);
    const made: PushFile = { vapid: newVapid(), subscriptions: [] };
    writeJson(this.file, made);
    return made;
  }
}

function parsePushFile(raw: unknown, file: string): PushFile {
  try {
    const f = fields(raw, file);
    const v = fields(f.vapid, "vapid");
    const subs = Array.isArray(f.subscriptions) ? f.subscriptions : [];
    return {
      vapid: { publicKey: text(v.publicKey, "vapid.publicKey", 200), privateKey: text(v.privateKey, "vapid.privateKey", 1000) },
      // Stored flat; checked again as the page sends it, so a hand-edited file meets the same rules.
      subscriptions: subs.map((s) => {
        const f = fields(s, "subscription");
        // Without a date, the device counts as locked until the page next opens unlocked.
        return { ...subscription({ endpoint: f.endpoint, keys: { p256dh: f.p256dh, auth: f.auth } }), until: typeof f.until === "number" ? f.until : 0 };
      }),
    };
  } catch (error) {
    throw new Error(`${file}: ${(error as Error).message}; delete the file and subscribe the phone again`);
  }
}

function newVapid(): PushFile["vapid"] {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { publicKey: b64url(rawPublic(publicKey)), privateKey: JSON.stringify(privateKey.export({ format: "jwk" })) };
}

/** The uncompressed point (0x04 ‖ x ‖ y) that browsers take as applicationServerKey. */
function rawPublic(key: KeyObject): Buffer {
  const jwk = key.export({ format: "jwk" });
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x ?? "", "base64url"), Buffer.from(jwk.y ?? "", "base64url")]);
}

/** A VAPID JWT (ES256) for one push service, valid 12 hours. */
function vapidToken(audience: string, key: KeyObject): string {
  const part = (o: object) => b64url(Buffer.from(JSON.stringify(o)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "https://github.com/jesusizq/agent-desk" })}`;
  return `${unsigned}.${b64url(sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }))}`;
}

/** RFC 8291 message encryption, aes128gcm content coding, one record. */
export function encrypt(plain: Buffer, uaPublic: Buffer, authSecret: Buffer, salt = randomBytes(16), ecdh?: ECDH): Buffer {
  const own = ecdh ?? createECDH("prime256v1");
  const asPublic = ecdh ? own.getPublicKey() : own.generateKeys();
  const shared = own.computeSecret(uaPublic);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

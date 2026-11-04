import assert from "node:assert/strict";
import { createECDH, createPublicKey, verify } from "node:crypto";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import { encrypt, Push, subscription } from "../src/server/push.ts";
import { pushNewQuestions } from "../src/server/server.ts";
import { addSession, testStore } from "./helpers.ts";

const b64 = (s: string) => Buffer.from(s, "base64url");
const APPLE = "https://web.push.apple.com/QGuQyavXutnMHjI_aA";

/** A phone's push keys, as PushSubscription.toJSON() gives them. */
function phone(endpoint = APPLE) {
  const ua = createECDH("prime256v1");
  return { endpoint, keys: { p256dh: ua.generateKeys().toString("base64url"), auth: Buffer.alloc(16, 7).toString("base64url") } };
}

describe("push", () => {
  it("encrypts as RFC 8291's worked example (Appendix A)", () => {
    const as = createECDH("prime256v1");
    as.setPrivateKey(b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"));
    const out = encrypt(
      Buffer.from("When I grow up, I want to be a watermelon"),
      b64("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
      b64("BTBZMqHH6r4Tts7J_aSIgg"),
      b64("DGv6ra1nlYgDCS1FRnbzlw"),
      as,
    );
    assert.equal(
      out.toString("base64url"),
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  it("accepts only Apple's push service, over https, with well-formed keys", () => {
    assert.equal(subscription(phone()).endpoint, APPLE);
    for (const endpoint of ["https://fcm.googleapis.com/fcm/send/x", "http://web.push.apple.com/x", "https://push.apple.com.evil.example/x", "https://evilpush.apple.com/x", "not a url"]) {
      assert.throws(() => subscription(phone(endpoint)), /endpoint/, endpoint);
    }
    assert.throws(() => subscription({ endpoint: APPLE, keys: { p256dh: "AAAA", auth: "AAAA" } }), /keys/);
  });

  it("signs each push for its service, and drops a subscription the service reports gone", async () => {
    const store = testStore();
    const push = new Push(store.paths.push);
    assert.deepEqual(push.subscriptions(), [], "nothing subscribed, and no key made for nobody");
    assert.equal(fs.existsSync(store.paths.push), false);
    push.subscribe(subscription(phone()));
    push.subscribe(subscription(phone("https://api.push.apple.com/gone")));
    assert.equal((fs.statSync(store.paths.push).mode & 0o777).toString(8), "600");

    const sent: { url: string; init: RequestInit }[] = [];
    const post = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response(null, { status: url.endsWith("/gone") ? 410 : 201 });
    }) as typeof fetch;
    assert.deepEqual(await push.send(JSON.stringify({ count: 2 }), post), []);
    assert.equal(sent.length, 2);
    const headers = sent[0]?.init.headers as Record<string, string>;
    assert.equal(headers["Content-Encoding"], "aes128gcm");
    const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(headers.Authorization ?? "") ?? [];
    assert.equal(key, push.publicKey());
    const [head, claims, signature] = (token ?? "").split(".");
    assert.equal(JSON.parse(b64(claims ?? "").toString()).aud, "https://web.push.apple.com");
    const pub = b64(key ?? "");
    const jwk = { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") };
    assert.ok(verify("sha256", Buffer.from(`${head}.${claims}`), { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, b64(signature ?? "")), "ES256 signature");
    assert.deepEqual(push.subscriptions().map((s) => s.endpoint), [APPLE], "the gone one is dropped");

    sent.length = 0;
    push.subscribe(subscription(phone()), Date.now() - 1000);
    assert.deepEqual(await push.send("{}", post), []);
    assert.equal(sent.length, 0, "a device whose PIN unlock ended gets nothing");
    push.subscribe(subscription(phone()), Date.now() + 60_000);

    push.subscribe(subscription(phone("https://web.push.apple.com/ended")), Date.now() - 1000);
    sent.length = 0;
    assert.deepEqual(await push.sendEnded(JSON.stringify({ pinEnded: true }), post), []);
    assert.deepEqual(sent.map((s) => s.url), ["https://web.push.apple.com/ended"], "told when its unlock ends");
    assert.deepEqual(await push.sendEnded("{}", post), []);
    assert.equal(sent.length, 1, "and only once");
    push.unsubscribe("https://web.push.apple.com/ended");

    const failing = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    assert.match((await push.send("{}", failing))[0] ?? "", /web\.push\.apple\.com: HTTP 503 down/);
  });

  it("pushes how many questions wait when a new one opens, never for those already open", async () => {
    const store = testStore();
    addSession(store);
    store.ask({ sessionId: "s1", kind: "question", text: "Already open?" });
    const push = new Push(store.paths.push);
    const bodies: number[] = [];
    const post = (async (_url: string, init: RequestInit) => {
      bodies.push((init.body as Buffer).length);
      return new Response(null, { status: 201 });
    }) as typeof fetch;
    const check = pushNewQuestions(store, push, post);
    store.ask({ sessionId: "s1", kind: "question", text: "Nobody subscribed yet" });
    await check();
    assert.equal(bodies.length, 0, "no subscription: nothing sent");
    push.subscribe(subscription(phone()));
    await check();
    assert.equal(bodies.length, 0, "a question seen on an earlier check is not pushed again");
    store.ask({ sessionId: "s1", kind: "permission", text: "Bash: rm -rf build" });
    await check();
    await check();
    assert.equal(bodies.length, 1);
    store.updateSession("s1", (s) => ({ ...s, process: { pid: process.pid, ancestors: [] } }));
    const writing = store.ask({ sessionId: "s1", kind: "question", text: "Being written?", writing: true });
    await check();
    assert.equal(bodies.length, 1, "nothing about a question still being written");
    store.releaseQuestions("s1");
    await check();
    assert.equal(bodies.length, 2, "told once it is complete");
    assert.equal(store.heldQuestions().has(writing.id), false);
  });
});

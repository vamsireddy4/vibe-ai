// @vitest-environment node
import { generateKeyPairSync, sign } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { verifyClerkToken } from "../../server/clerk-token";

// Admin routes trust this check, so: good token passes; forged/expired/foreign/garbage tokens fail.
const frontendApi = "test-app.clerk.accounts.dev";
const publishableKey = `pk_test_${Buffer.from(`${frontendApi}$`).toString("base64")}`;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ keys: [jwk] }) })));
afterAll(() => vi.unstubAllGlobals());

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = 1_800_000_000;
function token(payload: object, key = privateKey, kid = "k1") {
  const head = `${b64({ alg: "RS256", kid })}.${b64(payload)}`;
  return `${head}.${sign("RSA-SHA256", Buffer.from(head), key).toString("base64url")}`;
}
const good = { sub: "user_abc", iss: `https://${frontendApi}`, exp: now + 60, nbf: now - 1 };

describe("verifyClerkToken", () => {
  it("accepts a valid token", async () => {
    expect(await verifyClerkToken(token(good), publishableKey, now)).toBe("user_abc");
  });
  it("rejects bad signature, expired, other issuer, unknown key and garbage", async () => {
    expect(await verifyClerkToken(token(good, other.privateKey), publishableKey, now)).toBeNull();
    expect(await verifyClerkToken(token({ ...good, exp: now - 60 }), publishableKey, now)).toBeNull();
    expect(await verifyClerkToken(token({ ...good, iss: "https://evil.example" }), publishableKey, now)).toBeNull();
    expect(await verifyClerkToken(token(good, privateKey, "nope"), publishableKey, now)).toBeNull();
    expect(await verifyClerkToken("not.a.jwt", publishableKey, now)).toBeNull();
  });
});

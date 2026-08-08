import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildSignedRequestHeaders,
  loadWebsiteOrderHttpConfig,
  WebsiteOrderHttpTransport,
  type WebsiteOrderHttpConfig
} from "../src/main/services/websiteOrderHttpTransport";
import type { WebsiteOutboxEvent } from "../src/shared/types";

const terminalKeyPair = generateKeyPairSync("ed25519");
const terminalPrivateKey = terminalKeyPair.privateKey
  .export({ format: "der", type: "pkcs8" })
  .toString("base64url");

const config: WebsiteOrderHttpConfig = {
  baseUrl: "https://yamzouttara.com",
  terminalCode: "YAMZO_UTTARA_01",
  terminalPrivateKey: terminalKeyPair.privateKey,
  includeTestOrders: true
};

describe("website order HTTP transport", () => {
  it("signs each request without sending the raw terminal secret", async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: new URL(String(input)), init: init ?? {} });
      return new Response(JSON.stringify({ orders: [], nextCursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const transport = new WebsiteOrderHttpTransport(config, {
      fetchImpl: fetchImpl as typeof fetch,
      now: () => 1_786_176_000_000,
      nonceBytes: () => Buffer.alloc(18, 7)
    });

    expect(await transport.pullOrders(null, 100)).toEqual({ orders: [], nextCursor: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe("/api/pos/orders/claim");
    expect(calls[0].init.body).toBe(JSON.stringify({ cursor: null, limit: 10, includeTest: true }));

    const headers = calls[0].init.headers as Record<string, string>;
    expect(JSON.stringify({ headers, body: calls[0].init.body })).not.toContain(terminalPrivateKey);
    const canonical = [
      "v1",
      "POST",
      "/api/pos/orders/claim",
      config.terminalCode,
      headers["x-yamzo-timestamp"],
      headers["x-yamzo-nonce"],
      headers["x-yamzo-body-sha256"]
    ].join("\n");
    expect(
      verify(
        null,
        Buffer.from(canonical, "utf8"),
        terminalKeyPair.publicKey,
        Buffer.from(headers["x-yamzo-signature"], "base64url")
      )
    ).toBe(true);
  });

  it("pushes order transitions and print acknowledgements in local event order", async () => {
    const paths: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      paths.push(new URL(String(input)).pathname);
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ accepted: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const transport = new WebsiteOrderHttpTransport(config, {
      fetchImpl: fetchImpl as typeof fetch,
      now: () => 1_786_176_000_000,
      nonceBytes: () => Buffer.alloc(18, 8)
    });
    const events: WebsiteOutboxEvent[] = [
      {
        id: 1,
        eventKey: "21b417b8-0e38-4d92-a57b-0da15558650d",
        remoteOrderId: "7c4fdac0-687f-4a34-a143-f16c5f7e7833",
        eventType: "order.accepted",
        payload: { status: "accepted", expectedVersion: 1, posOrderNumber: "YZ-1" },
        attempts: 0,
        createdAt: "2026-08-08T09:00:00.000Z"
      },
      {
        id: 2,
        eventKey: "c936190b-fb5b-48d2-b6ac-1590c9671d48",
        remoteOrderId: "7c4fdac0-687f-4a34-a143-f16c5f7e7833",
        eventType: "print.ack",
        payload: { kind: "kitchen_copy", succeeded: true, errorCode: null },
        attempts: 0,
        createdAt: "2026-08-08T09:00:01.000Z"
      }
    ];

    expect(await transport.pushEvents(events)).toEqual({ acceptedEventIds: [1, 2] });
    expect(paths).toEqual(["/api/pos/orders/transition", "/api/pos/print/ack"]);
    expect(bodies[0]).toMatchObject({
      eventKey: events[0].eventKey,
      orderId: events[0].remoteOrderId,
      toStatus: "accepted",
      expectedVersion: 1
    });
    expect(bodies[1]).toMatchObject({
      eventKey: events[1].eventKey,
      orderId: events[1].remoteOrderId,
      kind: "kitchen_copy",
      succeeded: true
    });
  });

  it("rejects non-loopback cleartext endpoints and incomplete environment config", () => {
    expect(() => new WebsiteOrderHttpTransport({ ...config, baseUrl: "http://yamzouttara.com" })).toThrow(/https/i);
    expect(() => loadWebsiteOrderHttpConfig(
      { YAMZO_WEBSITE_API_URL: config.baseUrl },
      () => terminalKeyPair.privateKey
    )).toThrow(/incomplete/i);
    expect(loadWebsiteOrderHttpConfig({}, () => terminalKeyPair.privateKey)).toBeNull();
    expect(loadWebsiteOrderHttpConfig({
      YAMZO_WEBSITE_API_URL: config.baseUrl,
      YAMZO_POS_TERMINAL_CODE: config.terminalCode
    }, () => terminalKeyPair.privateKey)).toMatchObject({
      baseUrl: config.baseUrl,
      terminalCode: config.terminalCode,
      includeTestOrders: false
    });
  });

  it("uses the same deterministic signing primitive exported for diagnostics", () => {
    const headers = buildSignedRequestHeaders(
      { terminalCode: config.terminalCode },
      terminalKeyPair.privateKey,
      "/api/pos/print/ack",
      "{}",
      1_786_176_000,
      Buffer.alloc(18, 9)
    );
    expect(headers["x-yamzo-signature"]).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(headers["x-yamzo-body-sha256"]).toBe(createHash("sha256").update("{}").digest("hex"));
  });

  it("bounds remote response bodies before parsing them", async () => {
    const transport = new WebsiteOrderHttpTransport(config, {
      fetchImpl: (async () => new Response("x".repeat(1024 * 1024 + 1), {
        status: 200,
        headers: { "content-type": "application/json" }
      })) as typeof fetch
    });
    await expect(transport.pullOrders(null, 20)).rejects.toThrow(/oversized response/i);
  });
});

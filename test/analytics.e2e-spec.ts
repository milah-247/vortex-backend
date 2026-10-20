import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./utils/create-test-app";
import { AnalyticsService } from "../src/analytics/analytics.service";
import { ANALYTICS_METRICS } from "../src/analytics/analytics.types";
import { Intent } from "../src/intents/intents.types";

/** Issues #593, #594, #596: new metrics and CSV output on GET /api/v1/analytics/:metric. */
describe("AnalyticsController (e2e)", () => {
  let app: INestApplication;
  const from = Date.UTC(2026, 0, 1) / 1000;
  const to = Date.UTC(2026, 0, 2) / 1000;
  const range = `interval=1h&from=${from}&to=${to}`;

  function filled(id: string, overrides: Partial<Intent>): Intent {
    return {
      intentId: id,
      user: "GANALYTICSE2E",
      srcChain: "ethereum",
      srcToken: {
        address: "0xUSDC",
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        chain: "ethereum",
      },
      srcAmount: "1000000",
      dstToken: { contract: "CDST", symbol: "USDC", decimals: 7 },
      minDstAmount: "990000",
      state: "filled",
      createdAt: from + 3600,
      filledAt: from + 3630,
      deadline: from + 7200,
      fillAmount: "9900",
      feeAmount: "10",
      solver: "GSOLVER_A",
      version: 0,
      srcVerified: true,
      ...overrides,
    } as Intent;
  }

  beforeAll(async () => {
    app = await createTestApp();
    await app.get(AnalyticsService).backfill([
      // Amounts above 2^53 check that CSV keeps base-unit strings exact.
      filled("e2e-1", {
        quotedDstAmount: "10000",
        fillAmount: "9007199254740993",
      }),
      filled("e2e-2", {
        srcChain: "base",
        quotedDstAmount: "10000",
        fillAmount: "10100",
      }),
      filled("e2e-3", {
        quotedDstAmount: undefined,
        filledAt: from + 7300,
        createdAt: from + 7200,
      }),
    ]);
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();

  function parseCsv(text: string): string[][] {
    return text
      .trim()
      .split("\n")
      .map((line) => line.split(","));
  }

  it.each([...ANALYTICS_METRICS])(
    "GET %s?format=csv matches the JSON field names and row count",
    async (metric) => {
      const json = await request(server())
        .get(`/api/v1/analytics/${metric}?${range}`)
        .expect(200);
      const csv = await request(server())
        .get(`/api/v1/analytics/${metric}?${range}&format=csv`)
        .expect(200);

      expect(csv.headers["content-type"]).toMatch(/^text\/csv/);
      expect(csv.headers["content-disposition"]).toContain(
        `analytics-${metric}-1h-`,
      );

      const points = json.body as Record<string, unknown>[];
      expect(points.length).toBeGreaterThan(0);
      const [header, ...rows] = parseCsv(csv.text);
      expect(header).toEqual(Object.keys(points[0]));
      expect(rows).toHaveLength(points.length);
      rows.forEach((row, i) =>
        expect(row).toEqual(header.map((k) => String(points[i][k]))),
      );
    },
  );

  it("keeps base-unit volumes exact in CSV (no Number() coercion)", async () => {
    const csv = await request(server())
      .get(`/api/v1/analytics/chain-pair?${range}&format=csv`)
      .expect(200);
    expect(csv.text).toContain("ethereum,stellar,9007199254740993");
  });

  it("returns CSV for Accept: text/csv and JSON by default", async () => {
    const viaAccept = await request(server())
      .get(`/api/v1/analytics/volume?${range}`)
      .set("Accept", "text/csv")
      .expect(200);
    expect(viaAccept.headers["content-type"]).toMatch(/^text\/csv/);

    const plain = await request(server())
      .get(`/api/v1/analytics/volume?${range}`)
      .expect(200);
    expect(plain.headers["content-type"]).toMatch(/^application\/json/);
    expect(Array.isArray(plain.body)).toBe(true);
  });

  it("chain-pair reports corridors and honours srcChain/dstChain", async () => {
    const all = await request(server())
      .get(`/api/v1/analytics/chain-pair?${range}`)
      .expect(200);
    expect(all.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          srcChain: "base",
          dstChain: "stellar",
          volume: "10100",
        }),
        expect.objectContaining({ srcChain: "ethereum", dstChain: "stellar" }),
      ]),
    );

    const base = await request(server())
      .get(
        `/api/v1/analytics/chain-pair?${range}&srcChain=base&dstChain=stellar`,
      )
      .expect(200);
    expect(base.body).toHaveLength(1);
    expect(base.body[0].srcChain).toBe("base");
  });

  it("slippage excludes fills that had no quote", async () => {
    const res = await request(server())
      .get(`/api/v1/analytics/slippage?interval=1d&from=${from}&to=${to}`)
      .expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ count: 2, excludedCount: 1 });
  });

  it("rejects srcChain/dstChain on metrics other than chain-pair", async () => {
    await request(server())
      .get(`/api/v1/analytics/volume?${range}&dstChain=stellar`)
      .expect(400);
  });

  it("rejects an unknown format", async () => {
    await request(server())
      .get(`/api/v1/analytics/volume?${range}&format=xml`)
      .expect(400);
  });
});

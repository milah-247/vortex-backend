import { AnalyticsService } from "./analytics.service";
import { InMemoryAnalyticsStore } from "./analytics.store";
import { Intent } from "../intents/intents.types";

function filledIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    intentId: "intent-1",
    user: "GUSER1",
    srcChain: "stellar",
    srcToken: { address: "CUSDC", symbol: "USDC", name: "USD Coin", decimals: 7, chain: "stellar" },
    srcAmount: "1000000",
    dstToken: { contract: "CDST", symbol: "USDC", decimals: 7 },
    minDstAmount: "990000",
    state: "filled",
    createdAt: 1_000_000,
    deadline: 1_001_800,
    filledAt: 1_000_030,
    fillAmount: "5000000",
    feeAmount: "250",
    solver: "SOLVER_A",
    version: 0,
    srcVerified: true,
    ...overrides,
  };
}

function makeService() {
  const store = new InMemoryAnalyticsStore();
  const service = new AnalyticsService(store);
  return { service, store };
}

describe("AnalyticsService", () => {
  it("recordFill ingests a filled intent and ignores non-filled ones", async () => {
    const { service, store } = makeService();

    const inserted = await service.recordFill(filledIntent());
    const ignored = await service.recordFill(filledIntent({ state: "open", intentId: "intent-2" }));

    expect(inserted).toBe(1);
    expect(ignored).toBe(0);

    const points = await store.queryVolume({
      interval: "1d",
      from: 1_000_000 * 1000,
      to: 1_010_000 * 1000,
    });
    expect(points[0].volume).toBe("5000000");
  });

  it("backfill replays historical fills and is idempotent", async () => {
    const { service } = makeService();
    const intents = [
      filledIntent({ intentId: "a", fillAmount: "100" }),
      filledIntent({ intentId: "b", fillAmount: "200" }),
      filledIntent({ intentId: "c", state: "cancelled", fillAmount: "999" }), // ignored
    ];

    const first = await service.backfill(intents);
    const second = await service.backfill(intents);

    expect(first).toBe(2);
    expect(second).toBe(0);
  });

  it("maps duration from filledAt - createdAt in milliseconds", async () => {
    const { service, store } = makeService();
    await service.recordFill(filledIntent({ createdAt: 1_000_000, filledAt: 1_000_030 }));

    const points = await store.queryLatency({
      interval: "1d",
      from: 1_000_000 * 1000,
      to: 1_010_000 * 1000,
    });
    expect(points[0].avgMs).toBe(30_000);
    expect(points[0].count).toBe(1);
  });

  it("records the Stellar destination chain for chain-pair queries", async () => {
    const { service } = makeService();
    await service.recordFill(filledIntent({ srcChain: "ethereum" }));

    const points = await service.getChainPair({ interval: "1d", from: 0, to: 2_000_000_000_000 });
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ srcChain: "ethereum", dstChain: "stellar", volume: "5000000" });
  });

  it("carries quotedDstAmount into slippage and excludes intents without a quote", async () => {
    const { service } = makeService();
    await service.backfill([
      filledIntent({ intentId: "quoted", quotedDstAmount: "5050000", fillAmount: "5000000" }),
      filledIntent({ intentId: "unquoted", quotedDstAmount: undefined }),
    ]);

    const [point] = await service.getSlippage({ interval: "1d", from: 0, to: 2_000_000_000_000 });
    // (5_050_000 - 5_000_000) / 5_050_000 = 99.0099… bps, truncated to 99.
    expect(point).toMatchObject({ avgBps: 99, p95Bps: 99, count: 1, excludedCount: 1 });
  });
});

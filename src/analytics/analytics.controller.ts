import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Param,
  Query,
  Res,
} from "@nestjs/common";
import { ApiOperation, ApiParam, ApiProduces, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { analyticsToCsv } from "./analytics-csv";
import { AnalyticsService } from "./analytics.service";
import {
  ANALYTICS_METRICS,
  AnalyticsMetric,
  AnalyticsQuery,
} from "./analytics.types";
import { AnalyticsQueryDto } from "./dto/analytics-query.dto";

@ApiTags("analytics")
@Controller({ path: "analytics", version: "1" })
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get(":metric")
  @ApiOperation({
    summary:
      "Query an analytics aggregate (volume, fees, latency, solver-share, chain-pair, or slippage)",
    description:
      "Returns JSON by default. Pass `?format=csv` (or `Accept: text/csv`) to download the same points as CSV.",
  })
  @ApiParam({ name: "metric", enum: ANALYTICS_METRICS })
  @ApiProduces("application/json", "text/csv")
  async get(
    @Param("metric") metric: string,
    @Query() query: AnalyticsQueryDto,
    @Res({ passthrough: true }) res: Response,
    @Headers("accept") accept?: string,
  ) {
    const normalized = metric.toLowerCase() as AnalyticsMetric;
    if (!ANALYTICS_METRICS.includes(normalized)) {
      throw new BadRequestException(
        `Unknown analytics metric "${metric}". Expected one of: ${ANALYTICS_METRICS.join(", ")}`,
      );
    }
    if (normalized !== "chain-pair" && (query.srcChain || query.dstChain)) {
      throw new BadRequestException(
        "srcChain and dstChain are only supported by the chain-pair metric",
      );
    }

    const q: AnalyticsQuery = {
      interval: query.interval,
      // DTO accepts Unix epoch seconds; the store works in epoch milliseconds.
      from: query.from * 1000,
      to: query.to * 1000,
      chain: query.chain,
      token: query.token,
      srcChain: query.srcChain,
      dstChain: query.dstChain,
    };

    const points = await this.query(normalized, q);

    // An explicit ?format wins; otherwise honour an Accept header asking for CSV.
    const wantsCsv = query.format
      ? query.format === "csv"
      : /\btext\/csv\b/i.test(accept ?? "");
    if (!wantsCsv) return points;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="analytics-${normalized}-${query.interval}-${query.from}-${query.to}.csv"`,
    );
    return analyticsToCsv(normalized, points).toString("utf8");
  }

  private query(metric: AnalyticsMetric, q: AnalyticsQuery): Promise<object[]> {
    switch (metric) {
      case "volume":
        return this.analyticsService.getVolume(q);
      case "fees":
        return this.analyticsService.getFees(q);
      case "latency":
        return this.analyticsService.getLatency(q);
      case "solver-share":
        return this.analyticsService.getSolverShare(q);
      case "chain-pair":
        return this.analyticsService.getChainPair(q);
      case "slippage":
        return this.analyticsService.getSlippage(q);
    }
  }
}

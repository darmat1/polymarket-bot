import {
  type ApiKeyCreds,
  type OpenOrder,
  type OpenOrderParams,
} from "@polymarket/clob-client-v2";

import { type Settings } from "./config.js";
import {
  BasePolymarketClient,
  type PlaceOrderParams,
} from "./trading/base-polymarket-client.js";

export type { PlaceOrderParams } from "./trading/base-polymarket-client.js";

export class TradingClient extends BasePolymarketClient {
  constructor(settings: Settings) {
    super(settings);
  }

  withApiCreds(creds: ApiKeyCreds): TradingClient {
    return new TradingClient(this.createSettingsWithApiCreds(creds));
  }

  async getOrder(orderId: string): Promise<OpenOrder> {
    const client = this.buildAuthenticatedClient();
    return client.getOrder(orderId);
  }

  async getOpenOrders(
    params?: OpenOrderParams,
    onlyFirstPage = true,
    nextCursor?: string,
  ): Promise<OpenOrder[]> {
    const client = this.buildAuthenticatedClient();
    return client.getOpenOrders(params, onlyFirstPage, nextCursor);
  }

  async cancelOrder(orderId: string): Promise<unknown> {
    const client = this.buildAuthenticatedClient();
    return client.cancelOrder({ orderID: orderId });
  }

  async cancelOrders(orderIds: string[]): Promise<unknown> {
    const client = this.buildAuthenticatedClient();
    return client.cancelOrders(orderIds);
  }
}

import { HttpApiGroup } from "effect/http-api";
import { customerPassPurchaseEndpoints } from "./customer-pass-purchase-api";
import { customerPassReadEndpoints } from "./customer-pass-reads-api";

/** Passes have their own catalog and orders, separate from booking. */
export const CustomerPassesApi = HttpApiGroup.make("passes")
  .add(...customerPassReadEndpoints)
  .add(...customerPassPurchaseEndpoints)
  .prefix("/passes");

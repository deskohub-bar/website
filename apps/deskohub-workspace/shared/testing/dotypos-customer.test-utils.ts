import {
  DotyposCloudIdSchema,
  type DotyposCustomer,
  type DotyposCustomerId,
} from "@deskohub/dotypos";

export const dotyposCustomerFixture = (
  id: DotyposCustomerId,
  fields: Partial<DotyposCustomer> = {}
): DotyposCustomer => ({
  id,
  _cloudId: DotyposCloudIdSchema.make("cloud-1"),
  points: null,
  flags: "0",
  display: true,
  deleted: false,
  ...fields,
});

export const allowsMockPaymentProvider = (environment: {
  readonly VERCEL_ENV: string;
  readonly VERCEL_AUTOMATION_BYPASS_SECRET?: string | undefined;
}) =>
  environment.VERCEL_ENV === "preview" &&
  !!environment.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();

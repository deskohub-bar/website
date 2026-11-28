import { testEmailAddress } from "@deskohub/test-email";

export const workspaceE2ETableMinimumSeats = 2;
export const workspaceE2ETablePreferredSeats = 4;
export const workspaceE2ETablePreferredStartTime = "10:00";
export const workspaceE2ETablePreferredEndTime = "12:00";
export const workspaceE2ETableMinimumDurationMinutes = 60;

/**
 * The people a Team Table checkout adds during Step 1 beside its contact.
 * Leaves at least one seat open so the paid E2E case can also exercise
 * post-confirmation invitee addition on the status page.
 */
export const getWorkspaceE2ETableCheckoutInvitees = (seats: number) =>
  seats >= 3 ? [testEmailAddress("table-invitee-1")] : [];

/**
 * The synthetic invitee added on the confirmed Team Table status page after
 * payment fulfillment.
 */
export const getWorkspaceE2ETableStatusAddedInvitee = () =>
  testEmailAddress("table-status-invitee-1");

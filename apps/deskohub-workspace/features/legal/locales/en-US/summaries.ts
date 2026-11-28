import type {
  LegalDocumentKey,
  LegalDocumentSummary,
} from "../../legal-document-summaries";

export const legalDocumentSummaries = {
  "privacy-policy": {
    title: "Privacy Policy",
    lead: "This page explains how Desktechub s.r.o. handles personal data on the Deskohub Workspace website, including customer accounts, contact forms, and reservations.",
  },
  "marketing-communications": {
    title: "Marketing Communications Consent",
    lead: "This notice explains the optional consent for future Deskohub Workspace marketing and community communications by email from Desktechub s.r.o.",
  },
  "terms-and-conditions": {
    title: "General Terms and Conditions",
    lead: "These General Terms and Conditions govern coworking entries and online bookings of the meeting room, private office, and Team Table at Deskohub Workspace.",
  },
  "cookie-policy": {
    title: "Cookie Policy",
    lead: "This page explains how the Deskohub Workspace website uses cookies and how you can manage your preferences.",
  },
  "operating-rules": {
    title: "House Rules",
    lead: "These House Rules govern conduct and the use of Deskohub Workspace coworking spaces, meeting room, private office, and event spaces. They also cover how to share Open Space and when to move to another seat for a Team Table booking.",
  },
} satisfies Record<LegalDocumentKey, LegalDocumentSummary>;

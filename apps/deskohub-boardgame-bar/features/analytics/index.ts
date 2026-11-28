/**
 * Analytics Feature Module
 * Public API exports
 */

export { useGTMPageView } from "./hooks/use-gtm";
export {
  type GTMEvent,
  sendGTMEvent,
  trackButtonClick,
  trackFormSubmit,
  trackPageView,
} from "./utils/gtm-events";

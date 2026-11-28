import type { EmailPreviewRenderer } from "./email-preview-panel";
import type { previewEmailDraft } from "./preview-actions";

/**
 * The editor's preview prop takes the preview action as it is, so a host
 * page wires the two together without an adapter.
 */
type PreviewActionFitsEditor =
  typeof previewEmailDraft extends EmailPreviewRenderer ? true : false;

void (() => {
  void (true satisfies PreviewActionFitsEditor);
});

"use client";

import type { EmailValueSnapshot } from "@deskohub/workspace-admin-api";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useWatch } from "react-hook-form";
import { m } from "@/features/administration/i18n";
import type { Locale } from "@/features/i18n";
import { useRouteLocale } from "@/features/i18n/route-locale";
import {
  type EmailDraftFormValues,
  useEmailDraftForm,
} from "./email-draft-form";
import { useEmailEditor } from "./email-editor-context";
import { emailEditorLanguageName } from "./email-editor-problems";

/** Sample values for the preview, by value name. */
export type EmailPreviewValues = Readonly<
  Record<string, typeof EmailValueSnapshot.Encoded>
>;

/** One rendered preview: the subject line and the email's HTML. */
type EmailPreview = { readonly subject: string; readonly html: string };

/**
 * Renders the unsaved draft in one language with sample values. The
 * `previewEmailDraft` Server Action fits: `serverError` is already worded
 * for the administrator.
 */
export type EmailPreviewRenderer = (input: {
  readonly draft: EmailDraftFormValues;
  readonly locale: Locale;
  readonly values?: EmailPreviewValues;
  readonly omittedFields?: readonly string[];
}) => Promise<{
  readonly data?: EmailPreview;
  readonly serverError?: string;
}>;

const previewDelayMs = 500;

/** The outcome of one preview request. */
type PreviewResult = {
  /** The request it answers, to tell a current result from an old one. */
  readonly request: string;
  readonly locale: Locale;
} & (
  | { readonly preview: EmailPreview; readonly error?: never }
  | { readonly error: string; readonly preview?: never }
);

/**
 * Renders the draft in the active language with sample values after editing
 * pauses. Only the latest request's answer counts; an older one arriving late
 * is dropped, and a failure replaces the old picture.
 */
const conditionFieldKeys = (draft: EmailDraftFormValues): readonly string[] => {
  const keys = new Set<string>();
  for (const component of draft.structure ?? []) {
    if (!component.when?.name) continue;
    const key = [component.when.name, ...(component.when.field ?? [])]
      .filter(Boolean)
      .join(".");
    if (key) keys.add(key);
  }
  return [...keys];
};

const useEmailPreview = ({
  renderPreview,
  values,
  omittedFields,
}: {
  readonly renderPreview: EmailPreviewRenderer;
  readonly values: EmailPreviewValues | undefined;
  readonly omittedFields: readonly string[];
}) => {
  const locale = useRouteLocale();
  const { activeLocale } = useEmailEditor();
  const { control, getValues } = useEmailDraftForm();
  useWatch({ control });
  const draft = getValues();
  const activeOmitted = omittedFields.length > 0 ? omittedFields : undefined;
  const requestKey = JSON.stringify([
    activeLocale,
    draft,
    values,
    activeOmitted,
  ]);
  // Any change of input outdates the requests already sent.
  const latestRequest = useRef(requestKey);
  const [result, setResult] = useState<PreviewResult>();

  const renderLatest = useEffectEvent(() => {
    const failed = m.emailsEditorPreviewFailed({}, { locale });
    const settle = (
      outcome: { readonly preview: EmailPreview } | { readonly error: string }
    ) => {
      if (latestRequest.current !== requestKey) return;
      setResult({ request: requestKey, locale: activeLocale, ...outcome });
    };
    renderPreview({
      draft,
      locale: activeLocale,
      values,
      ...(activeOmitted && { omittedFields: activeOmitted }),
    }).then(
      (answer) =>
        settle(
          answer.data
            ? { preview: answer.data }
            : { error: answer.serverError ?? failed }
        ),
      () => settle({ error: failed })
    );
  });

  useEffect(() => {
    latestRequest.current = requestKey;
    const timer = setTimeout(renderLatest, previewDelayMs);
    return () => clearTimeout(timer);
  }, [requestKey]);

  return {
    activeLocale,
    conditionalFields: conditionFieldKeys(draft),
    // Another language's picture never shows under this language's heading.
    shown: result?.locale === activeLocale ? result : undefined,
    current: result?.request === requestKey,
  };
};

/** The preview's failure, its subject line and the email in a sandboxed frame. */
function EmailPreviewPicture({
  contentLocale,
  language,
  shown,
}: {
  readonly contentLocale: Locale;
  /** The name of `contentLocale` in the administrator's language. */
  readonly language: string;
  readonly shown: PreviewResult | undefined;
}) {
  const locale = useRouteLocale();
  return (
    <>
      <div className="mb-2 text-sm" role="alert">
        {shown?.error && (
          <p className="text-burned-orange-ink">{shown.error}</p>
        )}
      </div>
      {shown?.preview && (
        <p className="mb-2 truncate font-medium text-navy-blue text-sm">
          {m.emailsEditorPreviewSubject(
            { subject: shown.preview.subject },
            { locale }
          )}
        </p>
      )}
      <iframe
        className="h-[640px] w-full rounded-md border border-navy-blue/10 bg-white"
        lang={contentLocale}
        sandbox=""
        srcDoc={shown?.preview?.html ?? ""}
        title={m.emailsEditorPreviewFrameTitle({ language }, { locale })}
      />
    </>
  );
}

/**
 * The draft as a recipient would see it in the active language, rendered
 * with sample values after editing pauses. Only the latest request's answer
 * shows; an older one arriving late is dropped, and a failure clears the
 * old picture rather than leaving it under a new heading.
 */
export function EmailPreviewPanel({
  renderPreview,
  values,
}: {
  readonly renderPreview: EmailPreviewRenderer;
  readonly values?: EmailPreviewValues;
}) {
  const locale = useRouteLocale();
  const [omittedFields, setOmittedFields] = useState<readonly string[]>([]);
  const { activeLocale, conditionalFields, shown, current } = useEmailPreview({
    renderPreview,
    values,
    omittedFields,
  });
  const language = emailEditorLanguageName(activeLocale);
  const toggleField = (fieldKey: string) =>
    setOmittedFields((previous) =>
      previous.includes(fieldKey)
        ? previous.filter((item) => item !== fieldKey)
        : [...previous, fieldKey]
    );
  return (
    <section
      aria-labelledby="email-editor-preview-heading"
      className="rounded-xl border border-navy-blue/10 bg-white p-5"
    >
      <h2
        className="mb-1 font-semibold text-navy-blue/65 text-xs uppercase tracking-[0.1em]"
        id="email-editor-preview-heading"
      >
        {m.emailsEditorPreviewHeading({}, { locale })} · {language}
      </h2>
      <p className="mb-3 rounded-md bg-sunset-yellow/15 px-3 py-2 text-navy-blue/80 text-xs">
        {m.emailsEditorPreviewSampleNote({}, { locale })}
      </p>
      {conditionalFields.length > 0 && (
        <fieldset className="mb-3 space-y-1.5 rounded-md border border-navy-blue/10 px-3 py-2">
          <legend className="px-1 font-medium text-navy-blue/70 text-xs">
            {m.emailsEditorPreviewOptionalFieldsLabel({}, { locale })}
          </legend>
          <div className="flex flex-wrap gap-3">
            {conditionalFields.map((fieldKey) => (
              <label
                key={fieldKey}
                className="flex cursor-pointer items-center gap-1.5 font-mono text-navy-blue text-xs"
              >
                <input
                  checked={!omittedFields.includes(fieldKey)}
                  className="size-3.5 accent-[var(--brand-burned-orange)]"
                  onChange={() => toggleField(fieldKey)}
                  type="checkbox"
                />
                {fieldKey}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <p className="sr-only" role="status">
        {current
          ? shown?.preview && m.emailsEditorPreviewUpdated({}, { locale })
          : m.emailsEditorPreviewUpdating({}, { locale })}
      </p>
      <EmailPreviewPicture
        contentLocale={activeLocale}
        language={language}
        shown={shown}
      />
    </section>
  );
}

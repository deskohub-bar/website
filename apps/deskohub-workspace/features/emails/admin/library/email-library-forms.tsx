"use client";

import { effectSchemaResolver } from "@deskohub/effect-schema-resolver";
import {
  administrationInputParseOptions,
  EmailDraft,
  type EmailId,
} from "@deskohub/workspace-admin-api";
import { useRouter } from "next/navigation";
import { type BaseSyntheticEvent, useId, useRef, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { m } from "@/features/administration/i18n";
import { locales } from "@/features/i18n";
import { useRouteLocale } from "@/features/i18n/route-locale";
import { getLocalizedPagePath } from "@/features/i18n/routing";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { useWorkspaceAction } from "@/shared/utils/use-workspace-action";
import {
  type EmailDraftFormValues,
  EmailEditor,
  type EmailEditorDiscount,
} from "../editor";
import { previewEmailDraft } from "../editor/preview-actions";
import {
  createReusableEmail,
  writeReusableEmail,
} from "./email-library-actions";

export function CreateReusableEmailForm() {
  const locale = useRouteLocale();
  const titleId = useId();
  const router = useRouter();
  const form = useForm({ defaultValues: { title: "" } });
  const [error, setError] = useState<string>();
  const create = useWorkspaceAction(createReusableEmail, {
    onSuccess: ({ data }) => {
      if (data)
        router.push(
          getLocalizedPagePath(
            locale,
            "/[locale]/admin/email-campaigns/library/[emailId]",
            { emailId: data.emailId }
          )
        );
    },
    onError: ({ error }) =>
      setError(
        error.serverError ?? m.emailsActionFailedUnexpectedly({}, { locale })
      ),
  });
  return (
    <form
      className="flex max-w-lg flex-wrap items-end gap-3"
      onSubmit={form.handleSubmit(({ title }) => {
        setError(undefined);
        const trimmed = title.trim();
        if (trimmed) create.execute({ title: trimmed });
        else setError(m.emailsLibraryTitleRequired({}, { locale }));
      })}
    >
      <div className="min-w-48 flex-1 space-y-2">
        <Label htmlFor={titleId}>{m.emailsLibraryTitle({}, { locale })}</Label>
        <Input
          id={titleId}
          required
          disabled={create.isExecuting}
          {...form.register("title")}
        />
      </div>
      <Button type="submit" disabled={create.isExecuting}>
        {m.emailsLibraryCreate({}, { locale })}
      </Button>
      <p
        className="w-full text-burned-orange-ink text-sm empty:hidden"
        role="alert"
      >
        {error}
      </p>
    </form>
  );
}

export function ReusableEmailForm({
  draft,
  emailId,
  discounts,
  imageCloudName,
  publishedImageSources,
  publishedVersion,
}: {
  readonly draft: EmailDraftFormValues;
  readonly emailId: EmailId;
  readonly discounts: readonly EmailEditorDiscount[];
  readonly imageCloudName: string | undefined;
  readonly publishedImageSources: readonly string[];
  readonly publishedVersion: number | null;
}) {
  const locale = useRouteLocale();
  const router = useRouter();
  const form = useForm<EmailDraftFormValues, unknown, EmailDraft>({
    defaultValues: draft,
    resolver: effectSchemaResolver(EmailDraft, administrationInputParseOptions),
  });
  const submittedDraft = useRef<EmailDraftFormValues>(draft);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const save = useWorkspaceAction(writeReusableEmail, {
    onSuccess: ({ data }) => {
      if (!data) return;
      form.reset(submittedDraft.current, { keepValues: true });
      setNotice(
        data.publishedVersion === null
          ? m.emailsLibraryDraftSaved({}, { locale })
          : m.emailsLibraryPublishedVersion(
              { version: data.publishedVersion },
              { locale }
            )
      );
      if (data.publishedVersion !== null) router.refresh();
    },
    onError: ({ error }) =>
      setError(
        error.serverError ?? m.emailsActionFailedUnexpectedly({}, { locale })
      ),
  });
  const write = (publish: boolean, event?: BaseSyntheticEvent) => {
    void form.handleSubmit(
      (resolved) => {
        setNotice(undefined);
        setError(undefined);
        submittedDraft.current = form.getValues();
        save.execute({ emailId, draft: resolved, publish });
      },
      () => setError(m.emailsLibraryPublicationInvalid({}, { locale }))
    )(event);
  };
  return (
    <FormProvider {...form}>
      <form
        className="space-y-6"
        noValidate
        onSubmit={(event) => write(false, event)}
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={save.isExecuting} variant="secondary">
            {m.emailsLibrarySaveDraft({}, { locale })}
          </Button>
          <Button
            type="button"
            disabled={save.isExecuting}
            onClick={() => write(true)}
          >
            {m.emailsLibraryPublish({}, { locale })}
          </Button>
          <p className="text-navy-blue/65 text-sm" role="status">
            {notice ??
              (publishedVersion === null
                ? m.emailsLibraryUnpublished({}, { locale })
                : m.emailsLibraryPublishedVersion(
                    { version: publishedVersion },
                    { locale }
                  ))}
          </p>
        </div>
        <p className="text-burned-orange-ink text-sm empty:hidden" role="alert">
          {error}
        </p>
        <div inert={save.isExecuting}>
          <EmailEditor
            discounts={discounts}
            locales={locales}
            publishedImageSources={publishedImageSources}
            renderPreview={previewEmailDraft}
            {...(imageCloudName && { imageCloudName })}
          />
        </div>
      </form>
    </FormProvider>
  );
}

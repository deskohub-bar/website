import { AdministrationLink } from "@/features/administration/admin-link";
import { administrationHref } from "@/features/administration/administration-href";
import { AdministrationPage } from "@/features/administration/components";
import { m } from "@/features/administration/i18n";
import { getRequestLocale } from "@/features/i18n/server/request-locale";
import { textLink } from "@/shared/components/ui/text-link";
import {
  loadEmailLibrary,
  loadReusableEmail,
} from "./email-library-data.server";
import {
  CreateReusableEmailForm,
  ReusableEmailForm,
} from "./email-library-forms";

export async function EmailLibraryPage() {
  const [locale, emails] = await Promise.all([
    getRequestLocale(),
    loadEmailLibrary(),
  ]);
  return (
    <AdministrationPage className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-semibold text-2xl">
          {m.emailsLibraryHeading({}, { locale })}
        </h1>
        <AdministrationLink
          className={textLink()}
          href={administrationHref("/[locale]/admin/email-campaigns/new")}
        >
          {m.emailCampaignsListNewCampaign({}, { locale })}
        </AdministrationLink>
      </div>
      <CreateReusableEmailForm />
      {emails.length > 0 && (
        <ul className="divide-y divide-navy-blue/10 rounded-lg border border-navy-blue/10">
          {emails.map(({ emailId, title, publishedVersion }) => (
            <li
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              key={emailId}
            >
              <AdministrationLink
                className={textLink()}
                href={administrationHref(
                  "/[locale]/admin/email-campaigns/library/[emailId]",
                  { emailId }
                )}
              >
                {title}
              </AdministrationLink>
              <span className="text-navy-blue/65 text-sm">
                {publishedVersion === null
                  ? m.emailsLibraryUnpublished({}, { locale })
                  : m.emailsLibraryPublishedVersion(
                      { version: publishedVersion },
                      { locale }
                    )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </AdministrationPage>
  );
}

export async function ReusableEmailPage({
  params,
}: {
  readonly params: Promise<{ readonly emailId: string }>;
}) {
  const { emailId } = await params;
  const [locale, email] = await Promise.all([
    getRequestLocale(),
    loadReusableEmail(emailId),
  ]);
  return (
    <AdministrationPage className="space-y-6">
      <AdministrationLink
        className={textLink()}
        href={administrationHref("/[locale]/admin/email-campaigns/library")}
      >
        {m.emailsLibraryHeading({}, { locale })}
      </AdministrationLink>
      <h1 className="font-semibold text-2xl">{email.title}</h1>
      <ReusableEmailForm {...email} />
    </AdministrationPage>
  );
}

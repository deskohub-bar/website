"use client";

import { useWatch } from "react-hook-form";
import { m } from "@/features/administration/i18n";
import type { Locale } from "@/features/i18n";
import { useRouteLocale } from "@/features/i18n/route-locale";
import { Label } from "@/shared/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/components/ui/select";
import {
  EmailBlockLabelText,
  EmailBlockTextSetting,
  useEmailBlock,
} from "./email-block-controls";
import { useEmailDraftForm } from "./email-draft-form";
import {
  EmailFieldProblems,
  useEmailFieldProblems,
} from "./email-editor-context";
import { emailEditorFieldIds } from "./email-editor-field-ids";
import { withEmailSetting } from "./email-structure-blocks";
import {
  emailUrlValueOptions,
  emailValueReferenceLabel,
} from "./email-value-options";
import { emailTriggerFieldLabel } from "./email-value-trigger-source";

/** A button's destination (static URL or dynamic link value) and its label in `contentLocale`. */
export function EmailBlockButtonSettings({
  contentLocale,
  index,
}: {
  readonly contentLocale: Locale;
  readonly index: number;
}) {
  const locale = useRouteLocale();
  const { control } = useEmailDraftForm();
  const definitions = useWatch({ control, name: "values" }) ?? [];
  const [component, update] = useEmailBlock(index);
  const urlOptions = emailUrlValueOptions(definitions);
  const hrefFieldId = emailEditorFieldIds.componentSetting(
    component?.id ?? "",
    "href"
  );
  const hrefProblems = useEmailFieldProblems(hrefFieldId);

  if (!component?.id) return null;

  const isDynamic = Boolean(component.hrefValue);
  const showModeToggle = urlOptions.length > 0 || isDynamic;
  const currentDynamicKey = component.hrefValue?.name
    ? emailValueReferenceLabel({
        name: component.hrefValue.name,
        field: component.hrefValue.field,
      })
    : "";

  const switchMode = (mode: "static" | "dynamic") => {
    if (mode === "static") {
      update(withEmailSetting(component, "hrefValue", undefined));
      return;
    }
    const first = urlOptions[0];
    const withoutHref = withEmailSetting(component, "href", undefined);
    update(
      withEmailSetting(
        withoutHref,
        "hrefValue",
        first
          ? {
              name: first.name,
              ...(first.field && { field: [...first.field] }),
            }
          : {}
      )
    );
  };

  const selectDynamicHref = (encoded: string) => {
    const option = urlOptions.find(
      (candidate) => emailValueReferenceLabel(candidate) === encoded
    );
    if (!option) return;
    const withoutHref = withEmailSetting(component, "href", undefined);
    update(
      withEmailSetting(withoutHref, "hrefValue", {
        name: option.name,
        ...(option.field && { field: [...option.field] }),
      })
    );
  };

  return (
    <div className="space-y-4">
      {showModeToggle && (
        <div className="space-y-1.5">
          <Label htmlFor={`${hrefFieldId}-mode`}>
            {m.emailsEditorBlockHrefModeLabel({}, { locale })}
          </Label>
          <Select
            onValueChange={(value) =>
              switchMode(value === "dynamic" ? "dynamic" : "static")
            }
            value={isDynamic ? "dynamic" : "static"}
          >
            <SelectTrigger id={`${hrefFieldId}-mode`} className="max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="static">
                {m.emailsEditorBlockHrefModeStatic({}, { locale })}
              </SelectItem>
              <SelectItem value="dynamic">
                {m.emailsEditorBlockHrefModeDynamic({}, { locale })}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      {isDynamic ? (
        <div className="space-y-1.5">
          <Label htmlFor={hrefFieldId}>
            {m.emailsEditorBlockHref({}, { locale })}
          </Label>
          <Select onValueChange={selectDynamicHref} value={currentDynamicKey}>
            <SelectTrigger
              id={hrefFieldId}
              className="max-w-md"
              {...hrefProblems.controlProps}
            >
              <SelectValue
                placeholder={m.emailsEditorBlockHrefValuePlaceholder(
                  {},
                  { locale }
                )}
              />
            </SelectTrigger>
            <SelectContent>
              {currentDynamicKey &&
                !urlOptions.some(
                  (option) =>
                    emailValueReferenceLabel(option) === currentDynamicKey
                ) && (
                  <SelectItem disabled value={currentDynamicKey}>
                    {m.emailsEditorBlockValueUnavailable(
                      { name: currentDynamicKey },
                      { locale }
                    )}
                  </SelectItem>
                )}
              {urlOptions.map((option) => {
                const label = emailValueReferenceLabel(option);
                const hint = option.field?.[0]
                  ? emailTriggerFieldLabel(option.field[0], locale)
                  : undefined;
                return (
                  <SelectItem key={label} value={label}>
                    <span className="font-mono">{label}</span>
                    {hint && (
                      <span className="ml-2 text-navy-blue/60 text-xs">
                        {hint}
                      </span>
                    )}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          <EmailFieldProblems fieldId={hrefFieldId} />
        </div>
      ) : (
        <EmailBlockTextSetting
          fieldId={hrefFieldId}
          label={m.emailsEditorBlockHref({}, { locale })}
          onChange={(href) => update(withEmailSetting(component, "href", href))}
          placeholder="https://"
          type="url"
          value={component.href}
        />
      )}
      <EmailBlockLabelText
        contentLocale={contentLocale}
        label={m.emailsEditorBlockButtonLabel({}, { locale })}
        textKey={component.labelKey}
      />
    </div>
  );
}

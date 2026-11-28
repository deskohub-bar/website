"use client";

import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import type { ComponentType } from "react";
import { useWatch } from "react-hook-form";
import { m } from "@/features/administration/i18n";
import type { Locale } from "@/features/i18n";
import { useRouteLocale } from "@/features/i18n/route-locale";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { Label } from "@/shared/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/components/ui/select";
import { EmailBlockButtonSettings } from "./email-block-button";
import { useEmailBlock } from "./email-block-controls";
import { EmailBlockImageSettings } from "./email-block-image";
import { EmailBlockRichTextSettings } from "./email-block-rich-text";
import { EmailBlockTextListSettings } from "./email-block-text-list";
import { EmailBlockValueSettings } from "./email-block-value-settings";
import {
  type EmailDraftComponent,
  type EmailDraftComponentTag,
  useEmailDraftForm,
} from "./email-draft-form";
import {
  EmailFieldProblems,
  useEmailFieldProblems,
} from "./email-editor-context";
import { emailEditorFieldIds } from "./email-editor-field-ids";
import {
  type EmailBlockChoice,
  emailBlockChoice,
  withEmailSetting,
} from "./email-structure-blocks";
import {
  emailScalarValueOptions,
  emailValueReferenceLabel,
} from "./email-value-options";

/** Each block kind's name, as the add menu and block headings show it. */
export const emailBlockKindLabels = {
  Paragraph: m.emailsEditorBlockParagraph,
  Heading: m.emailsEditorBlockHeading,
  BulletedList: m.emailsEditorBlockBulletedList,
  NumberedList: m.emailsEditorBlockNumberedList,
  Divider: m.emailsEditorBlockDivider,
  Spacer: m.emailsEditorBlockSpacer,
  Image: m.emailsEditorBlockImage,
  Button: m.emailsEditorBlockButton,
  Record: m.emailsEditorBlockRecord,
  List: m.emailsEditorBlockList,
  Offer: m.emailsEditorBlockOffer,
} as const satisfies Record<
  EmailBlockChoice,
  typeof m.emailsEditorBlockParagraph
>;

/** The id of a block's move or remove button, so focus can return to it. */
export const emailBlockActionId = (
  componentId: string,
  action: "move-up" | "move-down" | "remove"
) => `${emailEditorFieldIds.component(componentId)}-${action}`;

/** What a block without settings of its own shows instead. */
function EmailBlockNoSettings() {
  const locale = useRouteLocale();
  return (
    <p className="text-navy-blue/60 text-sm">
      {m.emailsEditorBlockNoSettings({}, { locale })}
    </p>
  );
}

/** The settings and texts one block kind has. */
function EmailBlockBody({
  component,
  contentLocale,
  index,
}: {
  readonly component: EmailDraftComponent;
  readonly contentLocale: Locale;
  readonly index: number;
}) {
  const Settings = (
    {
      Paragraph: EmailBlockRichTextSettings,
      Heading: EmailBlockRichTextSettings,
      TextList: EmailBlockTextListSettings,
      Image: EmailBlockImageSettings,
      Button: EmailBlockButtonSettings,
      Record: EmailBlockValueSettings,
      List: EmailBlockValueSettings,
      Offer: EmailBlockValueSettings,
      Divider: EmailBlockNoSettings,
      Spacer: EmailBlockNoSettings,
    } as const satisfies Record<
      EmailDraftComponentTag,
      ComponentType<{ readonly contentLocale: Locale; readonly index: number }>
    >
  )[component._tag];
  return <Settings contentLocale={contentLocale} index={index} />;
}

const alwaysVisibleValue = "__always__";

const encodeConditionChoice = (
  name: string,
  field: readonly string[] | undefined,
  present: boolean
) => JSON.stringify({ name, field: field ?? [], present });

function EmailBlockVisibilitySetting({ index }: { readonly index: number }) {
  const locale = useRouteLocale();
  const { control } = useEmailDraftForm();
  const definitions = useWatch({ control, name: "values" }) ?? [];
  const [component, update] = useEmailBlock(index);
  const options = emailScalarValueOptions(definitions);
  const whenFieldId = emailEditorFieldIds.componentSetting(
    component?.id ?? "",
    "when"
  );
  const problems = useEmailFieldProblems(whenFieldId);

  if (!component?.id || (options.length === 0 && !component.when)) return null;

  const currentChoice =
    component.when?.name && component.when.present !== undefined
      ? encodeConditionChoice(
          component.when.name,
          component.when.field,
          component.when.present
        )
      : alwaysVisibleValue;

  const choices = options.flatMap((option) => {
    const fieldLabel = emailValueReferenceLabel(option);
    return [
      {
        value: encodeConditionChoice(option.name, option.field, true),
        label: m.emailsEditorBlockVisibilityWhenPresent(
          { field: fieldLabel },
          { locale }
        ),
        condition: {
          name: option.name,
          ...(option.field && { field: [...option.field] }),
          present: true,
        },
      },
      {
        value: encodeConditionChoice(option.name, option.field, false),
        label: m.emailsEditorBlockVisibilityWhenMissing(
          { field: fieldLabel },
          { locale }
        ),
        condition: {
          name: option.name,
          ...(option.field && { field: [...option.field] }),
          present: false,
        },
      },
    ];
  });

  const handleSelect = (value: string) => {
    if (value === alwaysVisibleValue) {
      update(withEmailSetting(component, "when", undefined));
      return;
    }
    const chosen = choices.find((choice) => choice.value === value);
    if (chosen) update(withEmailSetting(component, "when", chosen.condition));
  };

  const currentLabel = component.when?.name
    ? emailValueReferenceLabel({
        name: component.when.name,
        field: component.when.field,
      })
    : "";

  return (
    <div className="space-y-1.5 border-navy-blue/8 border-t pt-3">
      <Label htmlFor={whenFieldId} className="text-navy-blue/70 text-xs">
        {m.emailsEditorBlockVisibilityLabel({}, { locale })}
      </Label>
      <Select onValueChange={handleSelect} value={currentChoice}>
        <SelectTrigger
          id={whenFieldId}
          className="h-8 max-w-md text-xs"
          {...problems.controlProps}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={alwaysVisibleValue}>
            {m.emailsEditorBlockVisibilityAlways({}, { locale })}
          </SelectItem>
          {currentChoice !== alwaysVisibleValue &&
            !choices.some((choice) => choice.value === currentChoice) && (
              <SelectItem disabled value={currentChoice}>
                {m.emailsEditorBlockValueUnavailable(
                  { name: currentLabel },
                  { locale }
                )}
              </SelectItem>
            )}
          {choices.map((choice) => (
            <SelectItem key={choice.value} value={choice.value}>
              {choice.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <EmailFieldProblems fieldId={whenFieldId} />
    </div>
  );
}

/**
 * One block of the body: its kind and number, buttons that move or remove
 * it, its shared settings, and its texts in `contentLocale`. The card is the
 * focus target of the block's problems that name no narrower field.
 */
export function EmailBlockCard({
  contentLocale,
  count,
  index,
  onMove,
  onRemove,
}: {
  readonly contentLocale: Locale;
  /** How many blocks the body has. */
  readonly count: number;
  readonly index: number;
  readonly onMove: (index: number, offset: -1 | 1) => void;
  readonly onRemove: (index: number) => void;
}) {
  const locale = useRouteLocale();
  const [component] = useEmailBlock(index);
  const componentId = component?.id ?? "";
  const fieldId = emailEditorFieldIds.component(componentId);
  const { controlProps } = useEmailFieldProblems(fieldId);
  if (!component) return null;
  const number = index + 1;
  const kind = emailBlockKindLabels[emailBlockChoice(component)](
    {},
    { locale }
  );
  const headingId = `${fieldId}-heading`;
  const conditionBadge =
    component.when?.name && component.when.present !== undefined
      ? (component.when.present
          ? m.emailsEditorBlockVisibilityBadgePresent
          : m.emailsEditorBlockVisibilityBadgeMissing)(
          {
            field: emailValueReferenceLabel({
              name: component.when.name,
              field: component.when.field,
            }),
          },
          { locale }
        )
      : undefined;
  const actions = [
    {
      action: "move-up",
      Icon: ArrowUp,
      label: m.emailsEditorBlockMoveUp,
      disabled: index === 0,
      run: () => onMove(index, -1),
    },
    {
      action: "move-down",
      Icon: ArrowDown,
      label: m.emailsEditorBlockMoveDown,
      disabled: index === count - 1,
      run: () => onMove(index, 1),
    },
    {
      action: "remove",
      Icon: Trash2,
      label: m.emailsEditorBlockRemove,
      disabled: false,
      run: () => onRemove(index),
    },
  ] as const;

  return (
    <li>
      {/* biome-ignore lint/a11y/useSemanticElements: the card's header and buttons don't fit a legend; the group only names the block's focus target. */}
      <div
        {...controlProps}
        aria-labelledby={headingId}
        className="rounded-xl border border-navy-blue/12 bg-white shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-burned-orange"
        id={fieldId}
        role="group"
        tabIndex={-1}
      >
        <header className="flex items-center gap-3 border-navy-blue/8 border-b px-4 py-2.5">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <h3
              className="min-w-0 truncate font-semibold text-navy-blue text-sm"
              id={headingId}
            >
              {m.emailsEditorBlockTitle({ kind, number }, { locale })}
            </h3>
            {conditionBadge && (
              <Badge
                className="px-1.5 py-0 font-mono text-[11px]"
                variant="subtle"
              >
                {conditionBadge}
              </Badge>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {actions.map(({ action, Icon, label, disabled, run }) => {
              const name = label({ number, kind }, { locale });
              return (
                <Button
                  aria-label={name}
                  disabled={disabled}
                  id={emailBlockActionId(componentId, action)}
                  key={action}
                  onClick={run}
                  size="icon-sm"
                  title={name}
                  tone="muted"
                  type="button"
                  variant="ghost"
                >
                  <Icon aria-hidden className="h-4 w-4" />
                </Button>
              );
            })}
          </div>
        </header>
        <div className="@container space-y-4 px-4 py-4">
          <EmailFieldProblems fieldId={fieldId} />
          <EmailBlockBody
            component={component}
            contentLocale={contentLocale}
            index={index}
          />
          <EmailBlockVisibilitySetting index={index} />
        </div>
      </div>
    </li>
  );
}

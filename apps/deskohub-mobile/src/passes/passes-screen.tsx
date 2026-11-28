import type { CustomerPassList } from "@deskohub/workspace-customer-api";
import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Exit } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useRouter } from "expo-router";
import { openBrowserAsync } from "expo-web-browser";
import CalendarRange from "lucide-react-native/icons/calendar-range";
import Mail from "lucide-react-native/icons/mail";
import Ticket from "lucide-react-native/icons/ticket";
import { StyleSheet, View } from "react-native";
import { apiOrigin } from "../auth/auth-client";
import { AsyncView } from "../customer-api/async-view";
import { useAppLocale } from "../i18n/locale-context";
import { m } from "../i18n/messages";
import { formatMoney } from "../i18n/money-format";
import { Badge } from "../ui/badge";
import { Card } from "../ui/card";
import { Button } from "../ui/controls";
import { ListGroup, ListRow, SectionHeader } from "../ui/list";
import { ScrollScreen } from "../ui/scroll-screen";
import { Text } from "../ui/text";
import { useToast } from "../ui/toast";
import { space } from "../ui/tokens";
import { HeldEntryPackCard, HeldUnlimitedPassCard } from "./held-pass-cards";
import { cheapestPackDay, passPeriod, passTierName } from "./pass-copy";
import {
  heldPassesAtom,
  passCatalogAtom,
  resendPassInvitationAtom,
} from "./pass-reads";
import {
  bookWithEntryPackHref,
  entryPackPurchaseHref,
  unlimitedAccessHref,
  unlimitedPurchaseHref,
} from "./pass-routes";

export function PassesScreen() {
  const locale = useAppLocale();
  const router = useRouter();
  const toast = useToast();
  const atom = heldPassesAtom(locale);
  const passes = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const catalog = useAtomValue(passCatalogAtom);

  const openRenewal = async (path: string) => {
    try {
      const url = new URL(path, apiOrigin);
      if (url.origin !== new URL(apiOrigin).origin) throw new Error();
      await openBrowserAsync(url.href);
    } catch {
      toast.show({
        message: m.passes_renew_failed({}, { locale }),
        tone: "neutral",
      });
    }
  };

  return (
    <ScrollScreen
      refreshing={passes.waiting && !AsyncResult.isInitial(passes)}
      onRefresh={refresh}
    >
      <AsyncView
        result={passes}
        onRetry={refresh}
        errorTitle={m.account_section_passes({}, { locale })}
        errorMessage={(error) =>
          error._tag === "FeatureUnavailable"
            ? m.passes_not_found({}, { locale })
            : undefined
        }
      >
        {(list) => {
          const current = list.held.filter(
            (pass) => pass.status === "active" || pass.status === "upcoming"
          );
          const previous = list.held.filter(
            (pass) => pass.status !== "active" && pass.status !== "upcoming"
          );
          return (
            <>
              <View style={styles.cards}>
                {current.map((pass) =>
                  pass.kind === "entry-pack" ? (
                    <HeldEntryPackCard
                      key={pass.passId}
                      pack={pass}
                      onBook={() =>
                        router.push(bookWithEntryPackHref(pass.passId))
                      }
                    />
                  ) : (
                    <HeldUnlimitedPassCard
                      key={pass.passId}
                      pass={pass}
                      onAccess={() =>
                        router.push(unlimitedAccessHref(pass.passId))
                      }
                      onRenew={() => {
                        if (pass.renewalPath !== undefined)
                          void openRenewal(pass.renewalPath);
                      }}
                    />
                  )
                )}
              </View>
              {list.boughtForOthers.length > 0 && (
                <>
                  <SectionHeader
                    title={m.passes_bought_others({}, { locale })}
                    description={m.passes_bought_others_description(
                      {},
                      { locale }
                    )}
                  />
                  <View style={styles.cards}>
                    {list.boughtForOthers.map((gift) => (
                      <GiftPurchaseCard key={gift.passId} gift={gift} />
                    ))}
                  </View>
                </>
              )}
              {AsyncResult.isSuccess(catalog) && (
                <PassPurchaseLinks catalog={catalog.value} />
              )}
              {previous.length > 0 && (
                <>
                  <SectionHeader title={m.passes_previous({}, { locale })} />
                  <ListGroup>
                    {previous.map((pass) => (
                      <ListRow
                        key={pass.passId}
                        label={m.passes_product_tier(
                          {
                            product:
                              pass.kind === "entry-pack"
                                ? m.passes_entry_pack({}, { locale })
                                : m.passes_unlimited({}, { locale }),
                            tier: passTierName(pass.tier, locale),
                          },
                          { locale }
                        )}
                        description={passPeriod(
                          pass.validFrom,
                          pass.lastUsableDate,
                          locale
                        )}
                        below={
                          <View style={styles.badge}>
                            <Badge
                              label={{
                                active: m.passes_active,
                                upcoming: m.passes_upcoming,
                                depleted: m.passes_depleted,
                                expired: m.passes_expired,
                                ended: m.passes_ended,
                              }[pass.status]({}, { locale })}
                              tone="neutral"
                            />
                            {pass.kind === "unlimited" &&
                              pass.renewalPath !== undefined && (
                                <Button
                                  label={m.passes_renew({}, { locale })}
                                  size="small"
                                  variant="secondary"
                                  width="content"
                                  onPress={() => {
                                    if (pass.renewalPath !== undefined)
                                      void openRenewal(pass.renewalPath);
                                  }}
                                />
                              )}
                          </View>
                        }
                      />
                    ))}
                  </ListGroup>
                </>
              )}
            </>
          );
        }}
      </AsyncView>
    </ScrollScreen>
  );
}

function PassPurchaseLinks({
  catalog,
}: {
  readonly catalog: Parameters<typeof cheapestPackDay>[0];
}) {
  const locale = useAppLocale();
  const router = useRouter();
  const packDay = cheapestPackDay(catalog, locale);
  const unlimited = [...catalog.unlimited].sort(
    (first, second) => first.price.value - second.price.value
  )[0];
  if (packDay === undefined && unlimited === undefined) return null;
  return (
    <>
      <SectionHeader title={m.passes_buy({}, { locale })} />
      <ListGroup>
        {packDay !== undefined && (
          <ListRow
            icon={Ticket}
            label={m.passes_entry_pack({}, { locale })}
            description={m.passes_entry_price({ price: packDay }, { locale })}
            onPress={() => router.push(entryPackPurchaseHref)}
          />
        )}
        {unlimited !== undefined && (
          <ListRow
            icon={CalendarRange}
            label={m.passes_membership({}, { locale })}
            description={m.passes_unlimited_price(
              {
                price: formatMoney(unlimited.price, locale),
                days: unlimited.validityDays,
              },
              { locale }
            )}
            onPress={() => router.push(unlimitedPurchaseHref)}
          />
        )}
      </ListGroup>
    </>
  );
}

function GiftPurchaseCard({
  gift,
}: {
  readonly gift: CustomerPassList["boughtForOthers"][number];
}) {
  const locale = useAppLocale();
  const toast = useToast();
  const [sending, resend] = useAtom(resendPassInvitationAtom, {
    mode: "promiseExit",
  });
  const send = async () => {
    const outcome = await resend({ passId: gift.passId, locale });
    if (Exit.isSuccess(outcome) && outcome.value.status === "queued") {
      toast.show({
        message: m.passes_invitation_queued({}, { locale }),
        tone: "confirmation",
      });
      return;
    }
    toast.show({
      message: m.passes_invitation_unconfirmed({}, { locale }),
      tone: "neutral",
    });
  };
  return (
    <Card>
      <View style={styles.gift}>
        <Text variant="headline">
          {m.passes_product_tier(
            {
              product:
                gift.product.kind === "entry-pack"
                  ? m.passes_entry_pack({}, { locale })
                  : m.passes_unlimited({}, { locale }),
              tier: passTierName(gift.product.tier, locale),
            },
            { locale }
          )}
        </Text>
        {gift.maskedHolderEmail !== undefined && (
          <Text variant="bodySmall" tone="muted">
            {gift.maskedHolderEmail}
          </Text>
        )}
        <View style={styles.badge}>
          <Badge
            tone={gift.claimed ? "positive" : "warning"}
            label={
              gift.claimed
                ? m.passes_claimed({}, { locale })
                : m.passes_unclaimed({}, { locale })
            }
          />
        </View>
        {gift.canResend && (
          <Button
            label={m.passes_resend({}, { locale })}
            icon={Mail}
            variant="secondary"
            size="small"
            width="content"
            disabled={sending.waiting}
            onPress={() => void send()}
          />
        )}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  cards: { gap: space.lg },
  gift: { gap: space.sm },
  badge: { alignItems: "flex-start", marginTop: space.xs },
});

import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useRouter } from "expo-router";
import { useAppLocale } from "../../i18n/locale-context";
import { m } from "../../i18n/messages";
import { EntryPackOfferLink } from "../../passes/entry-pack-offer-link";
import { passCatalogAtom } from "../../passes/pass-reads";
import { Masthead } from "../../ui/masthead";
import { ScrollScreen } from "../../ui/scroll-screen";
import { bookFamilyHref } from "../booking-routes";
import { teamTableOfferingsAtom } from "../data/booking-queries";
import { defaultCoworkDraft } from "../selection/cowork-selection";
import { BookingGate } from "./booking-gate";
import { BookingOfferingsView } from "./booking-offerings-view";
import { SpaceCards, SpaceCardsSkeleton } from "./space-cards";
import { spaceCards } from "./space-chooser";

/**
 * The Book tab's root: under its masthead, a card for each space the
 * catalog offers, with today's advertised "from" price, for an account that
 * can book.
 */
export function SpaceChooserScreen() {
  const locale = useAppLocale();
  const router = useRouter();
  const passes = useAtomValue(passCatalogAtom);
  const teamTable = useAtomValue(teamTableOfferingsAtom(locale));
  return (
    <ScrollScreen
      contentWidth="wide"
      masthead={
        <Masthead
          contentWidth="wide"
          title={m.booking_stack_title({}, { locale })}
        />
      }
    >
      <BookingGate>
        <BookingOfferingsView
          loading={
            <SpaceCardsSkeleton label={m.account_loading({}, { locale })} />
          }
          failedTitle={m.booking_spaces_load_failed({}, { locale })}
        >
          {(catalog) => (
            <SpaceCards
              cards={spaceCards(catalog.offerings)}
              locale={locale}
              onOpen={(family) => router.push(bookFamilyHref(family))}
              teamTable={teamTable}
              afterCowork={
                AsyncResult.isSuccess(passes) ? (
                  <EntryPackOfferLink
                    catalog={passes.value}
                    draft={defaultCoworkDraft(catalog.offerings)}
                  />
                ) : undefined
              }
            />
          )}
        </BookingOfferingsView>
      </BookingGate>
    </ScrollScreen>
  );
}

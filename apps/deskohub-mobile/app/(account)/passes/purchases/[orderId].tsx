import { CustomerPassId } from "@deskohub/workspace-customer-api";
import { useAtomRefresh } from "@effect/atom-react";
import { Schema } from "effect";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useAppLocale } from "../../../../src/i18n/locale-context";
import { m } from "../../../../src/i18n/messages";
import { heldPassesAtom } from "../../../../src/passes/pass-reads";
import { PassPurchaseStatusScreen } from "../../../../src/passes/purchase/status/pass-purchase-status-screen";
import { Button } from "../../../../src/ui/controls";
import { StackHeader } from "../../../../src/ui/navigation";
import { Notice } from "../../../../src/ui/notice";
import { ScrollScreen } from "../../../../src/ui/scroll-screen";

const accountPassesHref = "/account/passes";
const isPurchaseId = Schema.is(CustomerPassId);

export default function PassPurchaseStatusRoute() {
  const locale = useAppLocale();
  const router = useRouter();
  const { orderId, after } = useLocalSearchParams();
  const afterPayment = after === "payment";
  const refreshHeldPasses = useAtomRefresh(heldPassesAtom(locale));
  const close = () => {
    if (isPurchaseId(orderId)) refreshHeldPasses();
    router.dismissTo(accountPassesHref);
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: m.pass_purchase_status_title({}, { locale }),
          headerShown: true,
          header: (props) => (
            <StackHeader
              {...props}
              backFallback={accountPassesHref}
              closes={afterPayment}
              navigation={
                afterPayment
                  ? { ...props.navigation, goBack: close }
                  : props.navigation
              }
            />
          ),
        }}
      />
      {isPurchaseId(orderId) ? (
        <PassPurchaseStatusScreen
          key={`${orderId}/${locale}/${afterPayment}`}
          orderId={orderId}
          afterPayment={afterPayment}
          onClose={close}
        />
      ) : (
        <ScrollScreen contentWidth="form">
          <Notice
            tone="error"
            message={m.pass_purchase_status_not_found({}, { locale })}
          />
          <Button
            label={m.pass_purchase_status_done({}, { locale })}
            onPress={close}
          />
        </ScrollScreen>
      )}
    </>
  );
}

import { Stack } from "expo-router";
import { useAppLocale } from "../../../src/i18n/locale-context";
import { stackScreenOptions } from "../../../src/ui/navigation";
import { useUpdateOfferHost } from "../../../src/updates/update-offer";

export default function PassesLayout() {
  const locale = useAppLocale();
  useUpdateOfferHost();
  return (
    <Stack screenOptions={stackScreenOptions(locale)}>
      <Stack.Screen name="access" options={{ headerShown: false }} />
    </Stack>
  );
}

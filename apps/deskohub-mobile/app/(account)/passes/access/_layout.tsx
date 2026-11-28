import { Stack } from "expo-router";
import { useAppLocale } from "../../../../src/i18n/locale-context";
import { stackScreenOptions } from "../../../../src/ui/navigation";

export default function PassAccessLayout() {
  const locale = useAppLocale();
  return <Stack screenOptions={stackScreenOptions(locale)} />;
}

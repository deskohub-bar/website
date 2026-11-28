import { CustomerPassId } from "@deskohub/workspace-customer-api";
import { Option, Schema } from "effect";
import { useLocalSearchParams } from "expo-router";
import { UnlimitedAccessScreen } from "../../../../src/passes/unlimited-access-screen";

const decodePassId = Schema.decodeUnknownOption(CustomerPassId);

export default function PassAccessRoute() {
  const { passId } = useLocalSearchParams<{ passId?: string }>();
  return (
    <UnlimitedAccessScreen
      passId={Option.getOrUndefined(decodePassId(passId))}
    />
  );
}

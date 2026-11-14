import { OnboardScreen } from "@/components/business/OnboardScreen";

// The onboarding deep agent takes one to three minutes; this applies to the Server Function the screen calls.
export const maxDuration = 300;

export default function OnboardPage() {
  return <OnboardScreen />;
}

/**
 * The other ways to allow a Worker's prompt, under Allow once (lib/allowScope.ts): for this task,
 * always in this project, always. Cobra's suggestion, after several Allows of the same host, comes
 * first and lit, with why. A choice that writes the policy grants more, so it takes a second press,
 * as Apply does in Settings → Permissions.
 */
import { useEffect, useState } from "react";
import { WINDOW_MS } from "../lib/confirm.ts";
import { confirmWords, ordered, scopeChoices, suggestLine, type AllowOffer, type ScopeChoice } from "../lib/allowScope.ts";
import { Button } from "./ui.tsx";

export function ScopeChoices({ offer, onAllow, disabled }: { offer: AllowOffer | null; onAllow: (choice: ScopeChoice) => void; disabled?: boolean }) {
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(null), WINDOW_MS);
    return () => clearTimeout(timer);
  }, [armed]);
  const choices = ordered(scopeChoices(offer));
  if (!choices.length) return null;
  const press = (choice: ScopeChoice) => {
    if (choice.writes && armed !== choice.scope) return setArmed(choice.scope);
    setArmed(null);
    onAllow(choice);
  };
  return (
    <div className="col scope-choices">
      <div className="dim">{suggestLine(offer) ?? "Or allow it"}</div>
      <div className="wrap">
        {choices.map((choice) => (
          <Button key={choice.scope} small kind={choice.suggested ? "primary" : undefined} disabled={disabled}
            title={confirmWords(choice)} onClick={() => press(choice)}>
            {armed === choice.scope ? "Press again to allow" : choice.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

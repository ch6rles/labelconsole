'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, useToast } from '@labelconsole/ui/client';
import { Icon } from '@labelconsole/ui';

const KEYS = ['profile', 'taxForm', 'payout', 'contract', 'assets'] as const;

export function OnboardingSteps({ artistId, steps, disabled }: { artistId: string; steps: boolean[]; disabled?: boolean }) {
  const [state, setState] = useState(steps);
  const router = useRouter();
  const toast = useToast();
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', justifyItems: 'center' }}>
      {KEYS.map((k, i) => (
        <button
          key={k}
          type="button"
          disabled={disabled}
          title={`${state[i] ? 'Mark not done' : 'Mark done'}: ${k}`}
          className={`lc-step-box${state[i] ? ' is-done' : ''}`}
          style={{ cursor: disabled ? 'default' : 'pointer', padding: 0 }}
          onClick={async () => {
            const next = [...state];
            next[i] = !next[i];
            setState(next);
            try {
              await api(`/people/artists/${artistId}/onboarding`, { method: 'PATCH', body: { [k]: next[i] } });
              router.refresh();
            } catch (e) {
              setState(state);
              toast((e as Error).message, 'error');
            }
          }}
        >
          {state[i] && <Icon name="check" />}
        </button>
      ))}
    </div>
  );
}

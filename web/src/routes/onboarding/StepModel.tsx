import { useState } from 'react';
import { Button } from '../../components/Button';
import { KeySetup, type SavedKey } from '../../components/KeySetup';
import { Message } from '../../components/Message';
import { useAuth } from '../../data/authContext';
import { PROVIDERS, providerById } from '../../lib/providers';
import type { StepProps } from './Wizard';

export function StepModel({ goTo, back, keys, reloadKeys }: StepProps) {
  const { profile, updateProfile } = useAuth();
  const [error, setError] = useState<string | null>(null);

  const onSaved = async ({ provider, model }: SavedKey) => {
    try {
      await updateProfile({ default_notes_provider: provider, default_notes_model: model });
      await reloadKeys();
      const transcribes = providerById(provider)?.transcribes;
      await goTo(transcribes ? 'extension' : 'transcription');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section className="step">
      <div className="step-head">
        <h1>Connect your AI model</h1>
        <p>Your notes are written by a model you choose, with your own key. We store the key encrypted and never show it again.</p>
      </div>

      <KeySetup
        providers={PROVIDERS}
        existing={keys}
        initialProvider={profile?.default_notes_provider}
        initialModel={profile?.default_notes_model}
        pickModel
        onSaved={onSaved}
        submitLabel="Save and continue"
        secondary={back && <Button variant="ghost" size="lg" onClick={back}>Back</Button>}
      />

      {error && <Message tone="bad">{error}</Message>}
    </section>
  );
}

import { useState } from 'react';
import { Button } from '../../components/Button';
import { KeySetup } from '../../components/KeySetup';
import { Message } from '../../components/Message';
import { useAuth } from '../../data/authContext';
import { providerById, TRANSCRIBE_PROVIDERS } from '../../lib/providers';
import type { StepProps } from './Wizard';

export function StepTranscription({ next, back, keys, reloadKeys }: StepProps) {
  const { profile, updateOnboarding } = useAuth();
  const [skipping, setSkipping] = useState(false);
  const notesProvider = providerById(profile?.default_notes_provider)?.label ?? 'Your provider';
  const savedTranscriber = keys.find((k) => TRANSCRIBE_PROVIDERS.some((p) => p.id === k.provider));

  const skip = async () => {
    setSkipping(true);
    await updateOnboarding({ transcription: 'skipped' });
    await next();
  };

  return (
    <section className="step">
      <div className="step-head">
        <h1>Add a key for lectures without captions</h1>
        <p>
          Most Echo360 lectures have captions, and your {notesProvider} key handles those.
          Recordings without captions need speech-to-text first, which {notesProvider} doesn’t offer.
        </p>
      </div>

      <Message tone="info">
        Groq (which has a free tier) or OpenAI can transcribe. This key is only used for transcription.
      </Message>

      <KeySetup
        providers={TRANSCRIBE_PROVIDERS}
        existing={keys}
        initialProvider={savedTranscriber?.provider}
        pickModel={false}
        onSaved={async () => {
          await updateOnboarding({ transcription: undefined });
          await reloadKeys();
          await next();
        }}
        submitLabel="Save and continue"
        secondary={
          <>
            {back && <Button variant="ghost" size="lg" onClick={back}>Back</Button>}
            <Button variant="ghost" size="lg" onClick={skip} loading={skipping}>Skip for now</Button>
          </>
        }
      />

      <p className="step-footnote">
        If you skip, lectures without captions won’t process until you add a key in Settings.
      </p>
    </section>
  );
}

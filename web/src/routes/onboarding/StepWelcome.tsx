import { useState } from 'react';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { Message } from '../../components/Message';
import { useAuth } from '../../data/authContext';
import { APP_NAME } from '../../lib/brand';
import type { StepProps } from './Wizard';

export function StepWelcome({ next }: StepProps) {
  const { profile, updateProfile } = useAuth();
  const [name, setName] = useState(profile?.display_name ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const trimmed = name.trim();
      if (trimmed !== (profile?.display_name ?? '')) await updateProfile({ display_name: trimmed || null });
      await next();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <section className="step">
      <div className="step-head">
        <h1>Let’s set up your library</h1>
        <p>A few minutes, once. You’ll need an API key from an AI provider; some offer a free tier.</p>
      </div>

      <ol className="step-chapters" aria-label="How it works">
        <li>
          <span><strong>Capture a lecture</strong>From Echo360 in Chrome, or upload a recording or transcript you already have.</span>
        </li>
        <li>
          <span><strong>Your model writes the notes</strong>Exam-ready notes, broken into chapters, using your own AI key.</span>
        </li>
        <li>
          <span><strong>Study from your library</strong>Everything is kept in {APP_NAME}. Google Drive and Obsidian are optional.</span>
        </li>
      </ol>

      <Field
        label="What should we call you?"
        autoComplete="given-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        hint="Optional."
      />

      {error && <Message tone="bad">{error}</Message>}

      <div className="step-actions">
        <Button variant="primary" size="lg" onClick={submit} loading={saving}>Get started</Button>
      </div>
    </section>
  );
}

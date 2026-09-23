import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CircleCheck, ExternalLink, KeyRound } from 'lucide-react';
import { Button } from './Button';
import { Field } from './Field';
import { Message } from './Message';
import { chatModels, providerById, testKey, type ProviderId, type ProviderInfo } from '../lib/providers';
import { supabase } from '../lib/supabase';
import type { ApiKey } from '../data/types';
import './KeySetup.css';

export interface SavedKey {
  keyId: string;
  provider: ProviderId;
  model: string | null;
}

interface KeySetupProps {
  providers: ProviderInfo[];
  /** Keys the student already saved (to offer "keep this key"). */
  existing: ApiKey[];
  initialProvider?: string | null;
  initialModel?: string | null;
  /** Ask which model writes the notes. */
  pickModel: boolean;
  onSaved: (saved: SavedKey) => void;
  submitLabel: string;
  secondary?: React.ReactNode;
}

type TestState =
  | { phase: 'idle' }
  | { phase: 'testing' }
  | { phase: 'passed'; models: string[] }
  | { phase: 'failed'; message: string };

export function KeySetup({ providers, existing, initialProvider, initialModel, pickModel, onSaved, submitLabel, secondary }: KeySetupProps) {
  const groupId = useId();
  const [providerId, setProviderId] = useState<ProviderId | null>(
    providers.some((p) => p.id === initialProvider) ? (initialProvider as ProviderId) : null,
  );
  const provider = providerById(providerId);
  const saved = existing.find((k) => k.provider === providerId) ?? null;
  const [replacing, setReplacing] = useState(false);
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(saved?.base_url ?? '');
  const [test, setTest] = useState<TestState>({ phase: 'idle' });
  const [model, setModel] = useState<string>(initialModel ?? '');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const usingSaved = Boolean(saved) && !replacing;
  const effectiveBaseUrl = provider?.id === 'custom' ? baseUrl.trim() : provider?.baseUrl ?? '';
  const baseUrlError = provider?.id === 'custom' && baseUrl && !/^https:\/\//.test(baseUrl.trim())
    ? 'Use an https:// address.'
    : null;

  // Any change to what's being tested invalidates the last test.
  const resetTest = () => {
    abortRef.current?.abort();
    setTest({ phase: 'idle' });
    setSaveError(null);
  };

  const chooseProvider = (id: ProviderId) => {
    resetTest();
    setProviderId(id);
    setReplacing(false);
    setKey('');
    setBaseUrl(existing.find((k) => k.provider === id)?.base_url ?? '');
  };

  useEffect(() => () => abortRef.current?.abort(), []);

  const models = useMemo(() => (test.phase === 'passed' ? chatModels(test.models) : []), [test]);

  const runTest = async () => {
    if (!provider || !effectiveBaseUrl || !key.trim()) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setTest({ phase: 'testing' });
    try {
      const result = await testKey(effectiveBaseUrl, key, controller.signal);
      if (!result.ok) return setTest({ phase: 'failed', message: result.message });
      setTest({ phase: 'passed', models: result.models });
      const list = chatModels(result.models);
      setModel((current) => (
        list.includes(current) ? current
          : provider.defaultModel && list.includes(provider.defaultModel) ? provider.defaultModel
            : ''
      ));
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setTest({ phase: 'failed', message: 'The test was interrupted. Try again.' });
    }
  };

  const canSave = Boolean(provider) && (usingSaved || test.phase === 'passed') && (!pickModel || model.trim().length > 0);

  const save = async () => {
    if (!provider || !canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      let keyId = saved?.id ?? '';
      if (!usingSaved) {
        const { data, error } = await supabase.rpc('set_api_key', {
          p_provider: provider.id,
          p_key: key.trim(),
          p_base_url: provider.id === 'custom' ? effectiveBaseUrl : null,
          p_validated: true,
        });
        if (error) throw error;
        keyId = data as string;
        setKey('');
      }
      onSaved({ keyId, provider: provider.id, model: pickModel ? model.trim() : null });
    } catch (err) {
      setSaveError(`Couldn't save the key: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="keysetup">
      <fieldset className="keysetup-providers">
        <legend className="keysetup-legend">Provider</legend>
        {providers.map((p) => {
          const hasKey = existing.some((k) => k.provider === p.id);
          return (
            <label key={p.id} className={`provider${providerId === p.id ? ' is-selected' : ''}`}>
              <input
                type="radio"
                name={groupId}
                value={p.id}
                checked={providerId === p.id}
                onChange={() => chooseProvider(p.id)}
              />
              <span className="provider-text">
                <span className="provider-name">
                  {p.label}
                  {hasKey && <span className="provider-saved"><CircleCheck aria-hidden="true" />Key saved</span>}
                </span>
                <span className="provider-summary">{p.summary}</span>
              </span>
            </label>
          );
        })}
      </fieldset>

      {provider && (
        <div className="keysetup-details">
          {usingSaved && saved ? (
            <div className="keysetup-saved">
              <KeyRound aria-hidden="true" />
              <span>
                Using your saved {provider.label} key <span className="mono">••••{saved.key_hint}</span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => setReplacing(true)}>Replace</Button>
            </div>
          ) : (
            <>
              {provider.id === 'custom' && (
                <Field
                  label="Server address"
                  type="url"
                  inputMode="url"
                  placeholder="https://your-server.example/v1"
                  value={baseUrl}
                  onChange={(e) => { resetTest(); setBaseUrl(e.target.value); }}
                  error={baseUrlError}
                  hint="The OpenAI-compatible base URL, usually ending in /v1."
                />
              )}
              <Field
                label={`${provider.label} API key`}
                revealable
                autoComplete="off"
                spellCheck={false}
                placeholder={provider.keyHint}
                value={key}
                onChange={(e) => { resetTest(); setKey(e.target.value); }}
                hint={provider.keyUrl ? (
                  <a href={provider.keyUrl} target="_blank" rel="noreferrer" className="keysetup-link">
                    Get a key from {provider.label}<ExternalLink aria-hidden="true" />
                  </a>
                ) : 'Stored encrypted. You won’t see it again after saving.'}
              />
              <div className="keysetup-test">
                <Button
                  onClick={runTest}
                  loading={test.phase === 'testing'}
                  disabled={!key.trim() || !effectiveBaseUrl || Boolean(baseUrlError)}
                >
                  {test.phase === 'passed' ? 'Test again' : 'Test key'}
                </Button>
                {saved && <Button variant="ghost" onClick={() => setReplacing(false)}>Keep saved key</Button>}
              </div>
              {test.phase === 'passed' && (
                <Message tone="ok" title="This key works">
                  {provider.label} accepted it{test.models.length ? ` and lists ${test.models.length} models` : ''}.
                </Message>
              )}
              {test.phase === 'failed' && <Message tone="bad" title="That didn’t work">{test.message}</Message>}
            </>
          )}

          {pickModel && (usingSaved || test.phase === 'passed') && (
            <ModelPicker models={models} value={model} onChange={setModel} suggested={provider.defaultModel} />
          )}
        </div>
      )}

      {saveError && <Message tone="bad">{saveError}</Message>}

      <div className="step-actions">
        {secondary}
        <Button variant="primary" size="lg" onClick={save} loading={saving} disabled={!canSave}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

function ModelPicker({ models, value, onChange, suggested }: {
  models: string[];
  value: string;
  onChange: (value: string) => void;
  suggested: string | null;
}) {
  const id = useId();
  if (!models.length) {
    return (
      <Field
        label="Model"
        placeholder={suggested ?? 'Model id, e.g. gpt-4.1-mini'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        hint="The exact model id from your provider."
      />
    );
  }
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>Model that writes your notes</label>
      <select id={id} className="field-input keysetup-select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="" disabled>Choose a model</option>
        {models.map((m) => (
          <option key={m} value={m}>{m}{m === suggested ? ' (suggested)' : ''}</option>
        ))}
      </select>
      <p className="field-hint">Larger models write better notes but can be slower. You can change this later.</p>
    </div>
  );
}

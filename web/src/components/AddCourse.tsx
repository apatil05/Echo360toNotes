import { useRef, useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { Button } from './Button';
import { supabase } from '../lib/supabase';
import { useAuth } from '../data/authContext';
import './AddCourse.css';

/** The last tile on the shelf: turns into a small form. */
export function AddCourse({ onAdded }: { onAdded: () => Promise<void> }) {
  const { session } = useAuth();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  const close = () => {
    setOpen(false);
    setCode('');
    setName('');
    setError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!session || !code.trim()) return;
    setSaving(true);
    setError(null);
    const { error: insertError } = await supabase.from('courses').insert({
      user_id: session.user.id,
      code: code.trim(),
      name: name.trim() || null,
    });
    setSaving(false);
    if (insertError) {
      setError(insertError.code === '23505' ? 'You already have a course with that code.' : insertError.message);
      codeRef.current?.focus();
      return;
    }
    await onAdded();
    close();
  };

  if (!open) {
    return (
      <button type="button" className="addcourse-tile" onClick={() => { setOpen(true); setTimeout(() => codeRef.current?.focus(), 0); }}>
        <Plus aria-hidden="true" />
        <span>Add course</span>
      </button>
    );
  }

  return (
    <form className="addcourse-form" onSubmit={submit} onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
      <label className="addcourse-label">
        Code
        <input ref={codeRef} className="addcourse-input addcourse-code" placeholder="CS 220" maxLength={40} value={code} onChange={(e) => setCode(e.target.value)} required />
      </label>
      <label className="addcourse-label">
        Name <span className="addcourse-optional">optional</span>
        <input className="addcourse-input" placeholder="Data Structures" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {error && <p className="addcourse-error" role="alert">{error}</p>}
      <div className="addcourse-actions">
        <Button size="sm" variant="ghost" onClick={close}>Cancel</Button>
        <Button size="sm" variant="primary" type="submit" loading={saving} disabled={!code.trim()}>Add</Button>
      </div>
    </form>
  );
}

import { useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import './Field.css';

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  /** Adds a show/hide control for secrets. */
  revealable?: boolean;
}

export function Field({ label, hint, error, revealable, type = 'text', className, ...rest }: FieldProps) {
  const id = useId();
  const [revealed, setRevealed] = useState(false);
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
  const inputType = revealable ? (revealed ? 'text' : 'password') : type;

  return (
    <div className={['field', error && 'field-invalid', className].filter(Boolean).join(' ')}>
      <label className="field-label" htmlFor={id}>{label}</label>
      <div className="field-control">
        <input
          id={id}
          type={inputType}
          className="field-input"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          {...rest}
        />
        {revealable && (
          <button
            type="button"
            className="field-reveal"
            onClick={() => setRevealed((r) => !r)}
            aria-label={revealed ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
            aria-pressed={revealed}
          >
            {revealed ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </button>
        )}
      </div>
      {hint && !error && <p className="field-hint" id={`${id}-hint`}>{hint}</p>}
      {error && <p className="field-error" id={`${id}-error`} role="alert">{error}</p>}
    </div>
  );
}

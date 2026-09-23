import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';
import './Button.css';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface CommonProps {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  trailingIcon?: ReactNode;
  block?: boolean;
}

function classes({ variant = 'secondary', size = 'md', block }: CommonProps, extra?: string) {
  return ['btn', `btn-${variant}`, `btn-${size}`, block && 'btn-block', extra].filter(Boolean).join(' ');
}

export function Button({
  variant, size, icon, trailingIcon, block, loading, children, className, disabled, ...rest
}: CommonProps & ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) {
  return (
    <button
      type="button"
      className={classes({ variant, size, block }, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="btn-spinner" aria-hidden="true" /> : icon}
      {children && <span className="btn-label">{children}</span>}
      {!loading && trailingIcon}
    </button>
  );
}

export function ButtonLink({ variant, size, icon, trailingIcon, block, children, className, ...rest }: CommonProps & LinkProps) {
  return (
    <Link className={classes({ variant, size, block }, className)} {...rest}>
      {icon}
      {children && <span className="btn-label">{children}</span>}
      {trailingIcon}
    </Link>
  );
}

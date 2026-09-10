import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function Button({ variant = 'secondary', icon, children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; icon?: ReactNode }) {
  return <button className={`button button-${variant} ${className}`} {...props}>{icon}{children && <span>{children}</span>}</button>;
}

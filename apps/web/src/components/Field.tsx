import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

export function Field({
  label,
  hint,
  error,
  children,
  span,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  span?: boolean;
}) {
  return (
    <div className={`field${span ? ' span-2' : ''}`}>
      <div className="field-label">{label}</div>
      {children}
      {error ? (
        <div className="field-error">{error}</div>
      ) : hint ? (
        <div className="field-hint">{hint}</div>
      ) : null}
    </div>
  );
}

export function TextInput({
  mono,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return <input {...rest} className={`input${mono ? ' mono' : ''}${className ? ` ${className}` : ''}`} />;
}

export function TextArea({
  mono,
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) {
  return (
    <textarea
      spellCheck={false}
      {...rest}
      className={`textarea${mono ? ' mono' : ''}${className ? ` ${className}` : ''}`}
    />
  );
}

export function Select({
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={`select${className ? ` ${className}` : ''}`}>
      {children}
    </select>
  );
}

export function JsonEditor({
  value,
  onChange,
  rows = 6,
  placeholder,
  error,
}: {
  value: string;
  onChange: (next: string) => void;
  rows?: number;
  placeholder?: string;
  error?: string | null;
}) {
  return (
    <div className="json-editor">
      <TextArea
        mono
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={error ? 'invalid' : undefined}
      />
      {error ? <div className="field-error">{error}</div> : null}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <span className={`toggle${disabled ? ' disabled' : ''}`}>
      <button
        type="button"
        className={`switch${checked ? ' on' : ''}`}
        aria-pressed={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="knob" />
      </button>
      {label ? <span className="toggle-label">{label}</span> : null}
    </span>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={`checkbox${disabled ? ' disabled' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label ? <span>{label}</span> : null}
    </label>
  );
}

export function FormGrid({ children }: { children: ReactNode }) {
  return <div className="form-grid">{children}</div>;
}

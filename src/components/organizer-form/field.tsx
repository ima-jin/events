export const INPUT_CLASS = 'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100';

interface FieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  multiline?: boolean;
  min?: number;
  step?: string;
}

export function Field({ label, value, onChange, type = 'text', multiline, min, step }: Readonly<FieldProps>) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {multiline ? (
        <textarea value={value} onChange={(event) => onChange(event.target.value)} className={INPUT_CLASS} rows={4} />
      ) : (
        <input type={type} value={value} min={min} step={step} onChange={(event) => onChange(event.target.value)} className={INPUT_CLASS} />
      )}
    </label>
  );
}

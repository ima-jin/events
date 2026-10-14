export function PanelState({ loading, error, retry, label }: Readonly<{
  loading: boolean;
  error: string | null;
  retry: () => void;
  label: string;
}>) {
  if (loading) return <p role="status">Loading {label}…</p>;
  if (error) return <div><p role="alert">{error}</p><button type="button" onClick={retry}>Retry</button></div>;
  return null;
}

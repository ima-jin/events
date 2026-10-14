'use client';

import { useState } from 'react';
import { withBasePath } from '@/lib/base-path';

export function ImageUpload({ onUpload, onBusy }: Readonly<{ onUpload: (url: string) => void; onBusy: (busy: boolean) => void }>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function upload(file?: File) {
    if (!file) return;
    setError('');
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) {
      setError('Choose a JPEG, PNG, GIF or WebP image up to 10MB');
      return;
    }
    setBusy(true);
    onBusy(true);
    try {
      const body = new FormData();
      body.append('image', file);
      const response = await fetch(withBasePath('/api/upload'), { method: 'POST', credentials: 'include', body });
      if (!response.ok) throw new Error('Upload failed');
      const data: unknown = await response.json();
      if (typeof data !== 'object' || data === null || !('url' in data) || typeof data.url !== 'string') throw new Error('Invalid upload');
      if (!data.url.startsWith('/api/media/') || data.url.startsWith('//')) throw new Error('Invalid upload');
      onUpload(data.url);
    } catch {
      setError('Image upload failed. Please try again.');
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }
  return (
    <div className="space-y-2">
      <label className="block"><span>Upload cover image</span>
        <input type="file" accept="image/jpeg,image/png,image/gif,image/webp" disabled={busy}
          onChange={(event) => { upload(event.target.files?.[0]).catch(() => setError('Image upload failed. Please try again.')); }} />
      </label>
      {busy && <output className="block">Uploading image…</output>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

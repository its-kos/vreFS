import { Dataset, StorageBackend } from './service';

// --- FAIR utilities ---

export function fairTotal(score: Dataset['fair_score']): number {
  return Math.round((score.f + score.a + score.i + score.r) / 4);
}

export function fairLabel(
  total: number
): 'excellent' | 'good' | 'moderate' | 'poor' {
  if (total >= 85) {
    return 'excellent';
  }
  if (total >= 70) {
    return 'good';
  }
  if (total >= 50) {
    return 'moderate';
  }
  return 'poor';
}

export function fairColor(total: number): string {
  if (total >= 80) {
    return '#3B6D11';
  }
  if (total >= 60) {
    return '#854F0B';
  }
  return '#A32D2D';
}

export function fairBg(total: number): string {
  if (total >= 80) {
    return '#EAF3DE';
  }
  if (total >= 60) {
    return '#FAEEDA';
  }
  return '#FCEBEB';
}

// --- Backend display ---

export const BACKEND_LABELS: Record<StorageBackend['type'], string> = {
  irods: 'iRODS',
  gdrive: 'Google Drive',
  github: 'GitHub',
  s3: 'S3 / MinIO',
  webdav: 'WebDAV',
  ipfs: 'IPFS',
  local: 'Local filesystem'
};

export const BACKEND_COLORS: Record<
  StorageBackend['type'],
  { bg: string; text: string }
> = {
  irods: { bg: '#EEEDFE', text: '#26215C' },
  gdrive: { bg: '#FAEEDA', text: '#633806' },
  github: { bg: '#F1EFE8', text: '#2C2C2A' },
  s3: { bg: '#E1F5EE', text: '#04342C' },
  webdav: { bg: '#E6F1FB', text: '#042C53' },
  ipfs: { bg: '#FBEAF0', text: '#4B1528' },
  local: { bg: '#F1EFE8', text: '#2C2C2A' }
};

// --- Status display ---

export const STATUS_COLORS: Record<
  Dataset['status'],
  { bg: string; text: string; border: string }
> = {
  public: { bg: '#EAF3DE', text: '#27500A', border: '#C0DD97' },
  private: { bg: '#F1EFE8', text: '#444441', border: '#D3D1C7' }
};

// --- Formatting ---

export function relativeDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = Math.floor((now.getTime() - d.getTime()) / 1000);
  if (diff < 60) {
    return 'just now';
  }
  if (diff < 3600) {
    return `${Math.floor(diff / 60)}m ago`;
  }
  if (diff < 86400) {
    return `${Math.floor(diff / 3600)}h ago`;
  }
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
}

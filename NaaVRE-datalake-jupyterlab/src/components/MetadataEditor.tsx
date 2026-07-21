import * as React from 'react';
import { VreFSService, Dataset } from '../service';

interface Props {
  service: VreFSService;
  dataset: Dataset;
  onSave: (updated: Dataset) => void;
  onCancel: () => void;
}

const LICENCES = [
  'CC BY 4.0',
  'CC BY-SA 4.0',
  'CC BY-NC 4.0',
  'CC0 1.0',
  'MIT',
  'Apache 2.0',
  'GPL 3.0',
  'Proprietary'
];

const DOMAINS = [
  'Ecology',
  'Remote sensing',
  'Climate science',
  'Marine science',
  'Biodiversity',
  'Earth observation',
  'Hydrology',
  'Other'
];

export const MetadataEditor: React.FC<Props> = ({
  service,
  dataset,
  onSave,
  onCancel
}) => {
  const [name, setName] = React.useState(dataset.name);
  const [description, setDesc] = React.useState(dataset.description);
  const [tags, setTags] = React.useState<string[]>(dataset.tags);
  const [tagInput, setTagInput] = React.useState('');
  const [licence, setLicence] = React.useState(dataset.licence ?? '');
  const [domain, setDomain] = React.useState(dataset.domain);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function addTag() {
    const t = tagInput.trim().toLowerCase().replace(/\s+/g, '-');
    if (!t || tags.includes(t)) {
      return;
    }
    setTags([...tags, t]);
    setTagInput('');
  }

  function removeTag(t: string) {
    setTags(tags.filter(x => x !== t));
  }

  function handleTagKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag();
    }
    if (e.key === 'Backspace' && tagInput === '' && tags.length > 0) {
      setTags(tags.slice(0, -1));
    }
  }

  async function handleSave() {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await service.updateDatasetMetadata(dataset.id, {
        name: name.trim(),
        description: description.trim(),
        tags,
        licence: licence || null,
        domain
      });
      onSave(updated);
    } catch (e: any) {
      setError(e.message ?? 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        fontFamily: 'var(--jp-ui-font-family)',
        fontSize: 'var(--jp-ui-font-size1)'
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '8px 10px',
          borderBottom: '1px solid var(--jp-border-color2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0
        }}
      >
        <span style={{ fontWeight: 500, fontSize: 12 }}>Edit metadata</span>
        <button
          onClick={onCancel}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--jp-ui-font-color2)',
            fontSize: 16,
            lineHeight: 1
          }}
        >
          ×
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 10 }}>
        {/* Name */}
        <Field label="Dataset name" required>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            style={inputStyle}
            placeholder="e.g. AHN3_NL_LiDAR_Gelderland"
          />
        </Field>

        {/* Description */}
        <Field label="Description">
          <textarea
            value={description}
            onChange={e => setDesc(e.target.value)}
            rows={4}
            style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5 }}
            placeholder="Describe what this dataset contains, how it was collected, and what it can be used for."
          />
        </Field>

        {/* Tags */}
        <Field label="Tags" hint="Press Enter or comma to add">
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 4,
              padding: '4px 6px',
              border: '1px solid var(--jp-border-color1)',
              borderRadius: 4,
              background: 'var(--jp-layout-color1)',
              minHeight: 34,
              cursor: 'text'
            }}
            onClick={() => document.getElementById('vrefs-tag-input')?.focus()}
          >
            {tags.map(t => (
              <span
                key={t}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 3,
                  padding: '1px 6px',
                  borderRadius: 10,
                  fontSize: 11,
                  background: 'var(--jp-brand-color4)',
                  color: 'var(--jp-brand-color1)',
                  border: '1px solid var(--jp-brand-color2)'
                }}
              >
                {t}
                <span
                  onClick={() => removeTag(t)}
                  style={{
                    cursor: 'pointer',
                    fontSize: 13,
                    lineHeight: 1,
                    opacity: 0.6
                  }}
                >
                  ×
                </span>
              </span>
            ))}
            <input
              id="vrefs-tag-input"
              value={tagInput}
              onChange={e => setTagInput(e.target.value)}
              onKeyDown={handleTagKeyDown}
              onBlur={addTag}
              placeholder={tags.length === 0 ? 'Add tags…' : ''}
              style={{
                border: 'none',
                outline: 'none',
                background: 'transparent',
                fontSize: 11,
                color: 'var(--jp-ui-font-color1)',
                minWidth: 60,
                flex: 1
              }}
            />
          </div>
        </Field>

        {/* Domain */}
        <Field label="Domain">
          <select
            value={domain}
            onChange={e => setDomain(e.target.value)}
            style={selectStyle}
          >
            <option value="">— select domain —</option>
            {DOMAINS.map(d => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
            <option value="" disabled hidden></option>
          </select>
        </Field>

        {/* Licence */}
        <Field label="Licence" hint="Required for public datasets">
          <select
            value={licence}
            onChange={e => setLicence(e.target.value)}
            style={selectStyle}
          >
            <option value="">— select licence —</option>
            {LICENCES.map(l => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </Field>

        {/* Error */}
        {error && (
          <div
            style={{
              padding: '6px 8px',
              background: '#FCEBEB',
              border: '1px solid #F09595',
              borderRadius: 4,
              fontSize: 11,
              color: '#791F1F',
              marginTop: 4
            }}
          >
            {error}
          </div>
        )}
      </div>

      {/* Footer */}
      <div
        style={{
          padding: '8px 10px',
          borderTop: '1px solid var(--jp-border-color2)',
          display: 'flex',
          gap: 6,
          justifyContent: 'flex-end',
          flexShrink: 0
        }}
      >
        <button onClick={onCancel} style={btnSecondary} disabled={saving}>
          Cancel
        </button>
        <button
          onClick={handleSave}
          style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save metadata'}
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const Field: React.FC<{
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}> = ({ label, required, hint, children }) => (
  <div style={{ marginBottom: 10 }}>
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        marginBottom: 3
      }}
    >
      <label
        style={{
          fontSize: 11,
          color: 'var(--jp-ui-font-color2)',
          fontWeight: 500
        }}
      >
        {label}
        {required && <span style={{ color: '#A32D2D', marginLeft: 2 }}>*</span>}
      </label>
      {hint && (
        <span style={{ fontSize: 10, color: 'var(--jp-ui-font-color2)' }}>
          {hint}
        </span>
      )}
    </div>
    {children}
  </div>
);

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '4px 7px',
  border: '1px solid var(--jp-border-color1)',
  borderRadius: 4,
  fontSize: 12,
  background: 'var(--jp-layout-color1)',
  color: 'var(--jp-ui-font-color1)',
  boxSizing: 'border-box',
  fontFamily: 'var(--jp-ui-font-family)'
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: 'pointer',
  appearance: 'auto'
};

const btnPrimary: React.CSSProperties = {
  padding: '5px 12px',
  background: 'var(--jp-brand-color1)',
  color: 'white',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 12
};

const btnSecondary: React.CSSProperties = {
  padding: '5px 12px',
  background: 'none',
  color: 'var(--jp-ui-font-color1)',
  border: '1px solid var(--jp-border-color1)',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 12
};
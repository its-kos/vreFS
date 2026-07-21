import * as React from 'react';
import { Dataset } from '../service';
import { fairTotal, fairColor, fairBg } from '../utils';

interface Props {
  dataset: Dataset;
  onFixItem?: (action: FAIRAction) => void;
}

export type FAIRAction =
  | 'assign-pid'
  | 'add-description'
  | 'add-tags'
  | 'add-licence'
  | 'add-domain'
  | 'edit-metadata';

interface CheckItem {
  id: FAIRAction;
  dimension: 'F' | 'A' | 'I' | 'R';
  label: string;
  detail: string;
  passed: boolean;
  fixLabel: string;
}

/**
 * Derives a concrete checklist from actual dataset field values.
 * Each item maps to a FAIR dimension and has a fix action the user can take.
 * When the backend is live, re-scoring happens server-side after save —
 * this component just reads the current dataset state.
 */
function buildChecklist(dataset: Dataset): CheckItem[] {
  return [
    // Findable
    {
      id: 'assign-pid',
      dimension: 'F',
      label: 'Has a persistent identifier (PID)',
      detail: 'A PID makes this dataset citable and uniquely referenceable.',
      passed: !!dataset.pid,
      fixLabel: 'Assign PID'
    },
    {
      id: 'add-description',
      dimension: 'F',
      label: 'Has a title and description',
      detail: 'A meaningful description improves search and discovery.',
      passed: !!dataset.description && dataset.description.length > 20,
      fixLabel: 'Edit metadata'
    },
    {
      id: 'add-tags',
      dimension: 'F',
      label: 'Has at least 3 keyword tags',
      detail: 'Tags help others find this dataset by topic or method.',
      passed: dataset.tags.length >= 3,
      fixLabel: 'Add tags'
    },
    // Accessible
    {
      id: 'add-licence',
      dimension: 'A',
      label: 'Has a licence',
      detail:
        'A clear licence tells others what they are allowed to do with this data.',
      passed: !!dataset.licence,
      fixLabel: 'Set licence'
    },
    // Interoperable
    {
      id: 'add-domain',
      dimension: 'I',
      label: 'Domain is specified',
      detail:
        'A domain tag links this dataset to a scientific community and its standards.',
      passed: !!dataset.domain && dataset.domain !== 'Other',
      fixLabel: 'Set domain'
    },
    // Reusable
    {
      id: 'edit-metadata',
      dimension: 'R',
      label: 'Has versioning information',
      detail:
        'Versioning lets others reproduce results using the exact dataset state you used.',
      passed: dataset.versions > 1,
      fixLabel: 'View versions'
    }
  ];
}

const DIMENSION_COLORS: Record<string, { bg: string; text: string }> = {
  F: { bg: '#E6F1FB', text: '#0C447C' },
  A: { bg: '#EAF3DE', text: '#27500A' },
  I: { bg: '#EEEDFE', text: '#26215C' },
  R: { bg: '#FAEEDA', text: '#633806' }
};

export const FAIRChecklist: React.FC<Props> = ({ dataset, onFixItem }) => {
  const items = buildChecklist(dataset);
  const passed = items.filter(i => i.passed).length;
  const total = items.length;
  const score = fairTotal(dataset.fair_score);
  const [expanded, setExpanded] = React.useState<FAIRAction | null>(null);

  return (
    <div>
      {/* Summary row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginBottom: 10
        }}
      >
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: '50%',
            flexShrink: 0,
            background: fairColor(score),
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'white',
            fontSize: 12,
            fontWeight: 500
          }}
        >
          {score}%
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 2 }}>
            {passed} of {total} criteria met
          </div>
          <div
            style={{
              height: 5,
              background: 'var(--jp-layout-color3)',
              borderRadius: 3,
              overflow: 'hidden'
            }}
          >
            <div
              style={{
                width: `${(passed / total) * 100}%`,
                height: '100%',
                background: fairColor(score),
                borderRadius: 3,
                transition: 'width 0.4s ease'
              }}
            />
          </div>
        </div>
        <span
          style={{
            fontSize: 11,
            padding: '2px 7px',
            borderRadius: 8,
            background: fairBg(score),
            color: fairColor(score),
            fontWeight: 500,
            flexShrink: 0
          }}
        >
          {score >= 85
            ? 'Excellent'
            : score >= 70
              ? 'Good'
              : score >= 50
                ? 'Moderate'
                : 'Poor'}
        </span>
      </div>

      {/* Per-dimension bars */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 6,
          marginBottom: 10
        }}
      >
        {(['f', 'a', 'i', 'r'] as const).map(k => {
          const labels: Record<string, string> = {
            f: 'Findable',
            a: 'Accessible',
            i: 'Interoperable',
            r: 'Reusable'
          };
          const tracks: Record<string, string> = {
            f: 'PID · description',
            a: 'remote access URL',
            i: 'file format',
            r: 'licence · checksum'
          };
          const val = dataset.fair_score[k];
          const dc = DIMENSION_COLORS[k.toUpperCase()];
          return (
            <div
              key={k}
              style={{ padding: '5px 7px', borderRadius: 4, background: dc.bg }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 10,
                  marginBottom: 3
                }}
              >
                <span style={{ fontWeight: 500, color: dc.text }}>
                  {k.toUpperCase()} — {labels[k]}
                </span>
                <span style={{ color: dc.text, fontWeight: 500 }}>{val}%</span>
              </div>
              <div
                style={{
                  height: 3,
                  background: 'rgba(0,0,0,0.1)',
                  borderRadius: 2,
                  overflow: 'hidden'
                }}
              >
                <div
                  style={{
                    width: `${val}%`,
                    height: '100%',
                    background: dc.text,
                    opacity: 0.6,
                    borderRadius: 2
                  }}
                />
              </div>
              <div style={{ fontSize: 9, color: dc.text, opacity: 0.7, marginTop: 2 }}>
                tracks: {tracks[k]}
              </div>
            </div>
          );
        })}
      </div>

      {/* Checklist */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {items.map(item => {
          const dc = DIMENSION_COLORS[item.dimension];
          const isOpen = expanded === item.id;
          return (
            <div
              key={item.id}
              style={{
                borderRadius: 4,
                border: `1px solid ${item.passed ? 'var(--jp-border-color2)' : '#FAC775'}`,
                background: item.passed ? 'var(--jp-layout-color1)' : '#FAEEDA',
                overflow: 'hidden'
              }}
            >
              {/* Row */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  padding: '6px 8px',
                  cursor: 'pointer'
                }}
                onClick={() => setExpanded(isOpen ? null : item.id)}
              >
                {/* Status icon */}
                <span
                  style={{
                    fontSize: 13,
                    flexShrink: 0,
                    color: item.passed ? '#3B6D11' : '#854F0B'
                  }}
                >
                  {item.passed ? '✓' : '○'}
                </span>

                {/* Label */}
                <span
                  style={{
                    flex: 1,
                    fontSize: 11,
                    color: item.passed ? 'var(--jp-ui-font-color1)' : '#633806'
                  }}
                >
                  {item.label}
                </span>

                {/* Dimension badge */}
                <span
                  style={{
                    fontSize: 10,
                    padding: '1px 5px',
                    borderRadius: 6,
                    background: dc.bg,
                    color: dc.text,
                    fontWeight: 500,
                    flexShrink: 0
                  }}
                >
                  {item.dimension}
                </span>

                {/* Expand chevron */}
                <span
                  style={{
                    fontSize: 10,
                    color: 'var(--jp-ui-font-color2)',
                    flexShrink: 0,
                    transform: isOpen ? 'rotate(180deg)' : 'none',
                    transition: 'transform 0.2s'
                  }}
                >
                  ▾
                </span>
              </div>

              {/* Expanded detail + fix button */}
              {isOpen && (
                <div
                  style={{
                    padding: '0 8px 8px 28px',
                    borderTop: '1px solid var(--jp-border-color2)'
                  }}
                >
                  <p
                    style={{
                      fontSize: 11,
                      color: 'var(--jp-ui-font-color2)',
                      margin: '6px 0 8px',
                      lineHeight: 1.5
                    }}
                  >
                    {item.detail}
                  </p>
                  {!item.passed && onFixItem && (
                    <button
                      onClick={() => onFixItem(item.id)}
                      style={{
                        padding: '3px 9px',
                        fontSize: 11,
                        cursor: 'pointer',
                        background: '#854F0B',
                        color: '#FAEEDA',
                        border: 'none',
                        borderRadius: 4
                      }}
                    >
                      {item.fixLabel} →
                    </button>
                  )}
                  {item.passed && (
                    <span style={{ fontSize: 11, color: '#3B6D11' }}>
                      ✓ This criterion is satisfied.
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
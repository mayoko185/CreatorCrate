import { describe, expect, it } from 'vitest';
import {
  buildProjectOptionPresentation,
  getProjectBadgeForeground,
  presentProjectOptionCatalogue,
  presentProjectOptions,
} from '../src/services/project-option-presenter.js';

const BADGE_BACKDROPS = ['#0D0F13', '#1D222B', '#232A38'];

function channels(color) {
  return [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16));
}

function luminance(rgb) {
  const linear = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
}

function renderedBackground(baseColor, backdrop, tintPercent) {
  const base = channels(baseColor);
  return channels(backdrop).map((value, index) => (
    Math.round(value + ((base[index] - value) * (tintPercent / 100)))
  ));
}

function contrastRatio(first, second) {
  const firstLuminance = luminance(first);
  const secondLuminance = luminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05)
    / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

describe('Project option presenter', () => {
  it('preserves readable configured colors and minimally lightens dark colors', () => {
    expect(getProjectBadgeForeground('#F5F5F5')).toBe('#F5F5F5');
    expect(getProjectBadgeForeground('#22D3EE')).toBe('#22D3EE');
    expect(getProjectBadgeForeground('#123456')).toBe('#8495A7');
  });

  it('rejects colors outside the normalized catalogue contract', () => {
    expect(() => getProjectBadgeForeground('red')).toThrow(/#RRGGBB/);
    expect(() => getProjectBadgeForeground('#abcdef')).toThrow(/#RRGGBB/);
    expect(() => getProjectBadgeForeground('#123456', 18.5)).toThrow(/integer percentage/);
  });

  it.each([
    ['custom Status', 'status', 'review', 18],
    ['neutral Status', 'status', 'tbd', 20],
    ['completed Status', 'status', 'completed', 22],
    ['Archived Status', 'status', 'archived', 25],
  ])('uses the rendered tint when selecting threshold-safe foregrounds for %s', (
    _label, kind, value, tintPercent,
  ) => {
    const entry = { value, label: value, color: '#00A000' };
    const first = presentProjectOptionCatalogue([entry], kind)[0];
    const second = presentProjectOptionCatalogue([entry], kind)[0];

    expect(first.tintPercent).toBe(tintPercent);
    expect(second.foregroundColor).toBe(first.foregroundColor);
    for (const backdrop of BADGE_BACKDROPS) {
      expect(contrastRatio(
        channels(first.foregroundColor),
        renderedBackground(first.color, backdrop, first.tintPercent),
      )).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('adds badge contrast metadata without dropping Settings editor metadata', () => {
    const deletion = { protected: true };

    expect(presentProjectOptionCatalogue([
      { value: 'tbd', label: 'Tbd', color: '#AAAAAA', deletion },
    ], 'status')).toEqual([
      {
        value: 'tbd', label: 'Tbd', color: '#AAAAAA', tintPercent: 20,
        foregroundColor: '#B0B0B0', deletion,
      },
    ]);
  });

  it('attaches matching Project-only Status and Type metadata', () => {
    const presentation = buildProjectOptionPresentation({
      status: [{ value: 'review', label: 'Awaiting Review', color: '#123456' }],
      projectType: [{ value: 'story', label: 'Interactive Story', color: '#F5F5F5' }],
    });

    expect(presentProjectOptions({ status: 'review', project_type: 'story' }, presentation))
      .toMatchObject({
        projectStatusOption: {
          value: 'review', label: 'Awaiting Review', color: '#123456', tintPercent: 18,
          foregroundColor: '#8495A7',
        },
        projectTypeOption: {
          value: 'story', label: 'Interactive Story', color: '#F5F5F5', tintPercent: 18,
          foregroundColor: '#F5F5F5',
        },
      });
  });
});

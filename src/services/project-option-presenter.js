import { isProjectArchived } from './project-state.js';

const COLOR_PATTERN = /^#[0-9A-F]{6}$/;
const BADGE_BACKDROPS = ['#0D0F13', '#1D222B', '#232A38'];
const STANDARD_TINT_PERCENT = 18;
const MIN_TEXT_CONTRAST = 4.5;

const STATUS_TINT_PERCENT_BY_VALUE = Object.freeze({
  tbd: 20,
  planned: 20,
  completed: 22,
  published: 22,
  archived: 25,
});

function requireCatalogue(entries, kind) {
  if (!Array.isArray(entries)) {
    throw new TypeError(`Project ${kind} presentation requires a catalogue.`);
  }
  return entries;
}

function relativeLuminance(color) {
  const channels = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
}

function colorChannels(color) {
  return [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
}

function channelsToColor(channels) {
  return `#${channels.map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function mixChannels(source, target, amount) {
  return source.map((channel, index) => channel + ((target[index] - channel) * amount));
}

function contrastRatio(first, second) {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

function hasBadgeContrast(foreground, baseColor, tintPercent) {
  const baseChannels = colorChannels(baseColor);
  return BADGE_BACKDROPS.every((backdrop) => {
    const tintedBackground = channelsToColor(mixChannels(
      colorChannels(backdrop),
      baseChannels,
      tintPercent / 100,
    ));
    return contrastRatio(foreground, tintedBackground) >= MIN_TEXT_CONTRAST;
  });
}

export function getProjectBadgeForeground(color, tintPercent = STANDARD_TINT_PERCENT) {
  if (typeof color !== 'string' || !COLOR_PATTERN.test(color)) {
    throw new TypeError('Project badge color must be a normalized #RRGGBB value.');
  }
  if (!Number.isInteger(tintPercent) || tintPercent < 0 || tintPercent > 100) {
    throw new TypeError('Project badge tint must be an integer percentage from 0 to 100.');
  }
  if (hasBadgeContrast(color, color, tintPercent)) return color;

  const channels = colorChannels(color);
  const white = [255, 255, 255];
  for (let percent = 1; percent <= 100; percent += 1) {
    const candidate = channelsToColor(mixChannels(channels, white, percent / 100));
    if (hasBadgeContrast(candidate, color, tintPercent)) return candidate;
  }
  return '#FFFFFF';
}

function getTintPercent(kind, value) {
  if (kind === 'projectType') return STANDARD_TINT_PERCENT;
  if (kind === 'status') return STATUS_TINT_PERCENT_BY_VALUE[value] || STANDARD_TINT_PERCENT;
  throw new TypeError('Project option presentation kind must be status or projectType.');
}

function toBadgeOption(entry, kind) {
  if (!entry || typeof entry.value !== 'string' || typeof entry.label !== 'string'
    || typeof entry.color !== 'string' || !COLOR_PATTERN.test(entry.color)) {
    throw new TypeError('Project option presentation received invalid catalogue metadata.');
  }
  const tintPercent = getTintPercent(kind, entry.value);
  return {
    ...entry,
    value: entry.value,
    label: entry.label,
    color: entry.color,
    tintPercent,
    foregroundColor: getProjectBadgeForeground(entry.color, tintPercent),
  };
}

export function presentProjectOptionCatalogue(entries, kind) {
  return requireCatalogue(entries, 'option').map(entry => toBadgeOption(entry, kind));
}

export function buildProjectOptionPresentation({ status, projectType }) {
  const statusOptions = presentProjectOptionCatalogue(requireCatalogue(status, 'Status'), 'status');
  const projectTypeOptions = presentProjectOptionCatalogue(
    requireCatalogue(projectType, 'Type'),
    'projectType',
  );
  return {
    statusByValue: new Map(statusOptions.map((entry) => [entry.value, entry])),
    projectTypeByValue: new Map(projectTypeOptions.map((entry) => [entry.value, entry])),
  };
}

export function presentProjectOptions(project, presentation) {
  return {
    ...project,
    isArchived: isProjectArchived(project),
    projectStatusOption: presentation.statusByValue.get(project.status) || null,
    projectTypeOption: presentation.projectTypeByValue.get(project.project_type) || null,
  };
}

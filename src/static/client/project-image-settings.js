import { isEnhancementBound, markEnhancementBound } from './dom.js';

export function enhanceProjectImageSettings(scope = globalThis.document) {
  let bound = 0;
  scope?.querySelectorAll?.('[data-project-image-settings-group]').forEach((group) => {
    const format = group.querySelector('[data-project-image-format]');
    if (!format || isEnhancementBound(format, 'projectImageSettingsBound')) return;

    const sync = () => {
      group.querySelectorAll('[data-project-image-dependent]').forEach((field) => {
        const condition = field.getAttribute('data-project-image-dependent');
        const visible = condition === 'webp'
          ? format.value === 'webp'
          : format.value !== 'original';
        field.hidden = !visible;
        field.querySelectorAll('input').forEach((input) => { input.disabled = !visible; });
      });
      const row = group.querySelector('[data-project-image-fields-row]');
      if (row) row.hidden = format.value === 'original';
      const layout = group.querySelector('[data-project-image-layout]');
      layout?.setAttribute('data-project-image-layout', format.value);
    };

    sync();
    format.addEventListener('change', sync);
    markEnhancementBound(format, 'projectImageSettingsBound');
    bound += 1;
  });
  return bound;
}

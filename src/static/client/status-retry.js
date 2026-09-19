export function removeStatusRetry(state, key = 'refreshRetryButton') {
  state?.[key]?.remove?.();
  if (state) state[key] = null;
}

export function showStatusRetry({
  state,
  status,
  mount = status,
  attribute,
  describedBy = '',
  onRetry,
  key = 'refreshRetryButton',
  label = 'Retry refresh',
}) {
  removeStatusRetry(state, key);
  const button = status?.ownerDocument?.createElement?.('button')
    || state?.form?.ownerDocument?.createElement?.('button');
  if (!button || !status || !mount) return null;
  button.type = 'button';
  button.className = 'button button-secondary';
  button.setAttribute?.(attribute, '');
  if (describedBy) button.setAttribute?.('aria-describedby', describedBy);
  button.textContent = label;
  button.addEventListener?.('click', () => {
    const wasFocused = button.ownerDocument?.activeElement === button;
    removeStatusRetry(state, key);
    void onRetry({ wasFocused });
  });
  mount.appendChild?.(button);
  state[key] = button;
  return button;
}

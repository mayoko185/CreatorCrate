// Shared fetch → Blob → browser download step for same-origin attachment
// responses (Books export, Logs export). Callers own request, validation and
// status; this only names and saves an already-accepted response body.

export function filenameFromResponse(response, fallback) {
  const disposition = response?.headers?.get?.('content-disposition') || '';
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8) {
    try { return decodeURIComponent(utf8[1]); } catch { /* use the plain filename below */ }
  }
  const plain = disposition.match(/filename="?([^";]+)"?/i);
  return plain?.[1] || fallback;
}

export function downloadBlob(windowObject, documentObject, blob, filename) {
  const urlApi = windowObject.URL;
  if (!urlApi?.createObjectURL) throw new Error('Downloads are unavailable.');
  const url = urlApi.createObjectURL(blob);
  const link = documentObject.createElement('a');
  link.href = url;
  link.download = filename;
  link.hidden = true;
  documentObject.body?.append?.(link);
  link.click?.();
  link.remove?.();
  windowObject.setTimeout?.(() => urlApi.revokeObjectURL?.(url), 0);
}

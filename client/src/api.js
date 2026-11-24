const apiBaseUrl = (import.meta.env.VITE_API_URL || '').trim().replace(/\/+$/, '').replace(/\/api$/i, '');

function apiError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function connectionMessage() {
  return apiBaseUrl
    ? 'StayFlow could not reach its API server. Check that the backend is running and VITE_API_URL is set to its address.'
    : 'The StayFlow API is not connected to this deployment. Deploy the server and set VITE_API_URL in Vercel, then redeploy the web app.';
}

export async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`${apiBaseUrl}/api${path}`, {
      ...options,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
  } catch {
    throw apiError(connectionMessage());
  }

  if (response.status === 204) return null;

  const contentType = response.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const result = isJson ? await response.json().catch(() => ({})) : null;

  if (!response.ok) {
    if (typeof result?.error === 'string' && result.error.trim()) {
      throw apiError(result.error.slice(0, 400), response.status);
    }
    if (response.status === 404 || !isJson) throw apiError(connectionMessage(), response.status);
    if (response.status >= 500) throw apiError('StayFlow is temporarily unavailable. Please try again in a few minutes.', response.status);
    throw apiError('StayFlow could not complete that request. Check the details and try again.', response.status);
  }

  if (!isJson) throw apiError(connectionMessage(), response.status);
  return result;
}

export const apiBaseUrlForSocket = apiBaseUrl || undefined;

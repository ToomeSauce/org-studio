/**
 * Payload validation for the `updateTask` action of POST /api/store.
 *
 * #1195: previously the handler treated missing/typoed/empty `updates`
 * as a no-op and returned `{ ok: true }`, masking real bugs (a closed
 * task got re-dispatched 12 minutes later because the status update
 * was silently dropped). This helper makes those cases loud (HTTP 400
 * with a developer-friendly hint).
 *
 * Returns `null` when the payload is valid; otherwise an object with
 * the response body and HTTP status code to return.
 */
export type UpdateTaskValidationError = {
  status: number;
  body: { error: string };
};

export function validateUpdateTaskPayload(
  payload: any
): UpdateTaskValidationError | null {
  if (!payload || typeof payload !== 'object') {
    return {
      status: 400,
      body: { error: 'updateTask requires a JSON object payload' },
    };
  }

  if (!payload.id || typeof payload.id !== 'string') {
    return {
      status: 400,
      body: { error: 'updateTask requires `id` (string)' },
    };
  }

  if (payload.updates === undefined || payload.updates === null) {
    // Common typo: `patch` / `changes` / `fields` instead of `updates`.
    if ('patch' in payload || 'changes' in payload || 'fields' in payload) {
      return {
        status: 400,
        body: {
          error:
            'updateTask: did you mean `updates`? Got `patch`/`changes`/`fields`. Field must be named `updates`.',
        },
      };
    }
    return {
      status: 400,
      body: { error: 'updateTask requires `updates` (object)' },
    };
  }

  if (typeof payload.updates !== 'object' || Array.isArray(payload.updates)) {
    return {
      status: 400,
      body: { error: 'updateTask `updates` must be an object' },
    };
  }

  if (Object.keys(payload.updates).length === 0) {
    return {
      status: 400,
      body: { error: 'updateTask `updates` is empty — no fields to update' },
    };
  }

  return null;
}

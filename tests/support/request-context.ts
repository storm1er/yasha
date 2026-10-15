// Request-context seam for the next/headers shim: tests set the headers of the
// request they are about to dispatch, route handlers read them via headers().

let current: Headers | null = null;

export function setCurrentHeaders(headers: Headers | null): void {
  current = headers;
}

export function getCurrentHeaders(): Headers {
  if (!current) throw new Error("no request headers bound — dispatch the route via callRoute()");
  return current;
}

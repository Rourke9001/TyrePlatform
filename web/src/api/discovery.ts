import { deadline } from "./deadline";

// The sign-in library's request timeout ends at the response headers
// (docs/lessons.md, 2026-10-02), so discovery is fetched here, under one
// deadline that bounds the body too. A bad status, or a body that is not
// JSON, is a plain Error, which the outbox and the queries read as no
// signal (TYRE-471 spec, Discovery).
export async function fetchDiscovery(url: string): Promise<unknown> {
  const bound = deadline("sign-in discovery");
  try {
    const res = await bound.within(
      fetch(url, { headers: { Accept: "application/json" }, signal: bound.signal }),
    );
    if (!res.ok) throw new Error(`sign-in discovery failed: ${res.status}`);
    const body: unknown = await bound.within(res.json());
    return body;
  } finally {
    bound.end();
  }
}
